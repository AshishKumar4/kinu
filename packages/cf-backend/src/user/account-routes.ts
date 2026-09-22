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
 *   POST   /api/user/onboarding/complete  — first-run setup finished (idempotent)
 *   PATCH  /api/user/profile              — rename the owner ({ displayName })
 *   DELETE /api/user/account              — the account itself ({ confirm })
 *   GET    /api/user/experience           — the owner's library (?kind=&limit=)
 *
 * The experience read sits here rather than in `routes.ts` for a plainer
 * reason than authority: that dispatcher is at its complexity ceiling, and a
 * new endpoint belongs in a module that can grow.
 */
import * as v from 'valibot';
import type { AuthIdentity } from '../auth/session';
import type { UserDO } from './user-do';
import { forgetSharesGiven } from './shares-given';
import {
  confirmsAccountDelete,
  decodeJsonWire,
  displayNameProblem,
  EXPERIENCE_KINDS,
  err, json, safeJson, ownerCaller, OwnerCapabilityUnavailableError,
  type UserCaller,
} from '@kinu.run/core';

const ProfilePatch = v.object({ displayName: v.string() });

const DeleteConfirm = v.object({ confirm: v.string() });

const ExperienceQuery = v.object({
  kind: v.picklist(EXPERIENCE_KINDS),
  limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
});

export async function handleAccountRequest(request: Request, env: Env, identity: AuthIdentity): Promise<Response | null> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith('/api/user')) return null;
  const path = url.pathname.slice('/api/user'.length);

  if (!(path === '/onboarding/complete' && request.method === 'POST')
    && !(path === '/profile' && request.method === 'PATCH')
    && !(path === '/account' && request.method === 'DELETE')
    && !(path === '/experience' && request.method === 'GET')) return null;

  let owner: UserCaller;

  try { owner = await ownerCaller(env); }
  catch (cause) {
    // Same answer the user plane gives: no root secret, nothing to authorize with.
    if (cause instanceof OwnerCapabilityUnavailableError) return err(503, cause.message);
    throw cause;
  }

  const stub: DurableObjectStub<UserDO> = env.UserDO.get(env.UserDO.idFromName(identity.userId));

  if (path === '/onboarding/complete' && request.method === 'POST') {
    return json({ body: await stub.completeOnboarding(owner) });
  }

  if (path === '/experience' && request.method === 'GET') {
    const limitRaw = url.searchParams.get('limit');

    const query = v.safeParse(ExperienceQuery, {
      kind: url.searchParams.get('kind'),
      limit: limitRaw === null ? 50 : Number(limitRaw),
    });

    if (!query.success) return err(400, `kind must be one of ${EXPERIENCE_KINDS.join(', ')} and limit an integer from 1 to 100.`);

    return json({ body: decodeJsonWire(await stub.searchExperienceWire(owner, query.output)) });
  }

  // DELETE /api/user/account — the one that cannot be undone. The typed
  // confirmation is the account's own email, not a password: the session is
  // the authentication, and the phrase is what separates a stray click from a
  // decision. There is deliberately no rate limit on it; the phrase is the gate.
  if (path === '/account' && request.method === 'DELETE') {
    const body = await safeJson(request, DeleteConfirm);

    if (!body || !confirmsAccountDelete(body.confirm, identity.email)) {
      return err(400, 'Type the account email to confirm.');
    }

    // The recipients of this account's shares are named only inside the
    // workspaces the delete destroys, so they are forgotten first.
    await forgetSharesGiven(env, identity.userId, owner);

    try {
      await stub.deleteAccount(owner, identity.userId);
    } catch (cause) {
      // The SDK's destroy aborts its own isolate after the durable wipe, and
      // that exact sentinel is successful completion — the same rule
      // `tearDownWorkspace` applies to a workspace object. Anything else is real.
      if (!(cause instanceof Error) || cause.message !== 'destroyed') throw cause;
    }

    return json({ body: { deleted: true } });
  }

  // PATCH /api/user/profile
  const body = await safeJson(request, ProfilePatch);

  if (!body) return err(400, 'Body must be { displayName }');

  const problem = displayNameProblem(body.displayName);

  if (problem !== null) return err(400, problem);

  return json({ body: await stub.setDisplayName(owner, body.displayName) });
}
