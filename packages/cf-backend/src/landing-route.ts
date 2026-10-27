/** `/` for a visitor with no session: streams the built landing asset. */

import { Effect, Cause } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { Hono } from 'hono';
import { AuthError, authenticateRequest, type AuthEnv } from './auth/session';
import { publicHtmlHeaders } from '@kinu.run/core';
import type { FamilyEnv } from './api/context';

/** The landing page, for a request known to carry no session. */
export function landingPage(request: Request, env: Pick<Env, 'ASSETS'>): Promise<Response> {
  return settle(Effect.gen(function* () {
    const headers = new Headers(publicHtmlHeaders());

    if (request.method === 'HEAD') return new Response(null, { headers });

    const assetUrl = new URL('/landing.html', request.url);
    const asset = yield* Effect.promise(async () => env.ASSETS.fetch(assetUrl));

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
}

/** `/` with a credential that may no longer hold: the landing page when it does not, else the account's page. */
export const landingRoutes = new Hono<FamilyEnv<AuthEnv & Pick<Env, 'ASSETS'>, object>>();

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

    return yield* Effect.promise(async () => (signedIn ? next() : landingPage(request, c.env)));
  }));
});
