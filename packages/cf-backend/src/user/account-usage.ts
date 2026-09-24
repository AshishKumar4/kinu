import { readAccountUsage, type AccountUsage, type ObjectNamespace, type OwnerCapabilityEnv, type UserCaller } from '@kinu.run/core';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';

export type AccountLedgerTarget = Pick<OrchestratorAgent, 'accountSpend'>;

export interface AccountUsageEnv<Id> extends OwnerCapabilityEnv {
  OrchestratorAgent: ObjectNamespace<Id, AccountLedgerTarget>;
}

export async function readUserAccountUsage<Id>(
  env: AccountUsageEnv<Id>,
  userDO: Pick<UserDO, 'listActiveWorkspaces'>,
  owner: UserCaller,
): Promise<AccountUsage> {
  const workspaces = await userDO.listActiveWorkspaces(owner);

  return readAccountUsage(workspaces.map(({ name }) => ({
    name,
    read: () => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(name)).accountSpend(),
  })));
}
