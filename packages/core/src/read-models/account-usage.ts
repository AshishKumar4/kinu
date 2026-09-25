import * as v from 'valibot';
import type { AccountSpend } from '../events/model-call';
import { QuotaSnapshotSchema, type QuotaSnapshot } from '../providers/quota';
import { LimitReportSchema, LimitUnreadSchema, type LimitReport, type LimitUnread } from '../providers/usage-limits';
import { diagnostics, toKinuError } from '../obs/index';
import { addUsage, usageTotal, UsageSchema } from '../usage';

export interface AccountUsage {
  readonly accounts: readonly AccountSpend[];
  readonly workspaces: number;
  /** Never counted as zero spend. */
  readonly unread: readonly string[];
  readonly limits?: readonly LimitReport[];
  readonly limitsUnread?: readonly LimitUnread[];
}

export const AccountSpendSchema: v.GenericSchema<AccountSpend> = v.object({
  provider: v.nullable(v.string()), account: v.nullable(v.string()), calls: v.number(), callsWithoutUsage: v.number(),
  usage: UsageSchema, usd: v.optional(v.number()), unpricedCalls: v.number(),
  quota: v.optional(QuotaSnapshotSchema),
});

export const AccountUsageSchema: v.GenericSchema<AccountUsage> = v.object({
  accounts: v.array(AccountSpendSchema), workspaces: v.number(), unread: v.array(v.string()),
  limits: v.optional(v.array(LimitReportSchema)),
  limitsUnread: v.optional(v.array(LimitUnreadSchema)),
});

export function sortAccountSpend(rows: readonly AccountSpend[]): AccountSpend[] {
  return [...rows].sort((a, b) => (a.provider === null ? 1 : 0) - (b.provider === null ? 1 : 0)
    || (usageTotal(b.usage) ?? -1) - (usageTotal(a.usage) ?? -1));
}

function newer(a: QuotaSnapshot | undefined, b: QuotaSnapshot | undefined): QuotaSnapshot | undefined {
  if (a === undefined) return b;

  return b === undefined || a.at >= b.at ? a : b;
}

function sumUsd(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;

  return b === undefined ? a : a + b;
}

function addAccountSpend(a: AccountSpend, b: AccountSpend): AccountSpend {
  const usd = sumUsd(a.usd, b.usd);
  const quota = newer(a.quota, b.quota);

  const sum: AccountSpend = {
    provider: a.provider,
    account: a.account,
    calls: a.calls + b.calls,
    callsWithoutUsage: a.callsWithoutUsage + b.callsWithoutUsage,
    usage: addUsage(a.usage, b.usage),
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
  };

  return { ...sum, ...(usd !== undefined && { usd }), ...(quota !== undefined && { quota }) };
}

export function mergeAccountSpend(ledgers: readonly (readonly AccountSpend[])[]): AccountSpend[] {
  const merged = new Map<string, AccountSpend>();

  for (const row of ledgers.flat()) {
    const key = JSON.stringify([row.provider, row.account]);
    const held = merged.get(key);
    merged.set(key, held === undefined ? row : addAccountSpend(held, row));
  }

  return sortAccountSpend([...merged.values()]);
}

export interface AccountLedgerSource {
  readonly name: string;
  read(): Promise<readonly AccountSpend[]>;
}

export async function readAccountUsage(sources: readonly AccountLedgerSource[]): Promise<AccountUsage> {
  const settled = await Promise.allSettled(sources.map((source) => source.read()));
  const ledgers: (readonly AccountSpend[])[] = [];
  const unread: string[] = [];

  for (const [index, outcome] of settled.entries()) {
    const name = sources[index]?.name ?? '';

    if (outcome.status === 'fulfilled') {
      ledgers.push(outcome.value);
      continue;
    }

    unread.push(name);
    diagnostics.failure('spend.account_ledger_unread', toKinuError({
      doing: 'reading a workspace\'s spend per account',
      cause: outcome.reason,
      otherwise: 'unavailable',
    }), { workspace: name });
  }

  return { accounts: mergeAccountSpend(ledgers), workspaces: ledgers.length, unread };
}
