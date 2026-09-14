/**
 * The shares an account has GIVEN — the one enumeration the shared library
 * and the account-delete sweep both read.
 *
 * A share row lives in the workspace that holds the slate, so "my shares" is
 * each of the owner's workspaces asked in turn. The library lists the live
 * ones; the delete sweep needs every one, revoked included, because a revoked
 * share's recipients still hold the projection row `sharesReceived_add` wrote
 * them. One reader, so the two cannot disagree about which workspaces count.
 *
 * Worker code, never Durable Object code: it claims ownership through the
 * session plane and derives recipient ids from emails, neither of which an
 * object should carry in its graph.
 */
import * as v from 'valibot';
import { retryTransientDO, type UserCaller } from '@kinu.run/core';
import { claimOwnedWorkspace } from './workspace-ownership';
import { workspaceOwner } from '../workspace-owner-rpc';
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

/** Every workspace this account still owns, asked once for its share rows. A
 *  workspace the claim refuses is skipped — it is not this account's any more
 *  — but one that answered the claim and cannot list its shares is a broken
 *  read, not an empty one, and throws. */
export async function sharesGiven(env: Env, owner: UserCaller, userId: string): Promise<WorkspaceShares[]> {
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
 * Forget this account on every recipient it ever named. Runs BEFORE the
 * account's own object is torn down: the recipients are listed only in the
 * workspaces that teardown destroys. Idempotent — a forget on a recipient
 * holding no row for this owner deletes nothing — so a delete that died after
 * this step and was asked for again does no harm here.
 */
export async function forgetSharesGiven(env: Env, userId: string, owner: UserCaller): Promise<{ recipients: number }> {
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
