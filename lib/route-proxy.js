/**
 * Server-side OpenRouteService proxy.
 *
 * Lets visitors route without their own key by spending the deployment's key
 * instead. That is only safe with guards, so this module refuses anything it
 * cannot vouch for:
 *
 *   • same-origin only — the browser's Origin header must match the deployment
 *   • profile allowlist — no arbitrary ORS endpoint
 *   • shape limits — coordinate count and body size
 *   • rate limits — per-IP and a global daily ceiling, so one scraper cannot
 *     burn the whole 2 000/day
 *
 * Counters live in Supabase when configured; without it the limiter falls back
 * to per-instance memory, which is weak across serverless instances but still
 * better than nothing. It says so in the response headers either way.
 */

const ORS_HOSTS = [
  'https://api.heigit.org/openrouteservice/v2/directions',
  'https://api.openrouteservice.org/v2/directions'
];

const PROFILES = new Set([
  'cycling-road', 'cycling-regular', 'cycling-mountain', 'cycling-electric',
  'foot-walking', 'foot-hiking',
  /* the app asks for a driving route purely to find the road corridor when a
     foot/bike route is too long for one request */
  'driving-car'
]);

const MAX_COORDINATES = 25;
const MAX_BODY_BYTES = 32 * 1024;
const FETCH_TIMEOUT_MS = 40000;

const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);

export function limits(env) {
  return {
    perIp: num(env.RATE_PER_IP, 20),          // routes per IP per window
    perIpWindow: num(env.RATE_IP_WINDOW, 3600),
    perDay: num(env.RATE_PER_DAY, 1200)       // global ceiling, under ORS's 2 000
  };
}

/* ── origin ───────────────────────────────────────────────────────────── */

/**
 * Only this deployment's own pages may spend the key. Browsers always attach
 * Origin to a cross-origin POST — and to same-origin POSTs too — so a missing
 * Origin means the call did not come from a page we serve.
 */
export function originAllowed(origin, host, env) {
  if (!origin) return false;
  const allowed = new Set();
  if (host) { allowed.add('https://' + host); allowed.add('http://' + host); }
  for (const o of String(env.ALLOWED_ORIGINS || '').split(',')) {
    const t = o.trim();
    if (t) allowed.add(t.replace(/\/$/, ''));
  }
  return allowed.has(String(origin).replace(/\/$/, ''));
}

export function clientIp(headers) {
  const fwd = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '';
  const first = String(fwd).split(',')[0].trim();
  return first || headers['x-real-ip'] || 'unknown';
}

/* ── rate limiting ────────────────────────────────────────────────────── */

const memory = new Map();

function bumpMemory(bucket, ttlSeconds) {
  const now = Date.now();
  for (const [k, v] of memory) if (v.expires < now) memory.delete(k);
  const cur = memory.get(bucket);
  if (cur && cur.expires >= now) { cur.count += 1; return cur.count; }
  memory.set(bucket, { count: 1, expires: now + ttlSeconds * 1000 });
  return 1;
}

/**
 * Increment a counter and return its new value. Supabase does it atomically
 * through the bump_counter function in supabase/schema.sql; a race between two
 * instances would otherwise let the limit drift upward.
 */
async function bump(bucket, ttlSeconds, env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) return { count: bumpMemory(bucket, ttlSeconds), backend: 'memory' };

  /* Tolerate a URL pasted with a trailing slash, or with /rest/v1 already on
     it — both are easy to copy out of the dashboard by mistake. */
  const base = String(env.SUPABASE_URL).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');

  /* Two key formats are in circulation. The legacy service_role key is a JWT
     and PostgREST reads the role out of Authorization; the newer sb_secret_*
     keys are resolved by the gateway from apikey, and putting one in
     Authorization makes PostgREST try to parse it as a JWT and reject it. */
  const legacyJwt = /^ey[A-Za-z0-9_-]+\./.test(key);
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (legacyJwt) headers.Authorization = 'Bearer ' + key;

  try {
    const res = await fetch(base + '/rest/v1/rpc/bump_counter', {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_bucket: bucket, p_ttl_seconds: ttlSeconds }),
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) throw new Error('rpc ' + res.status + ' ' + (await res.text()).slice(0, 80));
    const data = await res.json();
    const count = Array.isArray(data) ? data[0]?.count : data?.count;
    if (!Number.isFinite(count)) throw new Error('rpc returned ' + JSON.stringify(data).slice(0, 60));
    return { count, backend: 'supabase' };
  } catch (err) {
    /* Never fail a route because the counter store is down — fall back to the
       in-memory limiter, which is stricter per instance, not looser. The note
       rides out on a header so this is diagnosable without shell access. */
    return {
      count: bumpMemory(bucket, ttlSeconds),
      backend: 'memory-fallback',
      note: String((err && err.message) || err).slice(0, 90)
    };
  }
}

const dayStamp = (now) => new Date(now).toISOString().slice(0, 10);

/* ── the handler ──────────────────────────────────────────────────────── */

/**
 * @returns {{status:number, body:object, headers:object}}
 */
export async function handleRoute({ method, origin, host, headers, rawBody }, env, now = Date.now()) {
  const L = limits(env);
  const out = (status, body, extra) => ({ status, body, headers: Object.assign({}, extra) });

  if (method === 'OPTIONS') return out(204, null);
  if (method !== 'POST') return out(405, { error: 'Use POST.' });

  /* Origin first, deliberately: a caller we do not serve should learn nothing
     about how this deployment is configured, not even whether a key is set. */
  if (!originAllowed(origin, host, env)) {
    return out(403, {
      error: 'This routing endpoint only answers pages served from this site.',
      fix: 'Paste your own OpenRouteService key in Settings to route from elsewhere.'
    });
  }
  if (!env.ORS_KEY) {
    return out(503, {
      error: 'This deployment has no shared routing key configured.',
      fix: 'Set ORS_KEY in the hosting environment, or paste your own key in Settings.'
    });
  }
  if (typeof rawBody !== 'string' || rawBody.length > MAX_BODY_BYTES) {
    return out(413, { error: 'Request body is too large.' });
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return out(400, { error: 'Body must be JSON.' }); }

  const profile = String(payload.profile || '');
  if (!PROFILES.has(profile)) {
    return out(400, { error: `Unsupported routing profile “${profile}”.` });
  }
  const coords = payload.coordinates;
  if (!Array.isArray(coords) || coords.length < 2 || coords.length > MAX_COORDINATES) {
    return out(400, { error: `coordinates must be an array of 2–${MAX_COORDINATES} points.` });
  }
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2 ||
        !Number.isFinite(c[0]) || c[0] < -180 || c[0] > 180 ||
        !Number.isFinite(c[1]) || c[1] < -90 || c[1] > 90) {
      return out(400, { error: 'Every coordinate must be [lon, lat] within range.' });
    }
  }

  /* global ceiling first: it is the one that protects the quota */
  const day = await bump('day:' + dayStamp(now), 86400, env);
  if (day.count > L.perDay) {
    return out(429, {
      error: 'The shared routing key has hit its daily limit for this site.',
      fix: 'Paste your own free OpenRouteService key in Settings to keep going — it takes a minute at openrouteservice.org.'
    }, { 'X-RateLimit-Scope': 'global', 'X-RateLimit-Backend': day.backend });
  }

  const ip = clientIp(headers);
  const perIp = await bump(`ip:${ip}:${Math.floor(now / (L.perIpWindow * 1000))}`, L.perIpWindow, env);
  if (perIp.count > L.perIp) {
    return out(429, {
      error: `Too many routes from this connection — the shared key allows ${L.perIp} per hour.`,
      fix: 'Wait a little, or paste your own free OpenRouteService key in Settings to lift the limit.'
    }, { 'X-RateLimit-Scope': 'ip', 'X-RateLimit-Backend': perIp.backend });
  }

  /* forward only the fields the app is allowed to set */
  const body = JSON.stringify({
    coordinates: coords,
    elevation: payload.elevation !== false,
    instructions: false,
    units: 'm',
    ...(payload.alternative_routes && coords.length === 2
      ? { alternative_routes: {
            target_count: Math.min(3, num(payload.alternative_routes.target_count, 3)),
            weight_factor: 1.6, share_factor: 0.6 } }
      : {})
  });

  const rateHeaders = {
    'X-RateLimit-Backend': day.backend,
    ...(day.note || perIp.note ? { 'X-RateLimit-Note': day.note || perIp.note } : {}),
    'X-RateLimit-Day-Remaining': String(Math.max(0, L.perDay - day.count)),
    'X-RateLimit-Ip-Remaining': String(Math.max(0, L.perIp - perIp.count))
  };

  let lastNetworkError = null;
  for (const base of ORS_HOSTS) {
    let res, text;
    try {
      res = await fetch(`${base}/${profile}/geojson`, {
        method: 'POST',
        headers: {
          Authorization: env.ORS_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/geo+json, application/json'
        },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      text = await res.text();
    } catch (err) {
      lastNetworkError = err;
      continue;
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON upstream */ }
    /* Pass ORS's own errors straight through: the client already turns codes
       2004/2009/2010 into specific, actionable messages. */
    return out(res.status, json || { error: text.slice(0, 300) || 'Upstream error.' }, rateHeaders);
  }

  return out(502, {
    error: 'Could not reach OpenRouteService.',
    fix: lastNetworkError && lastNetworkError.name === 'TimeoutError'
      ? 'The request timed out — long routes can take a while. Try again.'
      : 'Try again shortly, or paste your own key in Settings.'
  }, rateHeaders);
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
