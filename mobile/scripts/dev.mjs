/**
 * Work on the app's interface in an ordinary browser tab: `npm run dev` here,
 * then open /mobile/www/ on the address it prints.
 *
 * This starts the site's own dev server (../server.mjs), which serves the
 * built www/ and the API from one origin; outside a native shell the app calls
 * its API same-origin. The routing proxy needs a key, and for local work it
 * borrows the one in ../config.local.js -- server-side, in this process only,
 * the way the deployed proxy holds ORS_KEY. The page never sees it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const localConfig = join(site, 'config.local.js');

if (!process.env.ORS_KEY && existsSync(localConfig)) {
  const m = /MAPTOGPX_KEY\s*=\s*['"]([^'"]+)['"]/.exec(readFileSync(localConfig, 'utf8'));
  if (m) process.env.ORS_KEY = m[1];
}
if (!process.env.ORS_KEY) console.log('No ORS_KEY and no config.local.js: routing will ask for a key, which is a flow worth seeing too.');
console.log('The app is at /mobile/www/ on the address below.');

await import(join(site, 'server.mjs'));
