import {
  LimitCache, baseCredentialKey, limitReadable, readAccountUsage,
  type AccountUsage, type ObjectNamespace, type OwnerCapabilityEnv, type UserCaller,
} from '@kinu.run/core';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';
import { deviceRouteFetch } from '../egress/model-relay-route';

export type AccountLedgerTarget = Pick<OrchestratorAgent, 'accountSpend'>;

export interface AccountUsageEnv<Id> extends OwnerCapabilityEnv {
  OrchestratorAgent: ObjectNamespace<Id, AccountLedgerTarget>;
}

const LIMITS = new Map<string, LimitCache>();

export async function readUserAccountUsage<Id>(input: {
  readonly env: AccountUsageEnv<Id>;
  readonly userDO: Pick<UserDO, 'listActiveWorkspaces' | 'listCredentials' | 'getAuthHeaders' | 'relayDevice' | 'relayModelCall' | 'cancelModelRelay'>;
  readonly owner: UserCaller;
  readonly userId: string;
  readonly refresh?: boolean;
}): Promise<AccountUsage> {
  const { env, userDO, owner, userId } = input;
  const [workspaces, held] = await Promise.all([userDO.listActiveWorkspaces(owner), userDO.listCredentials(owner)]);

  for (const [holder, cached] of LIMITS) {
    cached.prune();

    if (cached.size === 0 && holder !== userId) LIMITS.delete(holder);
  }

  const cache = LIMITS.get(userId) ?? new LimitCache();

  LIMITS.set(userId, cache);
  // Codex's limits are read where its calls go: through the connected machine.
  const codex = deviceRouteFetch({ provider: 'codex', hub: userDO, caller: async () => owner });

  const [usage, live] = await Promise.all([
    readAccountUsage(workspaces.map(({ name }) => ({
      name,
      read: () => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(name)).accountSpend(),
    }))),
    cache.read(held.map(({ key }) => key).filter(limitReadable).map((key) => ({
      key,
      headers: () => userDO.getAuthHeaders(owner, key),
      ...(baseCredentialKey(key) === 'codex.oauth' && { fetch: codex }),
    })), { refresh: input.refresh === true }),
  ]);

  return { ...usage, limits: live.limits, limitsUnread: live.limitsUnread };
}
