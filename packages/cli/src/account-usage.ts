import {
  LimitCache, OPENROUTER_CRED_KEY, baseCredentialKey, credentialToHeaders, limitReadable, mergeAccountSpend,
  readAccountUsage, type AccountUsage, type LimitSource,
} from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { getCloudAccountUsage } from './cloud-api';
import { createOAuthStore, listLocalRefsAllProjects, listUnplacedAgentNames, resolveCloudSession, resolveProviderCredentials } from './config';
import { getLocalAccountSpend } from './local-inspection';

async function cloudAccountUsage(session: { origin: string; token: string }, refresh: boolean): Promise<AccountUsage> {
  try {
    return await getCloudAccountUsage(session.origin, session.token, refresh);
  } catch (cause) {
    diagnostics.failure('spend.cloud_usage_unread', toKinuError({
      doing: 'reading your cloud workspaces\' spend per account',
      cause,
      otherwise: 'unavailable',
    }));

    return { accounts: [], workspaces: 0, unread: ['your cloud workspaces'] };
  }
}

function localLimitSources(): LimitSource[] {
  const store = createOAuthStore();
  const { openrouterApiKey, apiKeyAccounts = {} } = resolveProviderCredentials();

  const keys = [
    ...(openrouterApiKey ? [[OPENROUTER_CRED_KEY, openrouterApiKey] as const] : []),
    ...Object.entries(apiKeyAccounts).filter(([key]) => baseCredentialKey(key) === OPENROUTER_CRED_KEY),
  ];

  return [
    ...store.keys().filter(limitReadable).map((key): LimitSource => ({ key, headers: async () => (await store.getAuth(key))?.headers ?? null })),
    ...keys.map(([key, token]): LimitSource => ({ key, headers: async () => credentialToHeaders(OPENROUTER_CRED_KEY, { kind: 'bearer', token }) })),
  ];
}

const LIMITS = new LimitCache();

export async function readAllAccountUsage(opts: { readonly refresh?: boolean } = {}): Promise<AccountUsage> {
  const session = resolveCloudSession();
  const names = [...listLocalRefsAllProjects().map((ref) => ref.name), ...listUnplacedAgentNames()];

  const [local, live, cloud] = await Promise.all([
    readAccountUsage(names.map((name) => ({ name, read: async () => getLocalAccountSpend(name) }))),
    LIMITS.read(localLimitSources(), { refresh: opts.refresh === true }),
    session === null ? null : cloudAccountUsage(session, opts.refresh === true),
  ]);

  const seen = new Set(live.limits.map((report) => `${report.provider}@${report.account}`));

  return {
    accounts: mergeAccountSpend([local.accounts, cloud?.accounts ?? []]),
    workspaces: local.workspaces + (cloud?.workspaces ?? 0),
    unread: [...local.unread, ...cloud?.unread ?? []],
    limits: [...live.limits, ...(cloud?.limits ?? []).filter((report) => !seen.has(`${report.provider}@${report.account}`))],
    limitsUnread: [...live.limitsUnread, ...(cloud?.limitsUnread ?? []).filter((entry) => !seen.has(`${entry.provider}@${entry.account}`))],
  };
}
