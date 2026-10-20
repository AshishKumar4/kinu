/**
 * The account-delete sweeps of shares: every account it sent a card is told to forget them, and every account that
 * sent it one forgets it. Its own records of the cards it sent and holds name them, so no workspace is woken to list
 * its shares.
 */
import type { UserCaller } from '@kinu.run/core';
import { idempotent } from '@nimbus-sh/fabric/do-calls.js';
import { logDoCallRetry } from '../obs/do-call-retry';
import type { ObjectNamespace } from '@kinu.run/core';
import type { UserDO } from './user-do';

export type ShareRosterAuthority = Pick<UserDO, 'shareCards_withdraw' | 'sharesReceived_forget' | 'shareRecipient_forget'>;

export interface SharesGivenEnv<Id> {
  UserDO: ObjectNamespace<Id, ShareRosterAuthority>;
}

/**
 * Must run before the account's own object is torn down, which takes its record of recipients with it. `recipients`
 * are its own card jobs withdrawn first (`shareCards_withdraw`), so none lands after the forget. Idempotent, so a
 * retried delete does no harm here.
 */
export async function forgetSharesGiven<Id>(
  env: SharesGivenEnv<Id>, userId: string, owner: UserCaller, recipients: readonly string[],
): Promise<{ recipients: number }> {
  for (const recipientId of recipients) {
    const recipient = env.UserDO.idFromName(recipientId);
    await idempotent('sharesReceived_forget', () => env.UserDO.get(recipient),
      (stub) => stub.sharesReceived_forget(owner, userId), { onRetry: logDoCallRetry });
  }

  return { recipients: recipients.length };
}

/**
 * Every account that shared with this one forgets it, in the workspaces that shared: their shares no longer admit it,
 * so the same email signed up again is a stranger to them, and their records of it name no one. `cards` are the cards
 * it holds, each naming its owner and workspace. Must run before its own object, which holds them, is torn down.
 */
export async function forgetSharesReceived<Id>(
  env: SharesGivenEnv<Id>, person: { readonly userId: string; readonly email: string }, owner: UserCaller,
  cards: readonly { readonly ownerUserId: string; readonly workspace: string }[],
): Promise<{ owners: number }> {
  const owners = new Map<string, string[]>();

  for (const card of cards) owners.set(card.ownerUserId, [...(owners.get(card.ownerUserId) ?? []), card.workspace]);

  for (const [ownerId, workspaces] of owners) {
    await idempotent('shareRecipient_forget', () => env.UserDO.get(env.UserDO.idFromName(ownerId)),
      (stub) => stub.shareRecipient_forget(owner, person, workspaces), { onRetry: logDoCallRetry });
  }

  return { owners: owners.size };
}
