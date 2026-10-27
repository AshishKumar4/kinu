/** The session gate a signed-in route passes, in a Worker or in the account's object (user/account-pages.ts). */
import type { MiddlewareHandler } from 'hono';
import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { sessionGate, type AuthEnv, type AuthIdentity } from './session';
import { observeIdentity, type IndexFeedEnv } from '../control-plane/index-feed';
import { addressedWorkspace } from '../api/workspace';
import type { FamilyEnv } from '../api/context';

/** The browser session, then the cross-site rule; the identity it proves is noted in the control plane's index. */
export function sessionRouteGate<Id, E extends FamilyEnv<AuthEnv<Id> & IndexFeedEnv<Id>, { identity: AuthIdentity }>>(): MiddlewareHandler<E> {
  return (c, next) => settle(Effect.gen(function* () {
    const identity = yield* sessionGate(c.req.raw, c.env, addressedWorkspace(c.req.raw));

    if (identity instanceof Response) return identity;
    // After the cross-site check: cross-site requests never feed the index.
    observeIdentity(c.env, identity, { retain: c.executionCtx });
    c.set('identity', identity);
    yield* Effect.promise(() => next());
  }));
}
