/**
 * Netlify Function (v2) — short-link resolver and geocoding proxy.
 *
 * Reachable at /.netlify/functions/resolve, and at /api/resolve via the
 * redirect in netlify.toml (which is what index.html calls by default).
 *
 *   GET /api/resolve?url=https://maps.app.goo.gl/xxxx   → {"url": "https://www.google.com/maps/dir/…"}
 *   GET /api/resolve?q=Senayan%20Jakarta                → {"results": [{lat, lon, display_name}]}
 */
import { handleResolve, cacheHeader, CORS_HEADERS } from '../../lib/resolve-core.js';

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Use GET.' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', Allow: 'GET, OPTIONS' }
    });
  }

  const params = new URL(request.url).searchParams;
  const { status, body, cacheSeconds } = await handleResolve(params, process.env);

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheHeader(cacheSeconds)
    }
  });
};

export const config = { path: '/api/resolve' };
