/**
 * The account-delete sweep of shares an account has given: every account it sent a card is told to forget them.
 * The account's own record of what it sent names them, so no workspace is woken to list its shares.
 */
import type { UserCaller } from '@kinu.run/core';
import { idempotent } from '@nimbus-sh/fabric/do-calls.js';
import { logDoCallRetry } from '../obs/do-call-retry';
import type { ObjectNamespace } from '@kinu.run/core';
import type { UserDO } from './user-do';

export type ShareRosterAuthority = Pick<UserDO, 'shareCards_withdraw' | 'sharesReceived_forget'>;

export interface SharesGivenEnv<Id> {
  UserDO: ObjectNamespace<Id, ShareRosterAuthority>;
}

/**
 * Must run before the account's own object is torn down, which takes its record of recipients with it. Its card jobs
 * are withdrawn first, so none lands after the forget. Idempotent, so a retried delete does no harm here.
 */
export async function forgetSharesGiven<Id>(env: SharesGivenEnv<Id>, userId: string, owner: UserCaller): Promise<{ recipients: number }> {
  const recipients = await env.UserDO.get(env.UserDO.idFromName(userId)).shareCards_withdraw(owner);

  for (const recipientId of recipients) {
    const recipient = env.UserDO.idFromName(recipientId);
    await idempotent('sharesReceived_forget', () => env.UserDO.get(recipient),
      (stub) => stub.sharesReceived_forget(owner, userId), { onRetry: logDoCallRetry });
  }

  return { recipients: recipients.length };
}
