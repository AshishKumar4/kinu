/**
 * `/api/user/*` account-authority routes — the endpoints whose writes touch the
 * account itself rather than a record inside it.
 *
 * They sit in a module of their own, ahead of `handleUserRequest` in the step-9
 * `firstResponse` chain, because the authority behind them is different: both
 * calls below land on UserDO methods floored at the `account` capability, which
 * is `owner_only` — no workspace token reaches them, so they must not pass
 * through the workspace-token surface that `handleUserRequest` answers with.
 * Keeping them in a route file of their own is what makes "which endpoints
 * touch the account" answerable by reading one file.
 *
 * Routes:
 *   POST  /api/user/onboarding/complete  — first-run setup finished (idempotent)
 *   PATCH /api/user/profile              — rename the owner ({ displayName })
 */
import * as v from 'valibot';
import type { AuthIdentity } from '../auth/session';
import type { UserDO } from './user-do';
import {
  displayNameProblem,
  err, json, safeJson, ownerCaller, OwnerCapabilityUnavailableError,
  type UserCaller,
} from '@kinu.run/core';

const ProfilePatch = v.object({ displayName: v.string() });

export async function handleAccountRequest(request: Request, env: Env, identity: AuthIdentity): Promise<Response | null> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith('/api/user')) return null;
  const path = url.pathname.slice('/api/user'.length);

  if (!(path === '/onboarding/complete' && request.method === 'POST')
    && !(path === '/profile' && request.method === 'PATCH')) return null;

  let owner: UserCaller;

  try { owner = await ownerCaller(env); }
  catch (cause) {
    // Same answer the user plane gives: no root secret, nothing to authorize with.
    if (cause instanceof OwnerCapabilityUnavailableError) return err(503, cause.message);
    throw cause;
  }

  const stub: DurableObjectStub<UserDO> = env.UserDO.get(env.UserDO.idFromName(identity.userId));

  if (path === '/onboarding/complete' && request.method === 'POST') {
    return json(await stub.completeOnboarding(owner));
  }

  // PATCH /api/user/profile
  const body = await safeJson(request, ProfilePatch);

  if (!body) return err(400, 'Body must be { displayName }');

  const problem = displayNameProblem(body.displayName);

  if (problem !== null) return err(400, problem);

  return json(await stub.setDisplayName(owner, body.displayName));
}
