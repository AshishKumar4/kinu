// Analytics Engine SQL transport only; queries come from `analytics/query.ts`. REST because the
// dataset binding has no read side. Aggregates are sample-weighted upstream, so never post-process a number.
import { diagnostics, renderThrownChain, toKinuError, type KinuError } from '../obs/index';
import * as v from 'valibot';

const SQL_API = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

export interface AnalyticsSqlEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_SQL_API_TOKEN?: string;
}

/** `unconfigured` is not `failed`: a missing token must not look like an outage. */
export type AnalyticsResult =
  | { readonly status: 'ok'; readonly rows: readonly AnalyticsRow[] }
  | { readonly status: 'unconfigured'; readonly missing: readonly string[] }
  | { readonly status: 'failed'; readonly reason: string };

export type AnalyticsRow = Record<string, string | number | boolean | null>;

const AnalyticsCellSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

const SqlResponseSchema = v.object({
  data: v.array(v.record(v.string(), AnalyticsCellSchema)),
});

// `errors` is required so a non-envelope body (valibot reads arrays as objects) fails to parse.
const SqlErrorSchema = v.object({
  errors: v.array(v.object({ message: v.optional(v.string()) })),
});

type SqlErrorEnvelope = v.InferOutput<typeof SqlErrorSchema>;

export function analyticsMissingSettings(env: AnalyticsSqlEnv): readonly string[] {
  const missing: string[] = [];

  if (!(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim()) missing.push('CLOUDFLARE_ACCOUNT_ID');

  if (!(env.ANALYTICS_SQL_API_TOKEN ?? '').trim()) missing.push('ANALYTICS_SQL_API_TOKEN');

  return missing;
}

const BATCH_TTL_MS = 30_000;

export type AnalyticsQuerySet = ReadonlyMap<string, string>;

export type AnalyticsPanels = Record<string, AnalyticsResult>;

interface CachedBatch {
  readonly at: number;
  readonly result: Promise<AnalyticsPanels>;
}

// Isolate-level is safe: account-wide aggregates only, nothing per-user. Stores the promise so
// concurrent loads share one round trip.
const batches = new Map<string, CachedBatch>();

const BATCH_CACHE_MAX = 64;

async function runAnalyticsSql(env: AnalyticsSqlEnv, sql: string): Promise<AnalyticsResult> {
  const missing = analyticsMissingSettings(env);

  if (missing.length > 0) return { status: 'unconfigured', missing };

  try {
    const response = await fetch(SQL_API((env.CLOUDFLARE_ACCOUNT_ID ?? '').trim()), {
      method: 'POST',
      headers: {
        // The API takes the query as the raw request body, not as JSON.
        'authorization': `Bearer ${(env.ANALYTICS_SQL_API_TOKEN ?? '').trim()}`,
        'content-type': 'text/plain',
      },
      body: sql,
    });

    const text = await response.text();

    if (!response.ok) {
      return { status: 'failed', reason: apiErrorReason(response.status, text) };
    }

    const parsed = v.safeParse(SqlResponseSchema, JSON.parse(text));

    if (!parsed.success) {
      return { status: 'failed', reason: 'the analytics API returned a shape this reader does not recognize' };
    }

    return { status: 'ok', rows: parsed.output.data };
  } catch (cause) {
    diagnostics.failure('control_plane.analytics_query_failed', toKinuError({
      doing: 'querying the Analytics Engine SQL API',
      cause,
      otherwise: 'unavailable',
    }));

    return { status: 'failed', reason: renderThrownChain({ cause }) };
  }
}

// Distinguishes an API refusal from a body the API never produced (proxy/HTML): different fixes.
type ErrorBody =
  | { readonly status: 'envelope'; readonly envelope: SqlErrorEnvelope }
  | { readonly status: 'unreadable'; readonly failure: KinuError; readonly bytes: number };

function errorBodyOf(text: string): ErrorBody {
  try {
    return { status: 'envelope', envelope: v.parse(SqlErrorSchema, JSON.parse(text)) };
  } catch (cause) {
    return {
      status: 'unreadable',
      failure: toKinuError({
        doing: 'decoding an analytics API error body',
        cause,
        otherwise: 'bad_input',
      }),
      bytes: text.length,
    };
  }
}

function apiErrorReason(status: number, body: string): string {
  const decoded = errorBodyOf(body);

  if (decoded.status === 'unreadable') {
    diagnostics.failure('control_plane.analytics_error_body_unreadable', decoded.failure, {
      status, bytes: decoded.bytes,
    });

    return `analytics API ${String(status)}: the body was not the documented error envelope `
      + `(${String(decoded.bytes)} bytes)`;
  }

  const message = decoded.envelope.errors[0]?.message;

  return message !== undefined && message.length > 0
    ? `analytics API ${String(status)}: ${message}`
    : `analytics API ${String(status)}`;
}

export async function runAnalyticsBatch(
  env: AnalyticsSqlEnv,
  queries: AnalyticsQuerySet,
  now: number = Date.now(),
): Promise<AnalyticsPanels> {
  const named = [...queries.entries()].sort(([a], [b]) => a.localeCompare(b));
  const key = named.map(([name, sql]) => `${name}\u0000${sql}`).join('\u0001');
  const cached = batches.get(key);

  if (cached && now - cached.at < BATCH_TTL_MS) return cached.result;

  // Eviction inside the fill: an outer `.catch` would either swallow or leave an unhandled rejection.
  const result = (async (): Promise<AnalyticsPanels> => {
    try {
      const answers = await Promise.all(
        named.map(async ([name, sql]) => [name, await runAnalyticsSql(env, sql)] as const),
      );

      return Object.fromEntries(answers);
    } catch (cause) {
      // Never cache a rejected fill.
      batches.delete(key);
      throw toKinuError({
        doing: 'filling a control-plane analytics batch',
        cause,
        otherwise: 'unavailable',
      });
    }
  })();

  if (batches.size >= BATCH_CACHE_MAX) batches.clear();
  batches.set(key, { at: now, result });

  return result;
}

export function clearAnalyticsCache(): void {
  batches.clear();
}
