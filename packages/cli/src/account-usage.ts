import {
  LimitCache, OPENROUTER_CRED_KEY, baseCredentialKey, credentialToHeaders, limitReadable, mergeAccountSpend,
  readAccountUsage, type AccountUsage, type LimitSource,
} from '@kinu.run/core';
import { attempt, diagnostics, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { getCloudAccountUsage } from './cloud-api';
import { createOAuthStore, listLocalRefsAllProjects, resolveCloudSession, resolveProviderCredentials } from './config';
import { getLocalAccountSpend } from './local-inspection';

function cloudAccountUsage(session: { origin: string; token: string }, refresh: boolean): Effect.Effect<AccountUsage> {
  const read = attempt(
    { doing: 'reading your cloud workspaces\' spend per account', otherwise: 'unavailable' },
    () => getCloudAccountUsage(session.origin, session.token, refresh),
  );

  return Effect.catch(read, (error) => Effect.sync((): AccountUsage => {
    diagnostics.failure('spend.cloud_usage_unread', error);

    return { accounts: [], workspaces: 0, unread: ['your cloud workspaces'] };
  }));
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

export function readAllAccountUsage(opts: { readonly refresh?: boolean } = {}): Promise<AccountUsage> {
  const session = resolveCloudSession();
  const names = listLocalRefsAllProjects().map((ref) => ref.name);

  return settle(Effect.gen(function* () {
    const [local, live, cloud] = yield* Effect.all([
      Effect.promise(() => readAccountUsage(names.map((name) => ({ name, read: async () => getLocalAccountSpend(name) })))),
      Effect.promise(() => LIMITS.read(localLimitSources(), { refresh: opts.refresh === true })),
      session === null ? Effect.succeed(null) : cloudAccountUsage(session, opts.refresh === true),
    ], { concurrency: 'unbounded' });

    const seen = new Set(live.limits.map((report) => `${report.provider}@${report.account}`));

    return {
      accounts: mergeAccountSpend([local.accounts, cloud?.accounts ?? []]),
      workspaces: local.workspaces + (cloud?.workspaces ?? 0),
      unread: [...local.unread, ...cloud?.unread ?? []],
      limits: [...live.limits, ...(cloud?.limits ?? []).filter((report) => !seen.has(`${report.provider}@${report.account}`))],
      limitsUnread: [...live.limitsUnread, ...(cloud?.limitsUnread ?? []).filter((entry) => !seen.has(`${entry.provider}@${entry.account}`))],
    };
  }));
}
