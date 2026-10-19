/**
 * A collaborator's own `workspace.ai`, run in their own account: the tier their catalog names, the provider their
 * credentials reach, the spend theirs. A slate room calls it for a run holding that person's own AI grant
 * (`SlateRoom.transport`); the call itself is the one slate AI path (`slates/slate-ai.ts`) the owner's runs too.
 */
import * as v from 'valibot';
import {
  accountSpendOfCall, DEFAULT_ROLE_ID, pricedModelCallEvent, loadProfileAuthorityInputs, ModelCatalogSession, resolveTurnProfile, specModelInfo,
  type AccountSpend, type ModelCallReport, type ProfileCatalogEnvelope, type SlateSurfaceValue, type Usage, type UserCaller,
} from '@kinu.run/core';
import { recordModelRow } from '@kinu.run/core/analytics';
import { OwnedModelServices, type OwnedModelEnv } from '../owned-model-services';
import { slateAiAnswer, type SlateAiRoute } from '@kinu.run/core/slates';

/** What of the account the call reads and writes: its name, catalog and credentials' revision, and its own spend. */
export interface AccountSlateAiHost<Id> {
  readonly env: OwnedModelEnv<Id> & Parameters<typeof recordModelRow>[0];
  readonly accountId: string;
  readonly catalog: (caller: UserCaller) => Promise<ProfileCatalogEnvelope>;
  readonly credentialsRevision: (caller: UserCaller) => Promise<number>;
  /** Keeps one call's spend where the account's usage reads it (`slate_ai_spend`). */
  readonly spent: (spend: AccountSpend) => void;
}

/** The account's model services for one call: its own registry, keyed to the room's workspace for prompt caching. */
function accountServices<Id>(host: AccountSlateAiHost<Id>, caller: UserCaller, workspace: string, record: (report: ModelCallReport) => void): OwnedModelServices<Id> {
  return new OwnedModelServices({
    env: host.env,
    agentName: () => `slate-ai:${host.accountId}`,
    workspaceId: () => workspace,
    workspaceName: () => workspace,
    appTitle: 'Kinu',
    ownerRequired: true,
    getOwnerUserId: () => host.accountId,
    getUserCaller: async () => caller,
    getCredentialsRevision: async () => host.credentialsRevision(caller),
    reportModelCall: record,
  });
}

/**
 * A collaborator's slate AI call, priced as every model call is (`pricedModelCallEvent` over the account's own provider
 * catalog), kept in the account's spend, and counted with every model call.
 */
function recordSlateAi<Id>(host: AccountSlateAiHost<Id>, workspace: string, report: ModelCallReport, pricing: ModelCatalogSession): void {
  const event = pricedModelCallEvent(report, pricing);
  const spec = report.spec ?? '';
  const cut = spec.indexOf('/');

  host.spent(accountSpendOfCall(event));
  recordModelRow(host.env, {
    workspace, agentKind: '', provider: cut < 0 ? spec : spec.slice(0, cut), model: report.modelId ?? (cut < 0 ? '' : spec.slice(cut + 1)),
    source: report.source, usage: report.usage, usd: event.usd,
  });
}

/** One `ai.run` or `ai.stream`, resolved and run as this account's own: no tier, model or key of the slate owner's. */
export async function accountSlateAi<Id>(host: AccountSlateAiHost<Id>, caller: UserCaller, request: { readonly workspace: string; readonly route: SlateAiRoute }): Promise<SlateSurfaceValue> {
  const { workspace } = request;

  // The rate is the account's own provider catalog's, read as a workspace reads its model's (`ActorAgent.catalogEntry`).
  const pricing = new ModelCatalogSession({
    effectiveSpec: () => '', lookup: async (spec) => specModelInfo(services.providerRegistry().registry, services.providerRegistry().deps, spec), measured: () => null,
  });

  const record = (report: ModelCallReport): void => { recordSlateAi(host, workspace, report, pricing); };

  const services = accountServices(host, caller, workspace, record);
  const inputs = await loadProfileAuthorityInputs({ envelope: async () => host.catalog(caller), provider: async () => services.profileProviderSnapshot() });

  const profile = resolveTurnProfile({
    ...inputs, roleId: DEFAULT_ROLE_ID, explicitTier: request.route.tier, workMode: 'build', availableTools: [], activeSkills: [],
  });

  await pricing.warm([profile.tier.model]);

  return slateAiAnswer(request.route, { spec: profile.tier.model, tier: profile.tier.id }, {
    resolveModel: (spec) => services.resolveModel(spec), report: record, operations: () => {},
  });
}

/** The tally's usage columns, each with the `Usage` field it sums. */
const USAGE_COLUMNS = [
  ['input', 'input'], ['output', 'output'], ['cacheRead', 'cache_read'], ['cacheWrite', 'cache_write'],
  ['cacheWrite1h', 'cache_write_1h'], ['reasoning', 'reasoning'], ['neurons', 'neurons'],
] as const satisfies readonly (readonly [keyof Usage, string])[];

const Count = v.nullable(v.number());

const TallyRow = v.object({
  provider: v.string(), account: v.string(), calls: v.number(), calls_without_usage: v.number(), unpriced_calls: v.number(), usd: Count,
  input: Count, output: Count, cache_read: Count, cache_write: Count, cache_write_1h: Count, reasoning: Count, neurons: Count,
});

/** A null that adds nothing, and a sum otherwise: what each nullable column of the tally does with a call's value. */
const added = (column: string): string => `${column} = CASE WHEN excluded.${column} IS NULL THEN ${column} ELSE COALESCE(${column}, 0) + excluded.${column} END`;

/** Adds one call's spend to its provider account's row of the tally (`slate_ai_spend`). */
export function addSlateAiSpend(sql: SqlStorage, spend: AccountSpend): void {
  const columns = USAGE_COLUMNS.map(([, column]) => column);

  sql.exec(
    `INSERT INTO slate_ai_spend (provider, account, calls, calls_without_usage, unpriced_calls, usd, ${columns.join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, ${columns.map(() => '?').join(', ')})
     ON CONFLICT (provider, account) DO UPDATE SET calls = calls + excluded.calls, calls_without_usage = calls_without_usage + excluded.calls_without_usage,
       unpriced_calls = unpriced_calls + excluded.unpriced_calls, ${['usd', ...columns].map(added).join(', ')}`,
    spend.provider ?? '', spend.account ?? '', spend.calls, spend.callsWithoutUsage, spend.unpricedCalls, spend.usd ?? null,
    ...USAGE_COLUMNS.map(([field]) => spend.usage[field] ?? null),
  );
}

/** The tally, one `AccountSpend` per provider account, as `mergeAccountSpend` takes a workspace's ledger. */
export function slateAiSpendOf(sql: SqlStorage): AccountSpend[] {
  return sql.exec('SELECT * FROM slate_ai_spend').toArray().map((raw) => {
    const row = v.parse(TallyRow, raw);
    const usage: Record<string, number> = {};

    for (const [field, column] of USAGE_COLUMNS) {
      const value = row[column];

      if (value !== null) usage[field] = value;
    }

    return {
      provider: row.provider === '' ? null : row.provider, account: row.account === '' ? null : row.account, calls: row.calls,
      callsWithoutUsage: row.calls_without_usage, unpricedCalls: row.unpriced_calls, usage, ...(row.usd !== null && { usd: row.usd }),
    };
  });
}
