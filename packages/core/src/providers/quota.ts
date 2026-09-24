import * as v from 'valibot';
import { accountOf, splitAccount } from '../credentials/accounts';
import { fmtTokens } from '../utils/format';

const CALL_ACCOUNT_HEADER = 'x-kinu-account';

export interface QuotaWindow {
  readonly measure: string;
  readonly limit?: number;
  readonly remaining?: number;
  readonly usedPercent?: number;
  readonly resetsAt?: number;
}

export interface QuotaSnapshot {
  readonly at: number;
  readonly windows: readonly QuotaWindow[];
}

export interface CallAccount {
  readonly provider: string;
  readonly name: string;
  readonly quota?: QuotaSnapshot;
}

export const QuotaSnapshotSchema = v.object({
  at: v.number(),
  windows: v.array(v.object({
    measure: v.string(),
    limit: v.optional(v.number()),
    remaining: v.optional(v.number()),
    usedPercent: v.optional(v.number()),
    resetsAt: v.optional(v.number()),
  })),
});

export const CallAccountSchema = v.object({ provider: v.string(), name: v.string(), quota: v.optional(QuotaSnapshotSchema) });

export function withCallAccount(response: Response, provider: string, credentialKey: string): Response {
  const headers = new Headers(response.headers);
  headers.set(CALL_ACCOUNT_HEADER, `${provider}@${accountOf(credentialKey)}`);

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

type HeaderRead = (name: string) => string | undefined;

function count(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

const DURATION_UNIT_MS = new Map([['ms', 1], ['s', 1_000], ['m', 60_000], ['h', 3_600_000]]);

function durationMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  let total = 0;
  let matched = false;

  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(amount) * (DURATION_UNIT_MS.get(unit ?? '') ?? 0);
    matched = true;
  }

  return matched ? total : undefined;
}

function quotaWindow(measure: string, facts: Omit<QuotaWindow, 'measure'>): QuotaWindow[] {
  const reported = [facts.limit, facts.remaining, facts.usedPercent, facts.resetsAt].some((value) => value !== undefined);

  return reported ? [{ measure, ...facts }] : [];
}

function anthropicWindows(read: HeaderRead): QuotaWindow[] {
  return ['requests', 'tokens', 'input-tokens', 'output-tokens'].flatMap((measure) => {
    const reset = Date.parse(read(`anthropic-ratelimit-${measure}-reset`) ?? '');

    return quotaWindow(measure, {
      limit: count(read(`anthropic-ratelimit-${measure}-limit`)),
      remaining: count(read(`anthropic-ratelimit-${measure}-remaining`)),
      resetsAt: Number.isNaN(reset) ? undefined : reset,
    });
  });
}

const CLAUDE_WINDOWS = [{ window: '5h', measure: '300m' }, { window: '7d', measure: '10080m' }] as const;

function claudeWindows(read: HeaderRead): QuotaWindow[] {
  return CLAUDE_WINDOWS.flatMap(({ window, measure }) => {
    const used = count(read(`anthropic-ratelimit-unified-${window}-utilization`));
    const reset = count(read(`anthropic-ratelimit-unified-${window}-reset`));

    return quotaWindow(measure, {
      usedPercent: used === undefined ? undefined : used * 100,
      resetsAt: reset === undefined ? undefined : reset * 1_000,
    });
  });
}

function openaiWindows(read: HeaderRead, at: number): QuotaWindow[] {
  return ['requests', 'tokens'].flatMap((measure) => {
    const resetIn = durationMs(read(`x-ratelimit-reset-${measure}`));

    return quotaWindow(measure, {
      limit: count(read(`x-ratelimit-limit-${measure}`)),
      remaining: count(read(`x-ratelimit-remaining-${measure}`)),
      resetsAt: resetIn === undefined ? undefined : at + resetIn,
    });
  });
}

function codexWindows(read: HeaderRead): QuotaWindow[] {
  return ['primary', 'secondary'].flatMap((slot) => {
    const minutes = count(read(`x-codex-${slot}-window-minutes`));
    const resetAt = count(read(`x-codex-${slot}-reset-at`));

    return quotaWindow(minutes === undefined ? slot : `${String(minutes)}m`, {
      usedPercent: count(read(`x-codex-${slot}-used-percent`)),
      resetsAt: resetAt === undefined ? undefined : resetAt * 1_000,
    });
  });
}

export function callAccountOf(response: { readonly headers?: Readonly<Record<string, string>> | undefined }): CallAccount | undefined {
  const lower = new Map(Object.entries(response.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const read: HeaderRead = (name) => lower.get(name);
  const stamped = splitAccount(read(CALL_ACCOUNT_HEADER) ?? '');

  if (stamped.account === null) return undefined;
  const served = Date.parse(read('date') ?? '');
  const at = Number.isNaN(served) ? Date.now() : served;
  const windows = [...anthropicWindows(read), ...claudeWindows(read), ...openaiWindows(read, at), ...codexWindows(read)];

  return windows.length === 0
    ? { provider: stamped.base, name: stamped.account }
    : { provider: stamped.base, name: stamped.account, quota: { at, windows } };
}

const SPAN_UNITS: ReadonlyArray<readonly [string, number]> = [['d', 86_400], ['h', 3_600], ['m', 60], ['s', 1]];

function fmtSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  const index = SPAN_UNITS.findIndex(([, size]) => seconds >= size);
  const major = SPAN_UNITS[index];

  if (major === undefined) return '0s';
  const minor = SPAN_UNITS[index + 1];
  const minorCount = minor === undefined ? 0 : Math.floor((seconds % major[1]) / minor[1]);
  const head = `${String(Math.floor(seconds / major[1]))}${major[0]}`;

  return minor === undefined || minorCount === 0 ? head : `${head} ${String(minorCount)}${minor[0]}`;
}

export function quotaWindowText(window: QuotaWindow, now: number): string {
  const minutes = /^(\d+)m$/.exec(window.measure)?.[1];

  const slot = window.measure === 'primary' || window.measure === 'secondary' ? window.measure : null;
  const plan = minutes === undefined ? slot : fmtSpan(Number(minutes) * 60_000);
  const noun = plan === null ? window.measure.replaceAll('-', ' ') : `the ${plan} window`;

  const left = window.limit === undefined ? `${fmtTokens(window.remaining)} ${noun} left` : `${fmtTokens(window.remaining)} of ${fmtTokens(window.limit)} ${noun} left`;
  const amount = window.usedPercent === undefined ? left : `${String(Math.round(window.usedPercent))}% of ${noun} used`;

  if (window.resetsAt === undefined) return amount;

  return window.resetsAt <= now ? `${amount}, window reset since` : `${amount}, resets in ${fmtSpan(window.resetsAt - now)}`;
}
