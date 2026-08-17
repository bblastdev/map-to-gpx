/**
 * Shared logic for the short-link resolver / geocoding proxy.
 *
 * Both netlify/functions/resolve.js and api/resolve.js are thin adapters over
 * `handleResolve` so the two deploy targets cannot drift apart.
 *
 * Two jobs, neither of which a static page can do for itself:
 *   ?url=<maps.app.goo.gl/…>  → expand the short link (blocked by CORS in a browser)
 *   ?q=<place name>           → geocode via Nominatim with a real User-Agent
 *                               (browsers forbid setting that header on fetch)
 */

export class HttpError extends Error {
  constructor(status, message, fix) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.fix = fix;
  }
}

/** Only these hosts may be handed to us as a short link. */
const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'g.co', 'maps.google.com']);

/** Redirects may only stay inside Google — this must never become an open proxy. */
function isGoogleHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'goo.gl' || h === 'g.co' ||
         /(^|\.)google\.[a-z]{2,}(\.[a-z]{2})?$/.test(h) ||
         /(^|\.)goo\.gl$/.test(h);
}

function isMapsUrl(url) {
  return isGoogleHost(url.hostname) &&
         (url.pathname.includes('/maps') || url.searchParams.has('daddr') || url.searchParams.has('destination'));
}

const MAX_HOPS = 6;
const FETCH_TIMEOUT_MS = 12000;

/**
 * Identify ourselves to OpenStreetMap. Their usage policy requires a genuine
 * contact address — set NOMINATIM_UA in your deploy's environment variables.
 */
function userAgent(env) {
  return (env && env.NOMINATIM_UA) ||
    'MapToGPX/1.0 (Google Maps directions to GPX converter; set NOMINATIM_UA to your contact address)';
}

async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new HttpError(504, 'Upstream request timed out.');
    }
    throw new HttpError(502, `Could not reach the upstream service: ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a full Maps URL out of an interstitial page body. */
export function scrapeMapsUrl(html) {
  const candidates = [];

  const meta = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"';]+)/i.exec(html);
  if (meta) candidates.push(meta[1]);

  const canonical = /<link[^>]+rel=["']?canonical["']?[^>]+href=["']([^"']+)["']/i.exec(html);
  if (canonical) candidates.push(canonical[1]);

  const inline = /https:\/\/(?:www\.)?google\.[a-z.]{2,7}\/maps\/[^"'\\\s<>]+/i.exec(html);
  if (inline) candidates.push(inline[0]);

  for (const raw of candidates) {
    const cleaned = raw
      .replace(/&amp;/g, '&')
      .replace(/\\u003d/gi, '=')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/');
    try {
      const url = new URL(cleaned);
      if (isMapsUrl(url)) return url.href;
    } catch { /* not a usable URL — try the next candidate */ }
  }
  return null;
}

/**
 * Follow a Google short link to the full directions URL.
 * Redirect targets are checked at every hop so this cannot be used to fetch
 * arbitrary hosts.
 */
export async function expandShortLink(input, env) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new HttpError(400, 'That is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpError(400, 'Only http(s) links can be expanded.');
  }
  if (!SHORT_HOSTS.has(url.hostname.toLowerCase())) {
    throw new HttpError(400,
      `This endpoint only expands Google short links, not “${url.hostname}”.`,
      'Allowed hosts: ' + [...SHORT_HOSTS].join(', '));
  }

  const headers = {
    'User-Agent': userAgent(env),
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en'
  };

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await fetchWithTimeout(url, { redirect: 'manual', headers });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new HttpError(502, 'Google sent a redirect with no destination.');
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw new HttpError(502, 'Google sent a redirect we could not read.');
      }
      if (!isGoogleHost(next.hostname)) {
        throw new HttpError(502, `The short link points off Google, to “${next.hostname}” — not following it.`);
      }
      /* The moment we can see the real Maps URL we are done; no need to
         download the (very large) Maps page itself. */
      if (isMapsUrl(next)) return next.href;
      url = next;
      continue;
    }

    if (res.status === 404 || res.status === 410) {
      throw new HttpError(404,
        'That short link does not exist any more.',
        'Google short links expire. Open the route in Google Maps and share a fresh link.');
    }
    if (!res.ok) {
      throw new HttpError(502, `Google returned HTTP ${res.status} for that short link.`);
    }

    /* 200 OK — either we are already on Maps, or this is an interstitial page. */
    if (isMapsUrl(url)) return url.href;

    const html = await res.text();
    const scraped = scrapeMapsUrl(html);
    if (scraped) return scraped;

    throw new HttpError(502,
      'The short link opened a page with no Google Maps URL in it.',
      'Open the short link in your browser and copy the expanded URL from the address bar instead.');
  }

  throw new HttpError(502, 'The short link redirected too many times.');
}

/* ── Nominatim proxy ──────────────────────────────────────────────────── */

/**
 * Nominatim allows at most one request per second. Serverless instances are
 * reused between warm invocations, so this gate does real work — but it is not
 * a cluster-wide limit. Self-host Nominatim if you expect serious traffic.
 */
let nominatimGate = Promise.resolve();
let lastNominatimCall = 0;

function throttleNominatim() {
  const run = nominatimGate.then(async () => {
    const wait = 1100 - (Date.now() - lastNominatimCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimCall = Date.now();
  });
  nominatimGate = run.catch(() => {});
  return run;
}

export async function geocode(query, env, limit = 1) {
  const q = String(query || '').trim();
  if (!q) throw new HttpError(400, 'Missing search text.');
  if (q.length > 300) throw new HttpError(400, 'That search string is unreasonably long.');

  await throttleNominatim();

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(Math.min(5, Math.max(1, limit))));
  url.searchParams.set('addressdetails', '0');
  url.searchParams.set('q', q);

  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': userAgent(env), 'Accept': 'application/json' }
  });
  if (res.status === 429) {
    throw new HttpError(429, 'OpenStreetMap is rate-limiting this deployment.', 'Wait a moment and try again.');
  }
  if (!res.ok) throw new HttpError(502, `Nominatim returned HTTP ${res.status}.`);

  const data = await res.json();
  if (!Array.isArray(data)) throw new HttpError(502, 'Nominatim returned an unexpected response.');

  return data.map((r) => ({
    lat: r.lat,
    lon: r.lon,
    display_name: r.display_name,
    type: r.type
  }));
}

/**
 * Reverse geocode a coordinate to the nearest mapped feature. Used to pull an
 * automatically chosen split point onto a real road — a raw point on the line
 * between two towns often sits in a field, too far from anything routable.
 */
export async function reverseGeocode(lat, lon, env) {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || la < -90 || la > 90) throw new HttpError(400, 'Bad latitude.');
  if (!Number.isFinite(lo) || lo < -180 || lo > 180) throw new HttpError(400, 'Bad longitude.');

  await throttleNominatim();

  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(la));
  url.searchParams.set('lon', String(lo));
  url.searchParams.set('zoom', '17');          // street level
  url.searchParams.set('addressdetails', '0');

  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': userAgent(env), 'Accept': 'application/json' }
  });
  if (res.status === 429) throw new HttpError(429, 'OpenStreetMap is rate-limiting this deployment.');
  if (!res.ok) throw new HttpError(502, `Nominatim returned HTTP ${res.status}.`);

  const r = await res.json();
  if (!r || r.error || r.lat == null) return null;
  return { lat: r.lat, lon: r.lon, display_name: r.display_name, type: r.type };
}

/* ── request handling, shared by both platform adapters ───────────────── */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

/**
 * @param {URLSearchParams} params
 * @param {object} env
 * @returns {Promise<{status: number, body: object, cacheSeconds: number}>}
 */
export async function handleResolve(params, env) {
  const shortUrl = params.get('url');
  const query = params.get('q');

  try {
    if (shortUrl) {
      const expanded = await expandShortLink(shortUrl, env);
      /* an expanded short link never changes — cache it hard */
      return { status: 200, body: { url: expanded }, cacheSeconds: 86400 };
    }
    if (query) {
      const results = await geocode(query, env, Number(params.get('limit')) || 1);
      return { status: 200, body: { results }, cacheSeconds: 3600 };
    }
    if (params.get('lat') != null && params.get('lon') != null) {
      const result = await reverseGeocode(params.get('lat'), params.get('lon'), env);
      return { status: 200, body: { result }, cacheSeconds: 3600 };
    }
    return {
      status: 400,
      body: {
        error: 'Pass ?url=<google short link> to expand a link, ?q=<place> to geocode, ' +
               'or ?lat=&lon= to reverse geocode.',
        service: 'map-to-gpx resolver'
      },
      cacheSeconds: 0
    };
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, body: { error: err.message, fix: err.fix }, cacheSeconds: 0 };
    }
    return { status: 500, body: { error: 'Unexpected server error.' }, cacheSeconds: 0 };
  }
}

export function cacheHeader(seconds) {
  return seconds > 0
    ? `public, max-age=${seconds}, s-maxage=${seconds}`
    : 'no-store';
}
