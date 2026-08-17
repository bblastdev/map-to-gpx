/**
 * Local dev server — zero dependencies.
 *
 *   npm run dev     → http://localhost:8080
 *
 * Serves index.html and runs the same resolver logic the deployed serverless
 * function uses, so short links and the geocoding proxy work locally too.
 * This file is for development only; production is index.html on any static
 * host plus one serverless function.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleResolve, cacheHeader, CORS_HEADERS } from './lib/resolve-core.js';
import { handleRoute, CORS } from './lib/route-proxy.js';

const root = dirname(fileURLToPath(import.meta.url));

/* An explicitly requested port is a promise to whoever asked for it (a preview
   harness, a proxy, a bookmark), so we never silently move off it. Without one
   we are free to hop to the next free port. */
const explicitPort = process.env.PORT != null && process.env.PORT !== '';
const startPort = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gpx': 'application/gpx+xml'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/resolve') {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const { status, body, cacheSeconds } = await handleResolve(url.searchParams, process.env);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheHeader(cacheSeconds)
    });
    return res.end(JSON.stringify(body, null, 2));
  }

  if (url.pathname === '/api/route') {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const headers = Object.assign({}, req.headers);
    const out = await handleRoute({
      method: req.method, origin: req.headers.origin,
      host: req.headers.host, headers, rawBody: raw
    }, process.env);
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
    if (out.status === 204 || out.body === null) return res.writeHead(204).end();
    res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out.body, null, 2));
  }

  /* static files, confined to this directory */
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const path = join(root, rel);
  if (!path.startsWith(root)) return res.writeHead(403).end('Forbidden');

  try {
    const body = await readFile(path);
    const ext = rel.slice(rel.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

/** Is something already answering on this port, and is it us? */
async function probeSelf(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/resolve`, {
      signal: AbortSignal.timeout(1500)
    });
    const body = await res.json();
    return body && body.service === 'map-to-gpx resolver';
  } catch {
    return false;
  }
}

const MAX_PORT_HOPS = 10;

/**
 * `listen` reports a busy port through an 'error' event, not a thrown
 * exception — with no handler attached that becomes an unhandled 'error' and
 * takes the process down with a stack trace. Handle it and say something
 * useful instead.
 */
/* Report the port the socket actually bound to. A callback passed to
   listen() would close over the port we *asked* for, and stays attached after
   a failed attempt — so after a hop it announces the wrong address twice. */
server.on('listening', () => {
  const bound = server.address().port;
  console.log(`Map to GPX  →  http://localhost:${bound}`);
  console.log(`resolver    →  http://localhost:${bound}/api/resolve?q=Senayan%20Jakarta`);
});

function start(port, hopsLeft) {
  server.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') {
      console.error(`Map to GPX: ${err.message}`);
      process.exit(1);
    }

    if (await probeSelf(port)) {
      console.log(`Map to GPX is already running  →  http://localhost:${port}`);
      console.log('Nothing to do — stop that process first if you want a fresh one.');
      process.exit(0);
    }

    if (explicitPort) {
      console.error(`Map to GPX: port ${port} is already in use by another program.`);
      console.error(`  see what holds it:  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      console.error(`  or choose another:  PORT=${port + 1} npm run dev`);
      process.exit(1);
    }

    if (hopsLeft <= 0) {
      console.error(`Map to GPX: ports ${startPort}-${port} are all in use.`);
      process.exit(1);
    }

    console.log(`port ${port} is busy, trying ${port + 1}…`);
    start(port + 1, hopsLeft - 1);
  });

  server.listen(port);
}

start(startPort, MAX_PORT_HOPS);
