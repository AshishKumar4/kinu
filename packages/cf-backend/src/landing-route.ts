/** `/` for a visitor with no session: streams the built landing asset. */

import { Hono } from 'hono';
import { AuthError, authenticateRequest } from './auth/session';
import { publicHtmlHeaders } from '@kinu.run/core';
import { markDocument } from '@kinu.run/core';
import type { FamilyEnv } from './api/context';

export const landingRoutes = new Hono<FamilyEnv<Env, object>>();

landingRoutes.get('/assets/kinu-icon.svg', async () => new Response(markDocument(), {
  headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600, must-revalidate' },
}));

landingRoutes.get('/', async (c, next) => {
  const request = c.req.raw;
  let signedIn = true;

  try {
    await authenticateRequest(request, c.env);
  } catch (e) {
    if (!(e instanceof AuthError) || e.status !== 401) throw e;
    signedIn = false;
  }

  if (signedIn) return await next();

  const headers = new Headers(publicHtmlHeaders());

  if (request.method === 'HEAD') return new Response(null, { headers });

  const assetUrl = new URL('/landing.html', request.url);
  const asset = await c.env.ASSETS.fetch(assetUrl);

  if (!asset.ok) {
    throw new Error(`landing asset returned ${String(asset.status)}`);
  }

  headers.delete('content-length');

  return new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
});
