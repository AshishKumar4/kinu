// What an OpenRouter key has left, read live: openrouter.ai/docs/api/reference/limits (`GET /api/v1/key`).
import * as v from 'valibot';
import { KinuError } from '../obs/index';
import { fmtUsd } from '../utils/format';
import { OPENROUTER_BASE_URL } from './openrouter';

export interface AccountCredit {
  readonly provider: string;
  readonly account: string;
  readonly at: number;
  /** USD; null: no limit on this key. */
  readonly limit: number | null;
  readonly remaining: number | null;
  /** `daily`, `weekly` or `monthly`; null when the limit never resets. */
  readonly reset: string | null;
  readonly usedToday: number;
  readonly usedThisMonth: number;
}

export const AccountCreditSchema: v.GenericSchema<AccountCredit> = v.object({
  provider: v.string(),
  account: v.string(),
  at: v.number(),
  limit: v.nullable(v.number()),
  remaining: v.nullable(v.number()),
  reset: v.nullable(v.string()),
  usedToday: v.number(),
  usedThisMonth: v.number(),
});

const KeyInfoSchema = v.object({
  data: v.object({
    limit: v.nullable(v.number()),
    limit_remaining: v.nullable(v.number()),
    limit_reset: v.optional(v.nullable(v.string()), null),
    usage_daily: v.optional(v.number(), 0),
    usage_monthly: v.optional(v.number(), 0),
  }),
});

export async function readOpenRouterCredit(input: {
  readonly account: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
}): Promise<AccountCredit> {
  const response = await (input.fetch ?? fetch)(`${input.baseURL ?? OPENROUTER_BASE_URL}/key`, { headers: input.headers });

  if (!response.ok) {
    throw new KinuError('unavailable', `OpenRouter answered HTTP ${String(response.status)} for the ${input.account} key`);
  }

  const { data } = v.parse(KeyInfoSchema, await response.json());

  return {
    provider: 'openrouter',
    account: input.account,
    at: Date.now(),
    limit: data.limit,
    remaining: data.limit_remaining,
    reset: data.limit_reset,
    usedToday: data.usage_daily,
    usedThisMonth: data.usage_monthly,
  };
}

export function creditText(credit: AccountCredit): string {
  const reset = credit.reset === null ? '' : `, resets ${credit.reset}`;

  const left = credit.limit === null || credit.remaining === null
    ? 'no credit limit on this key'
    : `${fmtUsd(credit.remaining)} of ${fmtUsd(credit.limit)} left${reset}`;

  return `${left}; ${fmtUsd(credit.usedToday)} used today, ${fmtUsd(credit.usedThisMonth)} this month`;
}
