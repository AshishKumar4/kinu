import {
  MAIN_ACCOUNT, OPENROUTER_CRED_KEY, accountOf, baseCredentialKey, credentialToHeaders, mergeAccountSpend,
  readAccountCredits, readAccountUsage, readOpenRouterCredit, type AccountUsage,
} from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { getCloudAccountUsage } from './cloud-api';
import { listLocalRefsAllProjects, listUnplacedAgentNames, resolveCloudSession, resolveProviderCredentials } from './config';
import { getLocalAccountSpend } from './local-inspection';

async function cloudAccountUsage(session: { origin: string; token: string }): Promise<AccountUsage> {
  try {
    return await getCloudAccountUsage(session.origin, session.token);
  } catch (cause) {
    diagnostics.failure('spend.cloud_usage_unread', toKinuError({
      doing: 'reading your cloud workspaces\' spend per account',
      cause,
      otherwise: 'unavailable',
    }));

    return { accounts: [], workspaces: 0, unread: ['your cloud workspaces'] };
  }
}

function localOpenRouterKeys(): Array<{ account: string; token: string }> {
  const { openrouterApiKey, apiKeyAccounts = {} } = resolveProviderCredentials();

  const named = Object.entries(apiKeyAccounts)
    .filter(([key]) => baseCredentialKey(key) === OPENROUTER_CRED_KEY)
    .map(([key, token]) => ({ account: accountOf(key), token }));

  return openrouterApiKey ? [{ account: MAIN_ACCOUNT, token: openrouterApiKey }, ...named] : named;
}

export async function readAllAccountUsage(): Promise<AccountUsage> {
  const session = resolveCloudSession();
  const names = [...listLocalRefsAllProjects().map((ref) => ref.name), ...listUnplacedAgentNames()];

  const [local, live, cloud] = await Promise.all([
    readAccountUsage(names.map((name) => ({ name, read: async () => getLocalAccountSpend(name) }))),
    readAccountCredits(localOpenRouterKeys().map(({ account, token }) => ({
      provider: 'openrouter',
      account,
      read: () => readOpenRouterCredit({ account, headers: credentialToHeaders(OPENROUTER_CRED_KEY, { kind: 'bearer', token }) }),
    }))),
    session === null ? null : cloudAccountUsage(session),
  ]);

  return {
    accounts: mergeAccountSpend([local.accounts, cloud?.accounts ?? []]),
    workspaces: local.workspaces + (cloud?.workspaces ?? 0),
    unread: [...local.unread, ...live.unread, ...cloud?.unread ?? []],
    credits: [...live.credits, ...cloud?.credits ?? []],
  };
}
