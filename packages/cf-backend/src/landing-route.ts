/** `/` for a visitor with no session: streams the built landing asset. */

import { Effect, Cause } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { Hono } from 'hono';
import { AuthError, authenticateRequest } from './auth/session';
import { publicHtmlHeaders } from '@kinu.run/core';
import { markDocument } from '@kinu.run/core';
import type { FamilyEnv } from './api/context';

export const landingRoutes = new Hono<FamilyEnv<Env, object>>();

landingRoutes.get('/assets/kinu-icon.svg', async () => new Response(markDocument(), {
  headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600, must-revalidate' },
}));

landingRoutes.get('/', (c, next) => {
  return settle(Effect.gen(function* () {
    const request = c.req.raw;
    let signedIn = true;

    yield* Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => authenticateRequest(request, c.env));
    }), (failed) => Effect.gen(function* () {
      const e = Cause.squash(failed);

      if (!(e instanceof AuthError) || e.status !== 401) return yield* Effect.failCause(failed);
      signedIn = false;
    }));

    if (signedIn) return yield* Effect.promise(async () => next());

    const headers = new Headers(publicHtmlHeaders());

    if (request.method === 'HEAD') return new Response(null, { headers });

    const assetUrl = new URL('/landing.html', request.url);
    const asset = yield* Effect.promise(async () => c.env.ASSETS.fetch(assetUrl));

    if (!asset.ok) {
      return yield* Effect.die(new Error(`landing asset returned ${String(asset.status)}`));
    }

    headers.delete('content-length');

    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers,
    });
  }));
});
