/** The account's object as every `/api/user/*` route reaches it, and the roster socket a page opens on it. */
import type { MiddlewareHandler } from 'hono';
import { idempotent } from '@nimbus-sh/fabric/do-calls.js';
import type { ObjectNamespace, UserCaller } from '@kinu.run/core';
import { appendIdentityHeaders } from '../cli/rpc-gate';
import { logDoCallRetry } from '../obs/do-call-retry';
import { ROSTER_SOCKET_PATH } from './roster';
import type { AuthIdentity } from '../auth/session';
import type { FamilyEnv } from '../api/context';
import type { UserDO } from './user-do';

export const ROSTER_SOCKET_ROUTE = '/api/user/workspaces/live';

/** The account's object, its profile upserted first: every `/api/user` route passes through this, and it is idempotent,
 *  so transient object failures are retried rather than failing the request. */
export async function accountObject<Id, Stub extends Pick<UserDO, 'ensureProfile'>>(
  namespace: ObjectNamespace<Id, Stub>,
  identity: AuthIdentity,
  owner: UserCaller,
): Promise<Stub> {
  const id = namespace.idFromName(identity.userId);

  await idempotent('ensureProfile', () => namespace.get(id),
    (stub) => stub.ensureProfile(owner, identity.email, identity.displayName ?? undefined), { onRetry: logDoCallRetry });

  return namespace.get(id);
}

export interface RosterSocketEnv<Id> {
  readonly UserDO: ObjectNamespace<Id, Pick<UserDO, 'ensureProfile' | 'fetch'>>;
}

// A socket cannot cross RPC; its upgrade request can. The object learns the browser session from the headers the edge
// rewrites from the verified identity, never from the page's own, and keeps it on the socket so logout can close it.
export function rosterSocket<Id, E extends FamilyEnv<RosterSocketEnv<Id>, { identity: AuthIdentity; owner: UserCaller }>>(): MiddlewareHandler<E> {
  return async (c) => {
    const identity = c.get('identity');
    const stub = await accountObject(c.env.UserDO, identity, c.get('owner'));

    return stub.fetch(new Request(new URL(ROSTER_SOCKET_PATH, c.req.url), new Request(c.req.raw, {
      headers: appendIdentityHeaders(c.req.raw.headers, identity),
    })));
  };
}
