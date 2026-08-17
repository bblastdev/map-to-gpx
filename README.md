# Map to GPX

Paste a Google Maps directions link, get a GPX track you can load onto a Garmin/Coros/Suunto
watch, a bike computer, Strava or Komoot.

The whole app is one static `index.html` — no build step, no framework, no backend required.
A single optional serverless function expands `maps.app.goo.gl` short links and proxies
geocoding.

```
┌ index.html ────────────────────────────────────────────────────────┐
│  parse the Maps URL  →  geocode any place names  →  route via ORS  │
│         →  stitch + dedupe  →  GPX 1.1  →  download                │
└────────────────────────────────────────────────────────────────────┘
```

**Routing comes from [OpenRouteService](https://openrouteservice.org/), not Google.** Google's
Directions API terms forbid exporting or storing their route data, so the Google link is only
ever read for its *waypoints*; the actual path between them is computed by ORS on OpenStreetMap
data, which is freely redistributable.

---

## Getting an OpenRouteService API key

1. Sign up at **<https://openrouteservice.org/dev/#/signup>** (free, no card).
2. Open the dashboard and request a token on the **free** plan.
3. Copy the token and paste it into the app's *OpenRouteService API key* field.

The key is held in a JavaScript variable for the lifetime of the tab. It is never written to
`localStorage`, `sessionStorage` or a cookie, and never sent anywhere except OpenRouteService —
so it has to be pasted again after a reload. That is deliberate: a key in `localStorage` on a
public site is a key waiting to be stolen by any XSS.

### Not retyping it every reload (local use only)

Create `config.local.js` next to `index.html`:

```js
window.MAPTOGPX_KEY = 'your-openrouteservice-key';
```

`index.html` loads that file if it is there and prefills the key field. With the key already
supplied there is nothing to ask for, so the field moves out of the main form into **Advanced** —
still there to override, just not occupying the form or showing a credential on screen. The file
is in `.gitignore`, and its absence is harmless: the browser logs a 404 for it and the app
carries on with the key field in its usual place.

> ⚠ **Delete `config.local.js` before deploying anywhere public.** Everything it contains is
> readable by anyone who loads the page, and `netlify.toml` publishes the whole directory. On a
> public deployment, let people type their own key.

Free tier limits worth knowing: **40 directions requests/minute** and **2 000/day**. There is
also a cap on route length per request, but it is generous and varies by deployment — a 132 km
`cycling-road` route goes through in one piece on `api.heigit.org` — so the app does not
hardcode a number. It sends the whole route and only reacts if ORS answers with its "exceeds the
server configuration limits" error (code 2004):

1. **More than two stops** — re-request one leg at a time and stitch the results.
2. **Only two stops** — there is no waypoint left to break on, so the app picks its own:
   - It first asks ORS for a **`driving-car` route between the same two stops**, whose distance
     cap is far higher, purely to learn where the road actually runs. Split points are then
     sampled evenly *along that corridor*. They are already on roads, and the legs follow the
     way people really drive.
   - If that request fails, it falls back to points on the straight line between the stops, each
     pulled onto the nearest mapped feature by reverse geocoding. This is worse — a straight
     line across country can force the route somewhere no road goes near — so the note under the
     summary says which method was used.

   Either way the route is *forced* through the invented points, so they are drawn on the map as
   hollow markers and called out under the summary. For real control over the shape, add your
   own stops in Google Maps instead.

The number of pieces comes from the limit ORS reports: the measured corridor distance divided by
90% of the cap, or — in the fallback — the straight line plus a 35% allowance for roads not
running straight.

---

## Running locally

```bash
npm run dev
```

Then open <http://localhost:8080>. This serves `index.html` and runs the resolver at
`/api/resolve`, so short links and the geocoding proxy work exactly as they do in production.

You can also just open `index.html` directly from disk — everything works except short-link
expansion, which needs a server (see below). Clear the *Advanced → Short-link resolver endpoint*
field in that case.

### Tests

```bash
npm test
```

The tests extract the `<script id="mtg-core">` block out of `index.html` and run it in Node's
`vm`, so they exercise the code that actually ships rather than a copy that can drift. They
cover URL parsing (real captured Google Maps URLs, the `api=1` query form, the legacy
`saddr`/`daddr` form, non-ASCII names, short links, "Your location", malformed input), GPX
generation and XML well-formedness, filename slugs, distance/elevation maths, and the waypoint
chunking used for long routes.

The GPX assertions are checked twice: once by the app's own `validateGpx()`, and once by a
small XML scanner written independently inside the test file — so a bug in the validator cannot
let malformed GPX pass.

---

## The interface

A two-pane workspace: controls and results on the left, map and elevation profile on the right,
stacking to a single column on a phone. Dark by default, light on request — the choice is
remembered, and the map tiles follow it.

Three profiles are offered — **Bike** (`cycling-road`), **Run** (`foot-walking`) and **Hike**
(`foot-hiking`). ORS's `cycling-regular` is no longer one of the choices; the core still knows it,
so an older shared link that carries it keeps working.

**The route is editable after it is built.** The stops are not just an input any more:

- **Drag a pin** on the map to move that stop; the route rebuilds around it.
- **Add a stop** arms the map — the next click inserts a stop in the right place along the
  track, judged by where the click falls on the existing line rather than by list order.
- **×** on any intermediate stop removes it and reroutes.

Each stop is listed with where its position came from: read from the link, geocoded from a name,
moved by you, added by you, or carried in on a shared link. That provenance is what tells you
which pins to distrust.

**Share link** encodes the stops and profile into the URL fragment and copies it. Opening that
link restores the stops and rebuilds the route from OpenStreetMap — the geometry is never in the
URL, only the stops, so a shared link stays short and re-routes with whatever ORS knows today.

Conversion progress is shown as four named steps — read the link, locate the stops, route it,
measure and write the GPX — with an elapsed clock, so a slow geocode is distinguishable from a
slow route. Errors are shown as a headline, a short list of things to try, and the raw upstream
response folded away under "Technical detail".

## What the summary shows

| | |
| --- | --- |
| **Distance** | ORS's measured road distance |
| **Ascent / Descent** | from ORS when it reports them, otherwise computed from the track with a 2 m hysteresis threshold |
| **Est. time** | ORS's own duration estimate for the chosen profile — a rough guide, not a plan |
| **High / low** | highest and lowest point on the route |
| **Steepest** | the sharpest sustained climb and descent, measured over a rolling 100 m window rather than between adjacent points, which at DEM sampling density produces meaningless percentages |

The elevation profile has gridlines and labelled axes in metres and kilometres, and hovering (or
dragging a finger across it) reads out **distance · elevation · slope** at that point. Slope is
taken across neighbouring samples for the same reason as above.

## Route options

For a straight A→B link the app asks ORS for **alternative routes** and lists them, the way
Google lists "via Jl. Raya Cijulang". Each is labelled after the place that makes it different —
found by taking the point on the alternative that lies furthest from the fastest route and
reverse geocoding it — plus its distance and total climb:

```
● Fastest                        131.8 km · ↑ 1912 m     IN THE GPX
│ via Banjarsari, Ciamis         146.0 km · ↑ 2722 m
│ via Sidarahayu, Purwadadi      143.8 km · ↑ 2863 m
```

Picking one redraws the map, the elevation profile and the GPX; the ones you did not pick stay
on the map as faint dashed lines so you can see how they differ. Files from a non-default option
get a numeric suffix (`…-road-cycling-2.gpx`) so downloading two does not leave you with one.

**These are ORS's alternatives, not Google's.** The Google link does not carry which of *its*
alternatives you had selected, and the two engines compute different route sets from different
data — so this is a choice among real options, not a way to reproduce the exact line Google drew.

Two limits, both from ORS rather than from this app: alternatives need a plain two-stop route
(the API rejects them alongside intermediate waypoints), and when a route is long enough to need
splitting, the alternatives offered are of the *driving corridor* — different ways round — with
the ride built along whichever you choose.

## Deploying

### Before you publish: whose API key?

The app is built so **each visitor pastes their own OpenRouteService key**, held in memory for
their tab. That is the safe default — your quota is never at risk — but it does mean anyone you
share the link with has to sign up for a free key before their first route.

If you would rather visitors used it without signing up, the key has to move server-side: add a
function that holds *your* key in an environment variable and forwards routing requests to ORS,
then point the app at it. Be clear-eyed about the trade: a public endpoint spending your key is
one scraper away from your 2 000/day being gone, so it needs at minimum a rate limit and an
origin check. Not built here — it is a deliberate choice, not an oversight.

> ⚠ **Never deploy `config.local.js`.** It holds your key in plain text, `netlify.toml`
> publishes the whole directory, and the Netlify CLI does *not* consult `.gitignore` for it.
> `npm run deploy:*` runs a preflight that refuses to publish while that file exists — move it
> aside, deploy, move it back.

### Netlify

```bash
npm run deploy:netlify
```

Runs the preflight, then `netlify deploy --prod`. `netlify.toml` publishes the repo root and
picks up `netlify/functions/resolve.js` at `/api/resolve`. Nothing to build.

### Vercel

```bash
npm run deploy:vercel
```

Runs the preflight, then `vercel --prod`. `api/resolve.js` is served at `/api/resolve`
automatically; `.vercelignore` keeps the key file, tests and dev server out of the bundle.

### Checking before you ship

```bash
npm run preflight
```

Fails if `config.local.js` is present or a key has been pasted into `index.html`, and reminds you
to set `NOMINATIM_UA`. Run `npm test` too — it checks the shipped page's own integrity, not just
the parser.

### GitHub Pages / any static host

Upload `index.html`. Everything works **except** short links — there is nowhere to run the
resolver. The app detects this and tells the user to open the short link in a browser tab and
paste the expanded URL instead. If you have the function deployed somewhere else, point
*Advanced → Short-link resolver endpoint* at its full URL.

### One environment variable worth setting

| Variable | Why |
| --- | --- |
| `NOMINATIM_UA` | Your contact address, e.g. `MyRouteApp/1.0 (you@example.com)`. [Nominatim's usage policy](https://operations.osmfoundation.org/policies/nominatim/) requires a genuine identifier; the default value is a placeholder. |

---

## Why a server is needed at all

Two things a page served from a static host cannot do:

1. **Follow a `maps.app.goo.gl` redirect.** Google serves no CORS headers on the short-link
   host, so the browser refuses to read the redirect. `?url=` does it server-side and returns
   the expanded URL as JSON.
2. **Send a `User-Agent` header.** `User-Agent` is a
   [forbidden header name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name)
   — a browser silently drops any attempt to set it on `fetch`. Nominatim's policy asks for a
   real identifier, so the geocoding endpoints proxy the lookup with a proper `User-Agent` and a
   server-side 1 req/s gate.

| Endpoint | Does |
| --- | --- |
| `?url=<google short link>` | Expands it to the full Maps URL |
| `?q=<place name>` | Forward geocode, for stops the link names but does not locate |
| `?lat=&lon=` | Reverse geocode, used to pull auto-split points onto a road |

When the resolver is unavailable the app falls back to calling Nominatim directly from the
browser. That still complies with their policy (browsers attach a `Referer` automatically,
which the policy accepts as identification) and the client self-limits to one request per
second — but running the proxy is the better-behaved option.

The resolver only accepts Google short-link hosts and re-checks the host at every redirect hop,
so it cannot be turned into an open proxy for fetching arbitrary URLs.

---

## What the parser handles

| Input | Notes |
| --- | --- |
| `/maps/dir/Start/Stop/End/@lat,lng,14z/data=…` | The normal modern link |
| `!1d`/`!2d` pairs in the `data=` blob | Google's own resolved coordinates — **preferred** over the place names, since a name has to be geocoded and might land somewhere else. `!1d` is longitude, `!2d` is latitude. |
| Raw `lat,lng` path segments | Used as-is, no geocoding |
| `maps.app.goo.gl` / `goo.gl` short links | Expanded via the resolver |
| `/maps/dir/?api=1&origin=…&destination=…&waypoints=A\|B` | The documented Maps URLs API |
| `?saddr=A&daddr=B+to:C` | The pre-2013 form still found in old emails |
| `%C3%A9`, `+`, `%2F`, `%2B` | Decoded in the right order, so `Café`, `RT.5/RW.2` and plus codes like `RR4F+264` survive |
| `!3e0/1/2/3` travel mode | Used to preselect a cycling or walking profile |
| Duplicate consecutive stops | Dropped |
| Routes with no intermediate waypoints | Fine — origin + destination is the common case |

It refuses, with an explanation rather than a stack trace, when the link is a *place* link
rather than directions, when it starts at "Your location" (the URL genuinely does not contain
your position), when it only identifies stops by Google place ID, or when the coordinate blob
and the path disagree about how many stops there are — in which case it geocodes the names
instead of guessing at an alignment.

## The GPX it writes

GPX 1.1, one `<trk>` with one `<trkseg>`, `<ele>` on every point when elevation is available:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Map to GPX (openrouteservice + OpenStreetMap)"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>Monas → Gelora Bung Karno</name>
    <desc>Converted from a Google Maps directions link · profile cycling-regular · …</desc>
    <time>2026-08-14T09:12:44.117Z</time>
    <bounds minlat="-6.218601" minlon="106.802966" maxlat="-6.175308" maxlon="106.827111"/>
  </metadata>
  <trk>
    <name>Monas → Gelora Bung Karno</name>
    <type>cycling</type>
    <trkseg>
      <trkpt lat="-6.175308" lon="106.827111"><ele>18.0</ele></trkpt>
      …
    </trkseg>
  </trk>
</gpx>
```

Child elements are emitted in the order the GPX 1.1 schema requires (`metadata` before `trk`,
`name`/`desc`/`type` before `trkseg`, `ele` first inside `trkpt`), names are XML-escaped,
characters illegal in XML 1.0 are stripped, and consecutive duplicate points are removed —
including the repeated point where two stitched legs meet. Every file is run through
`validateGpx()` before the download button is enabled.

Filenames come from the endpoints and the profile: `monas-to-gelora-bung-karno-cycling.gpx`.

---

## Files

```
index.html                    the entire app (inline CSS + JS), in three layers
  ├ <script id="mtg-core">    pure logic: parsing, geometry, GPX — what the tests import
  ├ <script id="mtg-engine">  headless networking: short links, geocoding, ORS, splitting
  └ (interface)               DOM, map and chart — the only layer that touches the page
lib/resolve-core.js         short-link expansion + Nominatim proxy, shared by both functions
netlify/functions/resolve.js  Netlify adapter
api/resolve.js                Vercel adapter
server.mjs                  local dev server (zero dependencies)
test/parser.test.mjs        the tests
```

Leaflet 1.9.4 is the one external code dependency, loaded from unpkg with subresource-integrity
hashes. If it fails to load the app says so and still produces the GPX — only the map preview
is lost. Inter is pulled from Google Fonts and falls back to the system UI font.

[Phosphor](https://phosphoricons.com/) supplies the icons (MIT), in **bold** and **fill**
weights. They are inlined as a 54-symbol SVG sprite rather than pulled from the icon-font CDN the
design referenced: no extra requests, nothing to fail at load, no flash of unstyled glyphs, and
each icon inherits `currentColor` so it themes along with everything else.

---

## Known limitations

- **Elevation is DEM-derived**, not barometric. ORS reports ascent/descent from a digital
  elevation model sampled along the route; expect it to differ from what your watch records.
  When ORS does not return totals the app computes them from the track with a 2 m hysteresis
  threshold, which avoids the wild over-counting a naive sum of differences produces.
- **A geocoded place name is a guess.** When a link carries only names, the app says so under
  the summary and asks you to check the pins before riding. Links with a `data=` blob skip
  geocoding entirely and are exact.
- **Google's route is not reproduced, and cannot be.** Google's terms forbid exporting their
  directions data, so the link is read only for its stops and ORS routes between them from
  scratch. Two engines on two datasets will not pick the same roads. If the GPX takes a
  different line from what Google showed you, that is the design, not a bug — and remember a
  Google *driving* route is a different question again from a road-bike route. Two things help:
  pick a different **route option** (above), or **add the intermediate stops in Google Maps**,
  which pins the shape down exactly.
- **Auto-split waypoints are a fallback, not a plan.** They are chosen by the app, not by you,
  and the route is forced through them. They appear as hollow markers on the map and are named
  under the summary — check them, and add your own stops if the line went somewhere you did not
  want.
- **Transit and driving links** are parsed happily, but the profile you pick is a foot or bike
  profile — ORS is asked for a bike/foot route between those same stops.

## Licence

MIT.
