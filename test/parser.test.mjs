/**
 * Tests for Map to GPX.
 *
 * The core logic lives inside index.html in <script id="mtg-core">. Rather than
 * keeping a second copy here (which would quietly drift), this file extracts
 * that script and runs it — so the tests exercise the code that actually ships.
 *
 *   node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

/* ── load the core out of index.html ──────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const coreMatch = /<script id="mtg-core">([\s\S]*?)<\/script>/.exec(html);
assert.ok(coreMatch, 'index.html must contain <script id="mtg-core">');
vm.runInThisContext(coreMatch[1], { filename: 'index.html#mtg-core' });

const C = globalThis.MapToGPX;
assert.ok(C, 'the core script must define globalThis.MapToGPX');

/* ── the shipped page's own integrity ─────────────────────────────────── */

test('every icon reference resolves to a sprite symbol', () => {
  const symbols = new Set([...html.matchAll(/<symbol id="([a-z0-9-]+)"/g)].map((m) => m[1]));
  assert.ok(symbols.size > 20, `expected an icon sprite, found ${symbols.size} symbols`);

  /* markup: <use href="#id"> */
  const markupRefs = [...html.matchAll(/href="#([a-z0-9-]+)"/g)].map((m) => m[1]);
  /* script: any 'b-…' / 'f-…' literal — icon() calls, setIcon(), and the
     PROFILES / STEPS / ICON tables alike. Matching the naming convention
     rather than the call shape is what keeps this from going stale. */
  const scriptRefs = [...html.matchAll(/'((?:b|f)-[a-z0-9-]+)'/g)].map((m) => m[1]);

  const referenced = new Set([...markupRefs, ...scriptRefs]);
  for (const ref of referenced) {
    assert.ok(symbols.has(ref), `icon "#${ref}" is referenced but has no <symbol> in the sprite`);
  }

  /* And the other direction: the sprite is inlined into every page load, so a
     glyph a redesign stopped using is dead weight nobody would otherwise
     notice. */
  for (const sym of symbols) {
    assert.ok(referenced.has(sym), `sprite symbol "#${sym}" is not referenced anywhere — drop it`);
  }
});

test('no element id is declared twice, and every $(id) exists', () => {
  const markup = html.slice(0, html.indexOf('<script id="mtg-core">'));
  const declared = [...markup.matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1]);
  const dupes = declared.filter((v, i) => declared.indexOf(v) !== i);
  assert.deepEqual([...new Set(dupes)], [], 'duplicate element ids in the markup');

  const known = new Set(declared);
  const touched = new Set([...html.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
  for (const id of touched) {
    assert.ok(known.has(id), `the script reads $('${id}') but no element declares that id`);
  }
});

/* ── an XML checker written independently of the one under test ───────── */

/**
 * Minimal XML 1.0 well-formedness scanner: balanced tags, one root, quoted
 * attributes, no duplicate attributes, no raw `<`, no bare `&`.
 * Throws on the first problem it finds; returns the root element name.
 */
function assertWellFormedXml(xml) {
  const n = xml.length;
  const stack = [];
  let i = 0, root = null, rootClosed = false;

  const bad = (msg, at) => { throw new Error(`XML not well-formed: ${msg} (at ${at})`); };
  const checkEntities = (text, at) => {
    const re = /&([^;\s<&]*);?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = text.slice(m.index, m.index + m[0].length);
      if (!/^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/.test(raw)) bad(`bare or unknown entity "${raw}"`, at + m.index);
    }
  };

  if (xml.startsWith('<?xml')) {
    const end = xml.indexOf('?>');
    if (end === -1) bad('unterminated XML declaration', 0);
    if (!/^<\?xml\s+version="1\.0"(\s+encoding="[^"]+")?(\s+standalone="(yes|no)")?\s*$/
          .test(xml.slice(0, end))) bad('malformed XML declaration', 0);
    i = end + 2;
  }

  while (i < n) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt === -1 ? n : lt);
    if (stack.length === 0 && text.trim()) bad('text outside the root element', i);
    checkEntities(text, i);
    if (lt === -1) break;

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) bad('unterminated comment', lt);
      i = end + 3; continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) bad('unterminated processing instruction', lt);
      i = end + 2; continue;
    }
    if (xml.startsWith('</', lt)) {
      const gt = xml.indexOf('>', lt);
      if (gt === -1) bad('unterminated closing tag', lt);
      const name = xml.slice(lt + 2, gt).trim();
      if (!stack.length) bad(`closing </${name}> with nothing open`, lt);
      const open = stack.pop();
      if (open !== name) bad(`</${name}> closes <${open}>`, lt);
      if (!stack.length) rootClosed = true;
      i = gt + 1; continue;
    }

    /* opening tag — walk it manually so quoted `>` cannot fool us */
    let j = lt + 1;
    const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(xml.slice(j));
    if (!nameMatch) bad('invalid element name', lt);
    const name = nameMatch[0];
    j += name.length;
    if (rootClosed) bad(`second root element <${name}>`, lt);

    const seen = new Set();
    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(xml[j])) j++;
      if (xml[j] === '>') { j++; break; }
      if (xml[j] === '/' && xml[j + 1] === '>') { selfClosing = true; j += 2; break; }
      const attr = /^([A-Za-z_][\w.:-]*)\s*=\s*(["'])/.exec(xml.slice(j));
      if (!attr) bad(`unquoted or malformed attribute in <${name}>`, j);
      if (seen.has(attr[1])) bad(`duplicate attribute ${attr[1]} on <${name}>`, j);
      seen.add(attr[1]);
      const quote = attr[2];
      const valueStart = j + attr[0].length;
      const valueEnd = xml.indexOf(quote, valueStart);
      if (valueEnd === -1) bad(`unterminated attribute value for ${attr[1]}`, j);
      const value = xml.slice(valueStart, valueEnd);
      if (value.includes('<')) bad(`raw "<" inside attribute ${attr[1]}`, valueStart);
      checkEntities(value, valueStart);
      j = valueEnd + 1;
    }

    if (!stack.length && !root) root = name;
    else if (!stack.length) bad(`second root element <${name}>`, lt);
    if (!selfClosing) stack.push(name);
    else if (!stack.length) rootClosed = true;
    i = j;
  }

  if (stack.length) bad(`unclosed <${stack[stack.length - 1]}>`, n);
  if (!root) bad('no root element', 0);
  return root;
}

/* Sanity-check the checker itself, so a broken checker cannot pass bad GPX. */
test('the test harness XML checker rejects malformed documents', () => {
  assert.equal(assertWellFormedXml('<?xml version="1.0" encoding="UTF-8"?><a><b/></a>'), 'a');
  assert.throws(() => assertWellFormedXml('<a><b></a>'), /well-formed/);
  assert.throws(() => assertWellFormedXml('<a x=1></a>'), /well-formed/);
  assert.throws(() => assertWellFormedXml('<a>Ben & Jerry</a>'), /well-formed/);
  assert.throws(() => assertWellFormedXml('<a></a><b></b>'), /well-formed/);
  assert.throws(() => assertWellFormedXml('<a x="1" x="2"/>'), /well-formed/);
});

/* ── real-world URL fixtures ──────────────────────────────────────────── */

const URLS = {
  /* place names in the path, exact coordinates in the data blob, bicycling */
  jakartaNamed:
    'https://www.google.com/maps/dir/Gelora+Bung+Karno,+Senayan,+Jakarta/Taman+Impian+Jaya+Ancol,+Jakarta/' +
    '@-6.1962,106.8207,12z/data=!4m14!4m13!1m5!1m1!1s0x2e69f15f0a0a0a0a:0xaaa!2m2!1d106.8023!2d-6.2185' +
    '!1m5!1m1!1s0x2e69f5b1b1b1b1b1:0xbbb!2m2!1d106.8412!2d-6.1256!3e1?entry=ttu',

  /* bare coordinates, no waypoints, no data blob */
  coordsOnly:
    'https://www.google.com/maps/dir/-6.2088,106.8456/-6.1751,106.8650/',

  /* three stops, walking */
  threeStops:
    'https://www.google.com/maps/dir/Monas,+Jakarta/Kota+Tua,+Jakarta/Sunda+Kelapa,+Jakarta/' +
    '@-6.15,106.82,13z/data=!4m20!4m19!1m5!1m1!1s0x1:0x1!2m2!1d106.8272!2d-6.1754' +
    '!1m5!1m1!1s0x2:0x2!2m2!1d106.8133!2d-6.1352!1m5!1m1!1s0x3:0x3!2m2!1d106.8085!2d-6.1264!3e2',

  /* percent-encoded, non-ASCII, and `+` for spaces */
  nonAscii:
    'https://www.google.com/maps/dir/Jalan+Jenderal+Sudirman,+Jakarta/' +
    'Caf%C3%A9+Batavia,+Jakarta+Barat/' +
    'Gr%C3%BCnwalder+Stra%C3%9Fe,+M%C3%BCnchen/',

  /* Maps URLs API */
  api1:
    'https://www.google.com/maps/dir/?api=1&origin=Senayan%2C%20Jakarta&destination=Ancol%2C%20Jakarta' +
    '&waypoints=Semanggi%2C%20Jakarta%7CBundaran%20HI%2C%20Jakarta&travelmode=bicycling',

  /* the pre-2013 form that still shows up in old bookmarks and emails */
  legacy:
    'https://maps.google.com/maps?saddr=Senayan,+Jakarta&daddr=Semanggi,+Jakarta+to:Ancol,+Jakarta&dirflg=b',

  short: 'https://maps.app.goo.gl/aBcDeFgH1JkLmNoP9',

  /* origin left as “Your location” — the URL genuinely has no coordinates */
  yourLocation:
    'https://www.google.com/maps/dir//Ancol,+Jakarta/@-6.12,106.83,14z/data=!4m6!4m5!1m0!1m3!2m2!1d106.8412!2d-6.1256'
};

/* ── URL parsing ──────────────────────────────────────────────────────── */

test('parses place names and prefers the data blob coordinates over them', () => {
  const r = C.parseGoogleMapsUrl(URLS.jakartaNamed);
  assert.equal(r.waypoints.length, 2);

  assert.equal(r.waypoints[0].label, 'Gelora Bung Karno, Senayan, Jakarta');
  assert.deepEqual([r.waypoints[0].lat, r.waypoints[0].lon], [-6.2185, 106.8023]);
  assert.equal(r.waypoints[0].source, 'blob');

  assert.equal(r.waypoints[1].label, 'Taman Impian Jaya Ancol, Jakarta');
  assert.deepEqual([r.waypoints[1].lat, r.waypoints[1].lon], [-6.1256, 106.8412]);

  /* !1d is longitude and !2d is latitude — getting these the wrong way round
     would put this Jakarta route in the Southern Ocean */
  assert.ok(r.waypoints.every((w) => w.lat < 0 && w.lon > 100));

  assert.equal(r.travelMode, 'bicycling');
  assert.equal(C.suggestProfile(r.travelMode), 'cycling-regular');
  assert.deepEqual(r.viewport, { lat: -6.1962, lon: 106.8207, zoom: 12 });
  assert.deepEqual(r.notes, []);
});

test('parses origin + destination with no intermediate waypoints', () => {
  const r = C.parseGoogleMapsUrl(URLS.coordsOnly);
  assert.equal(r.waypoints.length, 2);
  assert.deepEqual(
    r.waypoints.map((w) => [w.lat, w.lon]),
    [[-6.2088, 106.8456], [-6.1751, 106.865]]
  );
  assert.ok(r.waypoints.every((w) => w.kind === 'coords' && w.source === 'url'));
  assert.equal(r.travelMode, null);
});

test('parses three stops and keeps them in order', () => {
  const r = C.parseGoogleMapsUrl(URLS.threeStops);
  assert.deepEqual(r.waypoints.map((w) => w.label),
    ['Monas, Jakarta', 'Kota Tua, Jakarta', 'Sunda Kelapa, Jakarta']);
  assert.deepEqual(r.waypoints.map((w) => [w.lat, w.lon]),
    [[-6.1754, 106.8272], [-6.1352, 106.8133], [-6.1264, 106.8085]]);
  assert.equal(r.travelMode, 'walking');
  assert.equal(C.suggestProfile(r.travelMode), 'foot-walking');
});

test('URL-decodes non-ASCII place names', () => {
  const r = C.parseGoogleMapsUrl(URLS.nonAscii);
  assert.deepEqual(r.waypoints.map((w) => w.label), [
    'Jalan Jenderal Sudirman, Jakarta',
    'Café Batavia, Jakarta Barat',
    'Grünwalder Straße, München'
  ]);
  assert.ok(r.waypoints.every((w) => w.kind === 'name'));
});

test('parses the api=1 query form including pipe-separated waypoints', () => {
  const r = C.parseGoogleMapsUrl(URLS.api1);
  assert.deepEqual(r.waypoints.map((w) => w.label),
    ['Senayan, Jakarta', 'Semanggi, Jakarta', 'Bundaran HI, Jakarta', 'Ancol, Jakarta']);
  assert.equal(r.travelMode, 'bicycling');
});

test('parses the legacy saddr/daddr form with to: separators', () => {
  const r = C.parseGoogleMapsUrl(URLS.legacy);
  assert.deepEqual(r.waypoints.map((w) => w.label),
    ['Senayan, Jakarta', 'Semanggi, Jakarta', 'Ancol, Jakarta']);
  assert.equal(r.travelMode, 'bicycling');
});

test('flags short links for server-side expansion instead of guessing', () => {
  assert.ok(C.isShortLink(URLS.short));
  assert.throws(() => C.parseGoogleMapsUrl(URLS.short), (err) => {
    assert.equal(err.name, 'ShortLinkError');
    assert.equal(err.url, URLS.short);
    return true;
  });
});

test('accepts links without a scheme and from country domains', () => {
  const r = C.parseGoogleMapsUrl('www.google.co.id/maps/dir/-6.2,106.8/-6.1,106.9/');
  assert.equal(r.waypoints.length, 2);
});

test('rejects unparseable and non-directions input with an explanation', () => {
  const cases = [
    ['', /Paste a Google Maps directions link/],
    ['not a url at all', /does not look like a link/],
    ['https://example.com/maps/dir/A/B', /not a Google Maps address/],
    ['https://www.openstreetmap.org/directions?from=a&to=b', /not a Google Maps address/],
    ['https://www.google.com/maps/place/Monas/@-6.17,106.82,17z/', /not a directions link/],
    ['https://www.google.com/maps/dir/Senayan,+Jakarta/', /Only one place/]
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => C.parseGoogleMapsUrl(input), (err) => {
      assert.equal(err.name, 'ParseError', `for input: ${input}`);
      assert.match(err.message, pattern);
      return true;
    }, `expected ${input} to be rejected`);
  }
});

test('explains that “Your location” routes cannot be converted', () => {
  assert.throws(() => C.parseGoogleMapsUrl(URLS.yourLocation), (err) => {
    assert.match(err.message, /Your location/);
    assert.match(err.fix, /replace/i);
    return true;
  });
});

test('drops duplicate consecutive stops', () => {
  const r = C.parseGoogleMapsUrl(
    'https://www.google.com/maps/dir/Senayan/Senayan/Ancol/');
  assert.deepEqual(r.waypoints.map((w) => w.label), ['Senayan', 'Ancol']);
});

test('ignores a trailing slash but keeps a leading empty segment meaningful', () => {
  const withSlash = C.parseGoogleMapsUrl('https://www.google.com/maps/dir/A/B/');
  assert.equal(withSlash.waypoints.length, 2);
  assert.throws(() => C.parseGoogleMapsUrl('https://www.google.com/maps/dir//B/C/'), /Your location/);
});

test('falls back to geocoding when the blob and the path disagree', () => {
  /* one name, two coordinate groups: alignment is ambiguous, so do not guess */
  const r = C.parseGoogleMapsUrl(
    'https://www.google.com/maps/dir/Senayan/Ancol/Monas/' +
    'data=!4m8!1m5!1m1!1s0x1:0x1!2m2!1d106.8023!2d-6.2185!1m5!1m1!1s0x2:0x2!2m2!1d106.8412!2d-6.1256');
  assert.equal(r.waypoints.length, 3);
  assert.ok(r.waypoints.every((w) => typeof w.lat !== 'number'));
  assert.match(r.notes[0], /2 point\(s\).*3/);
});

test('extracts coordinate pairs from a data blob in order', () => {
  const blob = '!4m14!1m5!1m1!1s0xa:0xb!2m2!1d106.8023!2d-6.2185!1m5!1m1!1s0xc:0xd!2m2!1d106.8412!2d-6.1256!3e1';
  assert.deepEqual(C.parseDataBlobCoords(blob), [
    { lat: -6.2185, lon: 106.8023 },
    { lat: -6.1256, lon: 106.8412 }
  ]);
  assert.deepEqual(C.parseDataBlobCoords(''), []);
  /* out-of-range values are noise, not waypoints */
  assert.deepEqual(C.parseDataBlobCoords('!2m2!1d999!2d999'), []);
});

test('parseLatLng only accepts real coordinate pairs', () => {
  assert.deepEqual(C.parseLatLng('-6.2088,106.8456'), { lat: -6.2088, lon: 106.8456 });
  assert.deepEqual(C.parseLatLng(' 40.7128 , -74.0060 '), { lat: 40.7128, lon: -74.006 });
  assert.equal(C.parseLatLng('Senayan, Jakarta'), null);
  assert.equal(C.parseLatLng('91.0,10.0'), null);
  assert.equal(C.parseLatLng('10.0,181.0'), null);
});

/* ── GPX generation ───────────────────────────────────────────────────── */

const SAMPLE = [
  { lat: -6.2185, lon: 106.8023, ele: 12.4 },
  { lat: -6.2101, lon: 106.8112, ele: 15.9 },
  { lat: -6.2101, lon: 106.8112, ele: 15.9 },   // duplicate — must be dropped
  { lat: -6.1256, lon: 106.8412, ele: 4.1 }
];

test('produces well-formed GPX 1.1 from sample coordinates', () => {
  const gpx = C.buildGpx({
    points: SAMPLE,
    name: 'Senayan → Ancol',
    profile: 'cycling-regular',
    creator: 'Map to GPX',
    time: '2026-08-14T00:00:00.000Z'
  });

  assert.equal(assertWellFormedXml(gpx), 'gpx');
  assert.match(gpx, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);
  assert.match(gpx, /\bversion="1\.1"/);
  assert.match(gpx, /\bcreator="Map to GPX"/);
  assert.match(gpx, /xsi:schemaLocation="http:\/\/www\.topografix\.com\/GPX\/1\/1 [^"]+gpx\.xsd"/);

  assert.equal((gpx.match(/<trk>/g) || []).length, 1);
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 1);

  const pts = [...gpx.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"><ele>([^<]+)<\/ele><\/trkpt>/g)];
  assert.equal(pts.length, 3, 'the duplicate point should have been removed');
  assert.deepEqual(pts.map((m) => [m[1], m[2], m[3]]), [
    ['-6.218500', '106.802300', '12.4'],
    ['-6.210100', '106.811200', '15.9'],
    ['-6.125600', '106.841200', '4.1']
  ]);

  assert.match(gpx, /<name>Senayan → Ancol<\/name>/);
  assert.match(gpx, /<type>cycling<\/type>/);
  assert.match(gpx, /<time>2026-08-14T00:00:00\.000Z<\/time>/);
  assert.match(gpx, /<bounds minlat="-6\.218500" minlon="106\.802300" maxlat="-6\.125600" maxlon="106\.841200"\/>/);

  /* the shipped validator must agree with the independent checker above */
  const check = C.validateGpx(gpx);
  assert.deepEqual(check.errors, []);
  assert.equal(check.ok, true);
  assert.equal(check.points, 3);
});

test('escapes XML metacharacters and keeps non-ASCII names intact', () => {
  const gpx = C.buildGpx({
    points: SAMPLE,
    name: 'Café "Batavia" & Grünwald <test>',
    time: '2026-08-14T00:00:00.000Z'
  });
  assert.equal(assertWellFormedXml(gpx), 'gpx');
  assert.match(gpx, /<name>Café &quot;Batavia&quot; &amp; Grünwald &lt;test&gt;<\/name>/);
  assert.equal(C.validateGpx(gpx).ok, true);
});

test('omits <ele> for points with no elevation instead of writing junk', () => {
  const gpx = C.buildGpx({
    points: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }],
    time: '2026-08-14T00:00:00.000Z'
  });
  assert.equal(assertWellFormedXml(gpx), 'gpx');
  assert.match(gpx, /<trkpt lat="1\.000000" lon="2\.000000"><\/trkpt>/);
  assert.doesNotMatch(gpx, /<ele>/);
});

test('refuses to build a track from fewer than two points', () => {
  assert.throws(() => C.buildGpx({ points: [{ lat: 1, lon: 2 }] }), /at least two/);
  assert.throws(() => C.buildGpx({ points: [] }), /at least two/);
});

test('validateGpx catches damaged documents', () => {
  const good = C.buildGpx({ points: SAMPLE, name: 'x', time: '2026-08-14T00:00:00.000Z' });
  assert.equal(C.validateGpx(good).ok, true);

  const wrongNs = good.replace('http://www.topografix.com/GPX/1/1"', 'http://www.topografix.com/GPX/1/0"');
  assert.match(C.validateGpx(wrongNs).errors.join(' '), /namespace/);

  const noCreator = good.replace(/ creator="[^"]*"/, '');
  assert.match(C.validateGpx(noCreator).errors.join(' '), /creator/);

  const twoSegs = good.replace('</trkseg>', '</trkseg><trkseg>').replace('</trk>', '</trkseg></trk>');
  assert.match(C.validateGpx(twoSegs).errors.join(' '), /trkseg/);

  const bareAmp = good.replace('<name>x</name>', '<name>Ben & Jerry</name>');
  assert.match(C.validateGpx(bareAmp).errors.join(' '), /unescaped/);
  assert.throws(() => assertWellFormedXml(bareAmp));
});

/* ── naming, geometry, chunking ───────────────────────────────────────── */

test('builds a sensible download filename', () => {
  const wps = [{ kind: 'name', label: 'Senayan, Jakarta' }, { kind: 'name', label: 'Ancol, Jakarta Utara' }];
  assert.equal(C.buildFilename(wps, 'cycling-regular'), 'senayan-to-ancol-cycling.gpx');
  assert.equal(C.buildFilename(wps, 'foot-walking'), 'senayan-to-ancol-walking.gpx');
  assert.equal(C.buildFilename(wps, 'cycling-road'), 'senayan-to-ancol-road-cycling.gpx');
  assert.equal(C.routeName(wps), 'Senayan → Ancol');

  const accented = [{ kind: 'name', label: 'Café Batavia' }, { kind: 'name', label: 'Grünwalder Straße' }];
  assert.equal(C.buildFilename(accented, 'foot-hiking'), 'cafe-batavia-to-grunwalder-strasse-hiking.gpx');

  const coords = [{ kind: 'coords', lat: -6.2088, lon: 106.8456 }, { kind: 'coords', lat: -6.1751, lon: 106.865 }];
  assert.match(C.buildFilename(coords, 'cycling-regular'), /^-?6-2088.*\.gpx$/);
});

test('slugify strips accents and punctuation', () => {
  assert.equal(C.slugify('Jalan Jenderal Sudirman!'), 'jalan-jenderal-sudirman');
  assert.equal(C.slugify('  ---  '), '');
  assert.equal(C.slugify('Ørsted & Sønner'), 'orsted-sonner');
});

test('haversine distances are within a metre of known values', () => {
  /* Monas → Kota Tua, Jakarta: ~5.0 km */
  const d = C.haversine({ lat: -6.1754, lon: 106.8272 }, { lat: -6.1352, lon: 106.8133 });
  assert.ok(Math.abs(d - 4720) < 60, `expected ~4.72 km, got ${Math.round(d)} m`);
  assert.equal(C.haversine({ lat: 1, lon: 1 }, { lat: 1, lon: 1 }), 0);
});

test('cumulative distances are monotonic and start at zero', () => {
  const d = C.cumulativeDistances(SAMPLE);
  assert.equal(d[0], 0);
  assert.equal(d.length, SAMPLE.length);
  for (let i = 1; i < d.length; i++) assert.ok(d[i] >= d[i - 1]);
});

test('dedupePoints only removes consecutive repeats', () => {
  const out = C.dedupePoints([
    { lat: 1, lon: 1 }, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }, { lat: 1, lon: 1 }
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((p) => p.lat), [1, 2, 1]);

  /* a duplicate carrying elevation should not lose it */
  const kept = C.dedupePoints([{ lat: 1, lon: 1 }, { lat: 1, lon: 1, ele: 7 }]);
  assert.deepEqual(kept, [{ lat: 1, lon: 1, ele: 7 }]);
});

test('elevation stats ignore noise below the threshold', () => {
  const flat = [10, 10.5, 9.8, 10.2, 10].map((ele, i) => ({ lat: i * 0.001, lon: 0, ele }));
  assert.deepEqual(C.elevationStats(flat), { ascent: 0, descent: 0, min: 10, max: 11 });

  const hill = [0, 25, 50, 25, 0].map((ele, i) => ({ lat: i * 0.001, lon: 0, ele }));
  const s = C.elevationStats(hill);
  assert.equal(s.ascent, 50);
  assert.equal(s.descent, 50);
  assert.equal(s.max, 50);

  assert.deepEqual(C.elevationStats([{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }]),
    { ascent: null, descent: null, min: null, max: null });
});

test('interpolate walks the great circle between two points', () => {
  const a = { lat: -7.4243772, lon: 109.2301616 };   // Purwokerto
  const b = { lat: -7.7428365, lon: 108.4936205 };   // Batukaras

  /* endpoints come back exactly, not perturbed by the trig round-trip */
  assert.deepEqual(C.interpolate(a, b, 0), { lat: a.lat, lon: a.lon });
  assert.deepEqual(C.interpolate(a, b, 1), { lat: b.lat, lon: b.lon });

  /* the midpoint is equidistant from both ends, and half the total away */
  const total = C.haversine(a, b);
  const mid = C.interpolate(a, b, 0.5);
  assert.ok(Math.abs(C.haversine(a, mid) - total / 2) < 1);
  assert.ok(Math.abs(C.haversine(mid, b) - total / 2) < 1);

  /* degenerate input must not produce NaN */
  assert.deepEqual(C.interpolate(a, a, 0.5), { lat: a.lat, lon: a.lon });
});

test('splitPoints returns evenly spaced interior points only', () => {
  const a = { lat: -7.4243772, lon: 109.2301616 };
  const b = { lat: -7.7428365, lon: 108.4936205 };
  const total = C.haversine(a, b);

  assert.equal(C.splitPoints(a, b, 2).length, 1);
  assert.equal(C.splitPoints(a, b, 4).length, 3);

  const chain = [a, ...C.splitPoints(a, b, 4), b];
  const legs = [];
  for (let i = 1; i < chain.length; i++) legs.push(C.haversine(chain[i - 1], chain[i]));

  /* four legs, each a quarter of the whole, summing back to the total */
  assert.equal(legs.length, 4);
  for (const leg of legs) assert.ok(Math.abs(leg - total / 4) < 1, `leg ${Math.round(leg)} vs ${Math.round(total / 4)}`);
  assert.ok(Math.abs(legs.reduce((s, x) => s + x, 0) - total) < 1);

  /* no endpoint duplication */
  assert.ok(C.splitPoints(a, b, 4).every((p) => C.haversine(p, a) > 1 && C.haversine(p, b) > 1));
});

test('an auto-split of an 89 km leg produces legs under the ORS limit', () => {
  /* Alun Alun Purwokerto → House of Sawah, Batukaras — a real link that
     exceeds the free tier's 100 km cap once road distance is counted. */
  const a = { lat: -7.4243772, lon: 109.2301616 };
  const b = { lat: -7.7428365, lon: 108.4936205 };
  const straight = C.haversine(a, b);
  assert.ok(straight > 87000 && straight < 91000, `expected ~89 km, got ${Math.round(straight / 1000)} km`);

  /* the sizing the app uses: 35% road allowance, 10% headroom under the cap */
  const limitM = 100000;
  const legs = Math.max(2, Math.min(8, Math.ceil((straight * 1.35) / (limitM * 0.9))));
  assert.equal(legs, 2);

  const chain = [a, ...C.splitPoints(a, b, legs), b];
  for (let i = 1; i < chain.length; i++) {
    const withRoadAllowance = C.haversine(chain[i - 1], chain[i]) * 1.35;
    assert.ok(withRoadAllowance < limitM,
      `leg ${i} would be ~${Math.round(withRoadAllowance / 1000)} km, over the ${limitM / 1000} km cap`);
  }
});

test('sampleAlongTrack spaces points by distance travelled, not by index', () => {
  /* A track whose points are bunched at the start: sampling by array index
     would cluster the split points there, sampling by distance must not. */
  const track = [];
  for (let i = 0; i < 50; i++) track.push({ lat: 0, lon: i * 0.0001 });   // dense, short
  for (let i = 1; i <= 10; i++) track.push({ lat: 0, lon: 0.0049 + i * 0.05 });  // sparse, long

  const total = C.cumulativeDistances(track).pop();
  const mids = C.sampleAlongTrack(track, 4);
  assert.equal(mids.length, 3);

  const cum = (p) => C.haversine(track[0], p);
  for (let k = 0; k < mids.length; k++) {
    const want = (total * (k + 1)) / 4;
    /* within one track-segment of the target */
    assert.ok(Math.abs(cum(mids[k]) - want) < 6000,
      `point ${k} at ${Math.round(cum(mids[k]))} m, wanted ~${Math.round(want)} m`);
  }

  /* strictly increasing, and never the endpoints */
  for (let k = 1; k < mids.length; k++) assert.ok(mids[k].lon > mids[k - 1].lon);
  assert.ok(mids[mids.length - 1].lon < track[track.length - 1].lon);

  assert.deepEqual(C.sampleAlongTrack([], 4), []);
  assert.deepEqual(C.sampleAlongTrack([{ lat: 0, lon: 0 }], 4), []);
  assert.deepEqual(C.sampleAlongTrack([{ lat: 1, lon: 1 }, { lat: 1, lon: 1 }], 2), []);
});

test('mostDivergentPoint finds what makes an alternative different', () => {
  /* base runs due east; the alternative bulges north in the middle */
  const base = [];
  for (let i = 0; i <= 20; i++) base.push({ lat: 0, lon: i * 0.01 });

  const alt = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    alt.push({ lat: Math.sin(t * Math.PI) * 0.05, lon: i * 0.01 });   // peak at the middle
  }

  const spot = C.mostDivergentPoint(alt, base);
  assert.ok(spot, 'expected a divergent point');
  assert.ok(Math.abs(spot.lon - 0.1) < 0.02, `expected the bulge near lon 0.1, got ${spot.lon}`);
  assert.ok(spot.lat > 0.04, 'expected the northern bulge');
  /* 0.05° of latitude is roughly 5.5 km */
  assert.ok(spot.distance > 5000 && spot.distance < 6000, `got ${Math.round(spot.distance)} m`);

  /* a track compared with itself diverges by nothing */
  const same = C.mostDivergentPoint(base, base);
  assert.ok(same.distance < 1, `expected ~0, got ${same.distance}`);

  assert.equal(C.mostDivergentPoint([], base), null);
  assert.equal(C.mostDivergentPoint(alt, []), null);
});

test('distanceToTrack measures to the nearest vertex', () => {
  const track = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }];
  assert.equal(Math.round(C.distanceToTrack({ lat: 0, lon: 1 }, track)), 0);
  const off = C.distanceToTrack({ lat: 0.01, lon: 1 }, track);
  assert.ok(off > 1000 && off < 1200, `expected ~1.1 km, got ${Math.round(off)}`);
});

test('axis ticks land on round numbers', () => {
  assert.equal(C.niceStep(600, 4), 200);
  assert.equal(C.niceStep(13, 6), 2);
  assert.equal(C.niceStep(0.9, 3), 0.2);
  assert.equal(C.niceStep(0, 4), 1, 'a flat range must not divide by zero');

  assert.deepEqual(C.axisTicks(0, 600, 4), [0, 200, 400, 600]);
  assert.deepEqual(C.axisTicks(0, 12.9, 6), [0, 2, 4, 6, 8, 10, 12]);
  /* ticks stay inside the range even when it does not start at zero */
  const t = C.axisTicks(87, 365, 4);
  assert.ok(t[0] >= 87 && t[t.length - 1] <= 365, `got ${t.join(',')}`);
});

test('gradeStats measures sustained slope, not point-to-point noise', () => {
  /* ~1 m of climb every 10 m of ground = a steady 10% */
  const climb = [];
  for (let i = 0; i <= 200; i++) climb.push({ lat: 0, lon: i * 0.0000899, ele: i * 1 });
  const g = C.gradeStats(climb, 100);
  assert.ok(g.maxClimb > 9 && g.maxClimb < 11, `expected ~10%, got ${g.maxClimb}`);
  assert.equal(g.maxDescent, 0);

  /* a flat track with ±0.5 m DEM jitter must not report double-digit grades */
  const jittery = [];
  for (let i = 0; i <= 200; i++) jittery.push({ lat: 0, lon: i * 0.0000899, ele: 100 + (i % 2 ? 0.5 : -0.5) });
  const j = C.gradeStats(jittery, 100);
  assert.ok(Math.abs(j.maxClimb) < 2, `jitter inflated the climb to ${j.maxClimb}%`);
  assert.ok(Math.abs(j.maxDescent) < 2, `jitter inflated the descent to ${j.maxDescent}%`);

  /* no elevation at all → no grades, no NaN */
  const bare = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }];
  assert.deepEqual(C.gradeStats(bare), { maxClimb: 0, maxDescent: 0, climbAt: null, descentAt: null });
});

test('chunkWaypoints overlaps by one so the legs stitch back together', () => {
  const wps = Array.from({ length: 7 }, (_, i) => ({ lat: i, lon: i }));
  assert.deepEqual(C.chunkWaypoints(wps, 25), [wps]);

  const chunks = C.chunkWaypoints(wps, 3);
  assert.deepEqual(chunks.map((c) => c.map((w) => w.lat)), [[0, 1, 2], [2, 3, 4], [4, 5, 6]]);

  /* every chunk is routable and the joins line up */
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].length >= 2);
    assert.deepEqual(chunks[i][0], chunks[i - 1][chunks[i - 1].length - 1]);
  }
  /* nothing is lost */
  assert.equal(chunks[chunks.length - 1][chunks[chunks.length - 1].length - 1].lat, 6);
});

/* ── end to end: URL string in, GPX out ───────────────────────────────── */

test('a parsed URL feeds straight into a valid GPX document', () => {
  const parsed = C.parseGoogleMapsUrl(URLS.jakartaNamed);
  const points = parsed.waypoints.map((w) => ({ lat: w.lat, lon: w.lon, ele: 10 }));
  const gpx = C.buildGpx({
    points,
    name: C.routeName(parsed.waypoints),
    profile: 'cycling-regular',
    time: '2026-08-14T00:00:00.000Z'
  });
  assert.equal(assertWellFormedXml(gpx), 'gpx');
  assert.equal(C.validateGpx(gpx).ok, true);
  assert.match(gpx, /<name>Gelora Bung Karno → Taman Impian Jaya Ancol<\/name>/);
  assert.equal(C.buildFilename(parsed.waypoints, 'cycling-regular'),
    'gelora-bung-karno-to-taman-impian-jaya-ancol-cycling.gpx');
});
