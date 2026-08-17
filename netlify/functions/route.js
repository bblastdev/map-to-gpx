/**
 * Netlify Function (v2) — shared-key routing proxy, served at /api/route.
 * Adapter only; the guards live in lib/route-proxy.js.
 */
import { handleRoute, CORS } from '../../lib/route-proxy.js';

export default async (request) => {
  const rawBody = request.method === 'POST' ? await request.text() : '';
  const url = new URL(request.url);

  const headers = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  const { status, body, headers: extra } = await handleRoute({
    method: request.method,
    origin: request.headers.get('origin'),
    host: request.headers.get('host') || url.host,
    headers,
    rawBody
  }, process.env);

  const out = Object.assign({}, CORS, extra, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  if (status === 204 || body === null) return new Response(null, { status, headers: CORS });
  return new Response(JSON.stringify(body), { status, headers: out });
};

export const config = { path: '/api/route' };
