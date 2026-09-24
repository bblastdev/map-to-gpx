/**
 * Build the app's web bundle, www/, from two places:
 *
 *   ../index.html   the website. Its core and engine scripts are copied out
 *                   verbatim, so the app routes, parses and writes GPX with
 *                   exactly the code the site runs -- there is one engine, not
 *                   a copy that drifts. The icon sprite comes from there too.
 *   src/            the app's own interface, which replaces the site's.
 *
 * Leaflet and the Inter font are bundled rather than fetched, because the app
 * has to open a saved route with no connection at all.
 *
 * The build refuses to finish if the private routing key could end up inside
 * the app. config.local.js holds it for local development; an app bundle is
 * public the moment it is on a store, so a key shipped in one is a key given
 * away.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const site = join(app, '..');
const out = join(app, 'www');

const fail = (msg) => { console.error('build-www: ' + msg); process.exit(1); };

/* ── pieces of the website ─────────────────────────────────────────────── */

const html = readFileSync(join(site, 'index.html'), 'utf8');

function scriptBlock(id) {
  const m = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) fail(`index.html has no <script id="${id}"> -- has the site been restructured?`);
  return m[1];
}
const core = scriptBlock('mtg-core');
const engine = scriptBlock('mtg-engine');

const spriteMatch = /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" style="display:none" aria-hidden="true">[\s\S]*?<\/svg>/.exec(html);
if (!spriteMatch) fail('could not find the icon sprite in index.html');
const sprite = spriteMatch[0];

/* ── assemble ──────────────────────────────────────────────────────────── */

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'js'), { recursive: true });
cpSync(join(app, 'src'), out, { recursive: true });

writeFileSync(join(out, 'js', 'core.js'), core);
writeFileSync(join(out, 'js', 'engine.js'), engine);

const indexPath = join(out, 'index.html');
const page = readFileSync(indexPath, 'utf8');
if (!page.includes('<!-- @sprite -->')) fail('src/index.html is missing its <!-- @sprite --> placeholder');
if (!page.includes('<!-- @dev -->')) fail('src/index.html is missing its <!-- @dev --> placeholder');

/* MTG_API=http://127.0.0.1:8080 npm run build points a development build at
   a local server -- the way to try a proxy change in the simulator before it
   is deployed. Without it the app talks to the site, as a release must. */
let dev = '';
if (process.env.MTG_API) {
  let api;
  try { api = new URL(process.env.MTG_API); } catch { fail('MTG_API is not a URL: ' + process.env.MTG_API); }
  if (!/^https?:$/.test(api.protocol)) fail('MTG_API must be http or https');
  dev = `<script>globalThis.MTG_API = ${JSON.stringify(api.origin)};</script>`;
  console.warn(`build-www: DEVELOPMENT BUILD -- the API is ${api.origin}. Rebuild without MTG_API before shipping.`);
}
writeFileSync(indexPath, page.replace('<!-- @sprite -->', sprite).replace('<!-- @dev -->', dev));

const mod = (...p) => join(app, 'node_modules', ...p);
/* Only what the page loads: the dist folder also carries source maps and ESM
   builds that would triple the bundle for nothing. */
mkdirSync(join(out, 'vendor', 'leaflet'), { recursive: true });
for (const f of ['leaflet.js', 'leaflet.css']) cpSync(mod('leaflet', 'dist', f), join(out, 'vendor', 'leaflet', f));
cpSync(mod('leaflet', 'dist', 'images'), join(out, 'vendor', 'leaflet', 'images'), { recursive: true });
mkdirSync(join(out, 'vendor', 'inter'), { recursive: true });
for (const f of ['inter-latin-wght-normal.woff2', 'inter-latin-ext-wght-normal.woff2']) {
  cpSync(mod('@fontsource-variable', 'inter', 'files', f), join(out, 'vendor', 'inter', f));
}

/* Capacitor's runtime and each plugin's ready-made browser bundle, loaded with
   plain script tags -- there is no bundler in this project. They keep each
   plugin's own JavaScript (secure storage's included) and its browser
   fallback, so the interface also runs in an ordinary tab during development. */
const PLUGINS = {
  core: ['@capacitor', 'core', 'dist', 'capacitor.js'],
  filesystem: ['@capacitor', 'filesystem', 'dist', 'plugin.js'],
  share: ['@capacitor', 'share', 'dist', 'plugin.js'],
  clipboard: ['@capacitor', 'clipboard', 'dist', 'plugin.js'],
  network: ['@capacitor', 'network', 'dist', 'plugin.js'],
  preferences: ['@capacitor', 'preferences', 'dist', 'plugin.js'],
  app: ['@capacitor', 'app', 'dist', 'plugin.js'],
  'status-bar': ['@capacitor', 'status-bar', 'dist', 'plugin.js'],
  'secure-storage': ['@aparajita', 'capacitor-secure-storage', 'dist', 'plugin.js'],
  'share-target': ['@capgo', 'capacitor-share-target', 'dist', 'plugin.js']
};
mkdirSync(join(out, 'vendor', 'capacitor'), { recursive: true });
for (const [name, parts] of Object.entries(PLUGINS)) {
  cpSync(mod(...parts), join(out, 'vendor', 'capacitor', name + '.js'));
}
/* The filesystem bundle takes a global named `synapse`, which its own
   dependency publishes as `outsystemsSynapse`. Without the alias the bundle
   throws on load and Filesystem is simply missing -- Send, Save and the saved
   route with it. */
const synapse = readFileSync(mod('@capacitor', 'synapse', 'dist', 'synapse.js'), 'utf8');
writeFileSync(join(out, 'vendor', 'capacitor', 'synapse.js'),
  synapse + '\nvar synapse = globalThis.outsystemsSynapse;\n');

/* ── the guard ─────────────────────────────────────────────────────────── */

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

/* The key itself, if there is a local one to compare against. */
let localKey = null;
const localConfig = join(site, 'config.local.js');
if (existsSync(localConfig)) {
  const m = /MAPTOGPX_KEY\s*=\s*['"]([^'"]+)['"]/.exec(readFileSync(localConfig, 'utf8'));
  if (m && m[1].length > 20) localKey = m[1];
}

const textLike = /\.(html|js|css|json|txt|map|svg|xml)$/i;
for (const f of files(out)) {
  const rel = relative(out, f);
  if (/config\.local/i.test(rel)) fail(`${rel} must never be in the app bundle`);
  if (!textLike.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  if (/config\.local\.js/.test(text)) fail(`${rel} refers to config.local.js, which holds the private key`);
  if (localKey && text.includes(localKey)) fail(`${rel} contains the private OpenRouteService key`);
  /* An ORS key is base64 of JSON beginning {"org": -- catch one even with no
     local file to compare against. */
  if (/eyJvcmciOi[A-Za-z0-9+/=]{20,}/.test(text)) fail(`${rel} contains what looks like an OpenRouteService key`);
}

console.log(`build-www: www/ built from index.html (core ${core.length} chars, engine ${engine.length} chars) and src/`);
