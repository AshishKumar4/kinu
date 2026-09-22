/**
 * `/api/user/*` account-authority routes. They run ahead of `handleUserRequest` because their
 * UserDO methods are floored at the `owner_only` `account` capability; no workspace token reaches them.
 */
import * as v from 'valibot';
import type { AuthIdentity } from '../auth/session';
import type { UserDO } from './user-do';
import { forgetSharesGiven, type ShareRosterAuthority, type SharesGivenEnv } from './shares-given';
import type { ObjectNamespace } from '@kinu.run/core';
import {
  confirmsAccountDelete,
  
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

export type AccountAuthority = Pick<
  UserDO, 'completeOnboarding' | 'searchExperience' | 'deleteAccount' | 'setDisplayName'
>;

export interface AccountRoutesEnv<Id> extends SharesGivenEnv<Id> {
  UserDO: ObjectNamespace<Id, ShareRosterAuthority & AccountAuthority>;
}

export async function handleAccountRequest<Id>(
  request: Request, env: AccountRoutesEnv<Id>, identity: AuthIdentity,
): Promise<Response | null> {
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
    if (cause instanceof OwnerCapabilityUnavailableError) return err(503, cause.message);
    throw cause;
  }

  const stub = env.UserDO.get(env.UserDO.idFromName(identity.userId));

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

    return json({ body: await stub.searchExperience(owner, query.output) });
  }

  // The typed confirmation is the account email, not a password: the session authenticates,
  // the phrase separates a stray click from a decision. No rate limit; the phrase is the gate.
  if (path === '/account' && request.method === 'DELETE') {
    const body = await safeJson(request, DeleteConfirm);

    if (!body || !confirmsAccountDelete(body.confirm, identity.email)) {
      return err(400, 'Type the account email to confirm.');
    }

    // Share recipients are named only inside the workspaces the delete destroys; forget them first.
    await forgetSharesGiven(env, identity.userId, owner);

    try {
      await stub.deleteAccount(owner, identity.userId);
    } catch (cause) {
      // The SDK's destroy aborts its own isolate after the durable wipe; the 'destroyed' sentinel
      // means success (same rule as `tearDownWorkspace`).
      if (!(cause instanceof Error) || cause.message !== 'destroyed') throw cause;
    }

    return json({ body: { deleted: true } });
  }

  const body = await safeJson(request, ProfilePatch);

  if (!body) return err(400, 'Body must be { displayName }');

  const problem = displayNameProblem(body.displayName);

  if (problem !== null) return err(400, problem);

  return json({ body: await stub.setDisplayName(owner, body.displayName) });
}
