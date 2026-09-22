/**
 * Shares an account has given, read by both the shared library and the account-delete sweep.
 * Delete needs revoked shares too: their recipients still hold the `sharesReceived_add` row.
 * Worker code only: it claims ownership via the session plane and derives ids from emails.
 */
import * as v from 'valibot';
import { retryTransientDO, type UserCaller } from '@kinu.run/core';
import {
  claimOwnedWorkspace,
  type WorkspaceOwnerClaim, type WorkspaceOwnershipEnv, type WorkspaceRegistry,
} from './workspace-ownership';
import { workspaceOwner, type WorkspaceOwnerRpc } from '../workspace-owner-rpc';
import type { ObjectNamespace } from '@kinu.run/core';
import type { UserDO } from './user-do';
import { ROOT_SLATE_CALLER } from '../slates/bindings';
import { deriveUserId } from '../auth/store';

const ShareRowSchema = v.object({
  id: v.string(), slate: v.string(), createdAt: v.number(), revokedAt: v.nullable(v.number()),
  users: v.array(v.string()),
});

export interface WorkspaceShares {
  workspace: string;
  shares: Array<v.InferOutput<typeof ShareRowSchema>>;
}

/** A workspace the claim refuses is skipped; one that answered the claim but cannot list its
 *  shares is a broken read and throws. */
export type ShareRosterAuthority =
  WorkspaceRegistry & Pick<UserDO, 'listActiveWorkspaces' | 'sharesReceived_forget'>;

export interface SharesGivenEnv<Id>
  extends WorkspaceOwnershipEnv<Id, WorkspaceOwnerClaim & WorkspaceOwnerRpc> {
  UserDO: ObjectNamespace<Id, ShareRosterAuthority>;
}

export async function sharesGiven<Id>(
  env: SharesGivenEnv<Id>, owner: UserCaller, userId: string,
): Promise<WorkspaceShares[]> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
  const answer: WorkspaceShares[] = [];

  for (const workspace of await userDO.listActiveWorkspaces(owner)) {
    const claim = await claimOwnedWorkspace(env, userId, workspace.name);

    if (!claim.ok) continue;

    const owned = workspaceOwner(env, workspace.name);
    const listing = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'shares' });

    if (!listing.ok) throw new Error(`listing blueprints of ${workspace.name}: ${listing.reason}: ${listing.error}`);
    answer.push({ workspace: workspace.name, shares: v.parse(v.array(ShareRowSchema), listing.value) });
  }

  return answer;
}

/**
 * Must run before the account's own object is torn down: recipients are listed only in the
 * workspaces teardown destroys. Idempotent, so a retried delete does no harm here.
 */
export async function forgetSharesGiven<Id>(
  env: SharesGivenEnv<Id>, userId: string, owner: UserCaller,
): Promise<{ recipients: number }> {
  const emails = new Set<string>();

  for (const { shares } of await sharesGiven(env, owner, userId)) {
    for (const share of shares) {
      for (const email of share.users) emails.add(email.toLowerCase());
    }
  }

  for (const email of emails) {
    const recipient = env.UserDO.get(env.UserDO.idFromName(await deriveUserId(email)));
    await retryTransientDO('sharesReceived_forget', () => recipient.sharesReceived_forget(owner, userId));
  }

  return { recipients: emails.size };
}
