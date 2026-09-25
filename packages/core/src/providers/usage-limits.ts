// OMP ai/src/usage.
import * as v from 'valibot';
import { KinuError, diagnostics, renderThrownChain } from '../obs/index';
import { baseCredentialKey, accountOf } from '../credentials/accounts';
import { fmtSpan, fmtUsd } from '../utils/format';
import { OPENROUTER_BASE_URL } from './openrouter';
import { providerName } from './model-test';

export interface LimitWindow {
  readonly name: string;
  readonly usedPercent?: number;
  readonly used?: number;
  readonly limit?: number;
  readonly resetsAt?: number;
  readonly resets?: string;
}

export interface LimitReport {
  readonly provider: string;
  readonly account: string;
  readonly at: number;
  readonly windows: readonly LimitWindow[];
  readonly undocumented?: boolean;
}

const LimitWindowSchema = v.object({
  name: v.string(), usedPercent: v.optional(v.number()), used: v.optional(v.number()), limit: v.optional(v.number()),
  resetsAt: v.optional(v.number()), resets: v.optional(v.string()),
});

export const LimitReportSchema: v.GenericSchema<LimitReport> = v.object({
  provider: v.string(), account: v.string(), at: v.number(), windows: v.array(LimitWindowSchema), undocumented: v.optional(v.boolean()),
});

export interface LimitRead {
  readonly account: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
}

async function getJson<T>(schema: v.GenericSchema<T>, read: LimitRead, url: string, ask: { readonly headers: Readonly<Record<string, string>>; readonly what: string }): Promise<T> {
  const { headers, what } = ask;
  const response = await read.fetch(url, { headers: { accept: 'application/json', ...read.headers, ...headers }, ...(read.signal !== undefined && { signal: read.signal }) });

  if (!response.ok) throw new KinuError(response.status === 401 || response.status === 403 ? 'denied' : 'unavailable', `${what} answered HTTP ${String(response.status)} for the ${read.account} account`);

  return v.parse(schema, await response.json());
}

const isoMs = (value: string | null | undefined): number | undefined => {
  const at = value === undefined || value === null ? Number.NaN : Date.parse(value);

  return Number.isNaN(at) ? undefined : at;
};

const ClaudeBucketSchema = v.nullish(v.object({ utilization: v.nullish(v.number()), resets_at: v.nullish(v.string()) }));

const ClaudeUsageSchema = v.object({
  five_hour: ClaudeBucketSchema, seven_day: ClaudeBucketSchema, seven_day_opus: ClaudeBucketSchema, seven_day_sonnet: ClaudeBucketSchema,
});

async function claudeLimits(read: LimitRead): Promise<readonly LimitWindow[]> {
  const body = await getJson(ClaudeUsageSchema, read, 'https://api.anthropic.com/api/oauth/usage', { headers: { 'anthropic-beta': 'oauth-2025-04-20' }, what: 'Claude' });

  return ([['5h', body.five_hour], ['weekly', body.seven_day], ['weekly Opus', body.seven_day_opus], ['weekly Sonnet', body.seven_day_sonnet]] as const)
    .flatMap(([name, bucket]) => (bucket?.utilization === undefined || bucket.utilization === null ? [] : [{
      name, usedPercent: bucket.utilization, ...(isoMs(bucket.resets_at) !== undefined && { resetsAt: isoMs(bucket.resets_at) }),
    }]));
}

const CodexWindowSchema = v.nullish(v.object({
  used_percent: v.nullish(v.number()), limit_window_seconds: v.nullish(v.number()), reset_at: v.nullish(v.number()),
}));

const CodexUsageSchema = v.object({ rate_limit: v.nullish(v.object({ primary_window: CodexWindowSchema, secondary_window: CodexWindowSchema })) });

function windowName(seconds: number | null | undefined): string {
  if (seconds === 604_800) return 'weekly';

  return seconds === null || seconds === undefined ? 'window' : fmtSpan(seconds * 1_000).replaceAll(' ', '');
}

async function codexLimits(read: LimitRead): Promise<readonly LimitWindow[]> {
  const body = await getJson(CodexUsageSchema, read, 'https://chatgpt.com/backend-api/wham/usage', { headers: {}, what: 'ChatGPT' });

  return [body.rate_limit?.primary_window, body.rate_limit?.secondary_window].flatMap((window) => (
    window?.used_percent === undefined || window.used_percent === null ? [] : [{
      name: windowName(window.limit_window_seconds), usedPercent: window.used_percent,
      ...(window.reset_at !== undefined && window.reset_at !== null && { resetsAt: window.reset_at * 1_000 }),
    }]));
}

const OpenRouterKeySchema = v.object({
  data: v.object({ limit: v.nullable(v.number()), limit_remaining: v.nullable(v.number()), limit_reset: v.optional(v.nullable(v.string()), null) }),
});

async function openRouterLimits(read: LimitRead): Promise<readonly LimitWindow[]> {
  const { data } = await getJson(OpenRouterKeySchema, read, `${OPENROUTER_BASE_URL}/key`, { headers: {}, what: 'OpenRouter' });

  if (data.limit === null || data.limit_remaining === null) return [];

  return [{ name: 'credit', used: data.limit - data.limit_remaining, limit: data.limit, ...(data.limit_reset !== null && { resets: data.limit_reset }) }];
}

const OpenCodeGoWindowSchema = v.nullish(v.object({ percent: v.number(), resetsAt: v.nullish(v.string()) }));

// Undocumented.
const OpenCodeGoUsageSchema = v.object({ rolling: OpenCodeGoWindowSchema, weekly: OpenCodeGoWindowSchema, monthly: OpenCodeGoWindowSchema });

async function openCodeGoLimits(read: LimitRead): Promise<readonly LimitWindow[]> {
  const body = await getJson(OpenCodeGoUsageSchema, read, 'https://opencode.ai/zen/go/v1/usage', { headers: {}, what: 'OpenCode Go' });

  return ([['5h', body.rolling], ['weekly', body.weekly], ['monthly', body.monthly]] as const).flatMap(([name, window]) => (window === undefined || window === null ? [] : [{
    name, usedPercent: window.percent, ...(isoMs(window.resetsAt) !== undefined && { resetsAt: isoMs(window.resetsAt) }),
  }]));
}

const LIMIT_READERS = new Map<string, { readonly provider: string; readonly read: (read: LimitRead) => Promise<readonly LimitWindow[]>; readonly undocumented?: true }>([
  ['claude.oauth', { provider: 'claude', read: claudeLimits }],
  ['codex.oauth', { provider: 'codex', read: codexLimits }],
  ['openrouter.bearer', { provider: 'openrouter', read: openRouterLimits }],
  ['opencode-go.bearer', { provider: 'opencode-go', read: openCodeGoLimits, undocumented: true }],
]);

export function limitReadable(key: string): boolean {
  return LIMIT_READERS.has(baseCredentialKey(key));
}

export interface LimitSource {
  readonly key: string;
  readonly headers: () => Promise<Readonly<Record<string, string>> | null>;
  readonly fetch?: typeof fetch;
}

const LIMIT_TTL_MS = 5 * 60_000;

export class LimitCache {
  readonly #reports = new Map<string, LimitReport>();

  constructor(private readonly now: () => number = Date.now) {}

  async read(sources: readonly LimitSource[], opts: { readonly refresh?: boolean; readonly fetch?: typeof fetch } = {}): Promise<{
    readonly limits: LimitReport[];
    readonly unread: string[];
  }> {
    const readable = sources.filter((source) => limitReadable(source.key));

    const settled = await Promise.allSettled(readable.map(async (source): Promise<LimitReport> => {
      const cached = this.#reports.get(source.key);

      if (cached !== undefined && opts.refresh !== true && this.now() - cached.at < LIMIT_TTL_MS) return cached;
      const reader = LIMIT_READERS.get(baseCredentialKey(source.key));
      const headers = await source.headers();

      if (reader === undefined || headers === null) throw new KinuError('missing', `${source.key} is not connected`);
      const account = accountOf(source.key);
      const windows = await reader.read({ account, headers, fetch: source.fetch ?? opts.fetch ?? fetch });
      const report: LimitReport = { provider: reader.provider, account, at: this.now(), windows, ...(reader.undocumented && { undocumented: true }) };
      this.#reports.set(source.key, report);

      return report;
    }));

    const limits: LimitReport[] = [];
    const unread: string[] = [];

    for (const [index, outcome] of settled.entries()) {
      const source = readable[index];

      if (source === undefined) continue;

      if (outcome.status === 'fulfilled') {
        limits.push(outcome.value);
        continue;
      }

      diagnostics.failure('usage.limits_unread', new KinuError('unavailable', 'reading what a provider account has left', { cause: outcome.reason }), { key: source.key });
      const last = this.#reports.get(source.key);

      if (last !== undefined) limits.push(last);
      else unread.push(`${providerName(LIMIT_READERS.get(baseCredentialKey(source.key))?.provider ?? source.key)} · ${accountOf(source.key)} limits (${renderThrownChain({ cause: outcome.reason })})`);
    }

    return { limits, unread };
  }
}

const fmtPercent = (value: number): string => `${String(Math.round(value))}%`;

export function limitWindowText(window: LimitWindow, now: number): string {
  let amount: string;

  if (window.usedPercent !== undefined) amount = `${fmtPercent(window.usedPercent)} used · ${fmtPercent(Math.max(0, 100 - window.usedPercent))} left`;
  else if (window.limit !== undefined && window.used !== undefined) amount = `${fmtUsd(window.used)} used · ${fmtUsd(Math.max(0, window.limit - window.used))} of ${fmtUsd(window.limit)} left`;
  else amount = 'no limit reported';

  if (window.resetsAt === undefined) return window.resets === undefined ? `${window.name}  ${amount}` : `${window.name}  ${amount} · resets ${window.resets}`;

  if (window.resetsAt <= now) return `${window.name}  ${amount} · reset since`;
  const at = new Date(window.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

  return `${window.name}  ${amount} · resets ${at} (in ${fmtSpan(window.resetsAt - now)})`;
}

export function limitHeading(report: LimitReport, now: number): string {
  const age = now - report.at > 60_000 ? ` · as of ${fmtSpan(now - report.at)} ago` : '';

  return `${providerName(report.provider)} · ${report.account}${age}${report.undocumented === true ? ' · undocumented source' : ''}`;
}

export function limitLines(limits: readonly LimitReport[], now: number): string[] {
  if (limits.length === 0) return [];

  return ['Limits, read from each provider', ...limits.flatMap((report) => [
    `  ${limitHeading(report, now)}`,
    ...(report.windows.length === 0 ? ['    no limit reported'] : report.windows.map((window) => `    ${limitWindowText(window, now)}`)),
  ])];
}
