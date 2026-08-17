/**
 * Deploy preflight — refuses to publish anything that would leak a key.
 *
 * npm runs this automatically before `npm run deploy:netlify` / `deploy:vercel`.
 * It exists because netlify.toml publishes the whole directory and the Netlify
 * CLI does not consult .gitignore for it: without this check, a local
 * config.local.js would be served to the public with the API key inside it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

/* 1. the local key file must not be present at deploy time */
if (existsSync(join(root, 'config.local.js'))) {
  problems.push(
    'config.local.js is present. It holds your OpenRouteService key and would be\n' +
    '  served publicly — anyone loading the page could read it and spend your quota.\n' +
    '  Move it aside first:   mv config.local.js ../config.local.js.bak\n' +
    '  Put it back after:     mv ../config.local.js.bak config.local.js'
  );
}

/* 2. no key baked into the page itself */
const html = readFileSync(join(root, 'index.html'), 'utf8');
const orsKey = /\beyJ[A-Za-z0-9_-]{40,}={0,2}/.exec(html);
if (orsKey) {
  problems.push(`index.html contains what looks like an API key (${orsKey[0].slice(0, 14)}…). Remove it.`);
}
if (/MAPTOGPX_KEY\s*=\s*['"][^'"]+['"]/.test(html)) {
  problems.push('index.html assigns MAPTOGPX_KEY a literal value. Remove it.');
}

/* 3. things that are not fatal but you want to know */
if (!process.env.NOMINATIM_UA) {
  notes.push(
    'NOMINATIM_UA is not set in this shell. Set it in the host\'s environment\n' +
    '  variables to a real contact address — OpenStreetMap\'s usage policy asks for\n' +
    '  one, and the default is a placeholder.'
  );
}

for (const n of notes) console.log('note:  ' + n);

if (problems.length) {
  console.error('\nDeploy blocked:\n');
  for (const p of problems) console.error('  ✖ ' + p + '\n');
  process.exit(1);
}

console.log('preflight ok — no key would be published.');
