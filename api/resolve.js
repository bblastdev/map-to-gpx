/**
 * Vercel Serverless Function — short-link resolver and geocoding proxy.
 *
 * Vercel maps this file to /api/resolve automatically, which is what
 * index.html calls by default.
 *
 *   GET /api/resolve?url=https://maps.app.goo.gl/xxxx   → {"url": "https://www.google.com/maps/dir/…"}
 *   GET /api/resolve?q=Senayan%20Jakarta                → {"results": [{lat, lon, display_name}]}
 */
import { handleResolve, cacheHeader, CORS_HEADERS } from '../lib/resolve-core.js';

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ error: 'Use GET.' });
    return;
  }

  const params = new URL(req.url, `https://${req.headers.host || 'localhost'}`).searchParams;
  const { status, body, cacheSeconds } = await handleResolve(params, process.env);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheHeader(cacheSeconds));
  res.status(status).json(body);
}
