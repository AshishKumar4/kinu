import {
  LimitCache, baseCredentialKey, limitReadable, readAccountUsage,
  type AccountUsage, type ObjectNamespace, type OwnerCapabilityEnv, type UserCaller,
} from '@kinu.run/core';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';
import { codexEgressFetch, type CodexEgressNamespace } from '../egress/codex-egress-route';

export type AccountLedgerTarget = Pick<OrchestratorAgent, 'accountSpend'>;

export interface AccountUsageEnv<Id> extends OwnerCapabilityEnv {
  OrchestratorAgent: ObjectNamespace<Id, AccountLedgerTarget>;
  CodexEgress?: CodexEgressNamespace;
}

const LIMITS = new Map<string, LimitCache>();

export async function readUserAccountUsage<Id>(input: {
  readonly env: AccountUsageEnv<Id>;
  readonly userDO: Pick<UserDO, 'listActiveWorkspaces' | 'listCredentials' | 'getAuthHeaders'>;
  readonly owner: UserCaller;
  readonly userId: string;
  readonly refresh?: boolean;
}): Promise<AccountUsage> {
  const { env, userDO, owner, userId } = input;
  const [workspaces, held] = await Promise.all([userDO.listActiveWorkspaces(owner), userDO.listCredentials(owner)]);
  const cache = LIMITS.get(userId) ?? new LimitCache();

  LIMITS.set(userId, cache);
  const codex = env.CodexEgress === undefined ? undefined : codexEgressFetch(env.CodexEgress, userId);

  const [usage, live] = await Promise.all([
    readAccountUsage(workspaces.map(({ name }) => ({
      name,
      read: () => env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(name)).accountSpend(),
    }))),
    cache.read(held.map(({ key }) => key).filter(limitReadable).map((key) => ({
      key,
      headers: () => userDO.getAuthHeaders(owner, key),
      ...(baseCredentialKey(key) === 'codex.oauth' && codex !== undefined && { fetch: codex }),
    })), { refresh: input.refresh === true }),
  ]);

  return { ...usage, unread: [...usage.unread, ...live.unread], limits: live.limits };
}
