/**
 * Vercel Serverless Function — shared-key routing proxy, served at /api/route.
 *
 * Lets visitors route without their own OpenRouteService key. All the guards
 * live in lib/route-proxy.js; this file only adapts Vercel's req/res shape.
 */
import { handleRoute, CORS } from '../lib/route-proxy.js';

export const config = { api: { bodyParser: false } };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      /* stop reading a body that is already over any sane size */
      if (bytes > 64 * 1024) { req.destroy(); return reject(new Error('body too large')); }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);

  let rawBody = '';
  if (req.method === 'POST') {
    try { rawBody = await readBody(req); }
    catch { res.status(413).json({ error: 'Request body is too large.' }); return; }
  }

  const { status, body, headers } = await handleRoute({
    method: req.method,
    origin: req.headers.origin,
    host: req.headers.host,
    headers: req.headers,
    rawBody
  }, process.env);

  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
  if (status === 204 || body === null) { res.status(status).end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
