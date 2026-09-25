import {
  accountOf, baseCredentialKey, OPENROUTER_CRED_KEY, readAccountCredits, readAccountUsage, readOpenRouterCredit,
  type AccountUsage, type ObjectNamespace, type OwnerCapabilityEnv, type UserCaller,
} from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';

export type AccountLedgerTarget = Pick<OrchestratorAgent, 'accountSpend'>;

export interface AccountUsageEnv<Id> extends OwnerCapabilityEnv {
  OrchestratorAgent: ObjectNamespace<Id, AccountLedgerTarget>;
}

export async function readUserAccountUsage<Id>(
  env: AccountUsageEnv<Id>,
  userDO: Pick<UserDO, 'listActiveWorkspaces' | 'listCredentials' | 'getAuthHeaders'>,
  owner: UserCaller,
): Promise<AccountUsage> {
  const [workspaces, held] = await Promise.all([userDO.listActiveWorkspaces(owner), userDO.listCredentials(owner)]);
  const openRouterKeys = held.map((credential) => credential.key).filter((key) => baseCredentialKey(key) === OPENROUTER_CRED_KEY);

  const [usage, live] = await Promise.all([
    readAccountUsage(workspaces.map(({ name }) => ({
      name,
      read: () => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(name)).accountSpend(),
    }))),
    readAccountCredits(openRouterKeys.map((key) => ({
      provider: 'openrouter',
      account: accountOf(key),
      async read() {
        const headers = await userDO.getAuthHeaders(owner, key);

        if (headers === null) throw new KinuError('missing', `${key} is not connected`);

        return readOpenRouterCredit({ account: accountOf(key), headers });
      },
    }))),
  ]);

  return { ...usage, unread: [...usage.unread, ...live.unread], credits: live.credits };
}
