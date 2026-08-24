/**
 * The Analytics Engine SQL API transport.
 *
 * This file owns HOW to ask and knows nothing about WHAT to ask: not a dataset
 * name, not a column position, not an aggregate. The SQL arrives as text from
 * `analytics/query.ts`, which builds it from the same schema objects the writer
 * uses — so a slot rename is a type error there rather than a column of zeros
 * here. Splitting it the other way is how a reader and a writer drift.
 *
 * WHY THE REST API AND NOT A BINDING. There is no read side to an
 * `AnalyticsEngineDataset` binding: `writeDataPoint` is the whole surface, and
 * queries go over `POST /accounts/{id}/analytics_engine/sql`. This is the
 * documented exception to "bindings over REST" rather than a lapse from it.
 *
 * SAMPLING IS NOT OPTIONAL TO HANDLE. Analytics Engine downsamples per index
 * value at volume and reports the rate in `_sample_interval`, so an unweighted
 * `COUNT()` under-reports by exactly the sample rate — silently, and worst
 * precisely for the busiest index. Every aggregate in the query builder is
 * weighted; this file's job is to not undo that, which it does by never
 * post-processing a number.
 */
import { diagnostics, renderThrownChain, toKinuError, type KinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';

/** Documented endpoint shape. The account id is a var and the token a secret. */
const SQL_API = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

export interface AnalyticsSqlEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_SQL_API_TOKEN?: string;
  /**
   * What this deployment appends to every dataset name: unset or '' in
   * production, `_staging` under `env.staging`.
   *
   * A READ-PATH setting only. Writes go through bindings, which wrangler already
   * points at the right dataset. It lives on the env rather than in the schemas
   * because it is the one analytics fact that differs per deployment, and
   * `scripts/analytics-datasets.test.ts` holds it equal to what wrangler binds.
   */
  ANALYTICS_DATASET_SUFFIX?: string;
}

/**
 * A query's answer, or why there isn't one.
 *
 * `unconfigured` is a first-class state rather than an error: a deployment with
 * no analytics token is a working deployment whose metrics view says so, and
 * collapsing it into `failed` would make a missing secret look like an outage.
 */
export type AnalyticsResult =
  | { readonly status: 'ok'; readonly rows: readonly AnalyticsRow[] }
  | { readonly status: 'unconfigured'; readonly missing: readonly string[] }
  | { readonly status: 'failed'; readonly reason: string };

/** One result row. Column names come from the query's own aliases, and every
 *  value is a JSON scalar because that is what the API's default format
 *  returns. */
export type AnalyticsRow = Record<string, string | number | boolean | null>;

const AnalyticsCellSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

/** The documented default response envelope. Parsed rather than asserted: it is
 *  an external API answer, which is exactly where a schema belongs. */
const SqlResponseSchema = v.object({
  data: v.array(v.record(v.string(), AnalyticsCellSchema)),
});

/** An API error answer, so a 4xx reports Cloudflare's own message instead of a
 *  bare status. A wrong dataset name or an under-scoped token both land here,
 *  and both are worth reading verbatim.
 *
 *  `errors` is REQUIRED, and that is what makes this schema a test of whether a
 *  body IS this envelope. Optional, it matched every JSON value with a property
 *  bag — including an array, since valibot's `object` reads one as an object with
 *  no `errors` — so `[1,2,3]` from a misrouted endpoint parsed as an envelope
 *  with nothing to say and rendered as a bare status code. The array's PRESENCE
 *  is the documented shape; an empty one is a refusal with no message, which is a
 *  different fact and now reads as one. */
const SqlErrorSchema = v.object({
  errors: v.array(v.object({ message: v.optional(v.string()) })),
});
type SqlErrorEnvelope = v.InferOutput<typeof SqlErrorSchema>;

/** Which required settings are absent, in the order an operator would set them. */
export function analyticsMissingSettings(env: AnalyticsSqlEnv): readonly string[] {
  const missing: string[] = [];
  if (!(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim()) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!(env.ANALYTICS_SQL_API_TOKEN ?? '').trim()) missing.push('ANALYTICS_SQL_API_TOKEN');
  return missing;
}

/**
 * How long a batch of metric answers is reused.
 *
 * The admin metrics view is a dashboard, not a live feed: its window is hours
 * and its numbers move slowly, while every open would otherwise cost five
 * queries against an API this Worker pays latency to reach. Thirty seconds is
 * short enough that a refresh feels live and long enough that a page with five
 * panels and a re-render costs one round trip.
 */
const BATCH_TTL_MS = 30_000;

/** The queries one batch runs, keyed by the panel each answers. */
export type AnalyticsQuerySet = ReadonlyMap<string, string>;

/** One answer per panel name. */
export type AnalyticsPanels = Record<string, AnalyticsResult>;

interface CachedBatch {
  readonly at: number;
  readonly result: Promise<AnalyticsPanels>;
}

/**
 * Cached batches, keyed by the exact set of queries asked.
 *
 * Holds account-wide aggregates and nothing request-scoped or per-user: the key
 * is query text and the value is a number an operator would see anyway, which is
 * what makes an isolate-level cache correct here rather than cross-request
 * leakage. The stored value is the PROMISE, so two concurrent page loads share
 * one round trip instead of racing to fill the same entry.
 */
const batches = new Map<string, CachedBatch>();

/** Bound the cache. A distinct key exists per (window, workspace filter) pair,
 *  which is small, but an isolate serving an operator who walks many workspaces
 *  should not accumulate them forever. */
const BATCH_CACHE_MAX = 64;

/**
 * Run one query.
 *
 * Uncached and module-private: `runAnalyticsBatch` is the only caller, and it is
 * what every panel resolves through. A second, uncached door would be a way to
 * spend a round trip the batch had already paid for.
 */
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

/**
 * What an error response's body turned out to be.
 *
 * Two arms rather than one tolerant envelope. The absent-message envelope and a
 * body that is not an envelope AT ALL used to reduce to the same `{}`, so a
 * response from an edge the API never saw — HTML, or a proxy's own error page —
 * rendered as a bare status code indistinguishable from a clean API refusal
 * carrying no message. They are different faults with different fixes: one is a
 * query or a token, the other is the route to Cloudflare.
 */
type ErrorBody =
  | { readonly status: 'envelope'; readonly envelope: SqlErrorEnvelope }
  | { readonly status: 'unreadable'; readonly failure: KinuError; readonly bytes: number };

/**
 * Decode a body that may not be JSON, or may be JSON that is not the envelope.
 *
 * `bad_input` is the class for an unrecognised failure here because that is what
 * one MEANS at a decoder: these bytes are not the shape they were declared to
 * be. The caller reports it and names it in the reason it renders.
 */
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

/**
 * Cloudflare's own message when it has one, so a mis-scoped token or an unknown
 * dataset says which rather than reporting a status code.
 *
 * An unreadable body is reported with its chain and SAID SO in the reason, which
 * is the difference between an operator reading "analytics API 502" and looking
 * for a bad query, and reading that something else came back and looking at what
 * sits in front of the API.
 */
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

/**
 * Run a named set of queries as one cached batch.
 *
 * Every panel on the metrics view resolves from one entry, so a page open is one
 * cache fill rather than five, and a second open inside the TTL is none.
 */
export async function runAnalyticsBatch(
  env: AnalyticsSqlEnv,
  queries: AnalyticsQuerySet,
  now: number = Date.now(),
): Promise<AnalyticsPanels> {
  // A Map, not a record: the query owner returns a CLOSED type with named
  // members, and a closed interface has no index signature to satisfy. A map of
  // (panel name, SQL) is also what the cache key is built from, so the key
  // cannot drift from the set it names.
  const named = [...queries.entries()].sort(([a], [b]) => a.localeCompare(b));
  const key = named.map(([name, sql]) => `${name}\u0000${sql}`).join('\u0001');
  const cached = batches.get(key);
  if (cached && now - cached.at < BATCH_TTL_MS) return cached.result;

  // Eviction lives INSIDE the fill rather than on a `.catch` beside it. A
  // handler bolted on outside had to end in either a swallow — the caller then
  // awaiting a promise that resolved to nothing while its own copy rejected —
  // or a rethrow onto a derived promise nobody holds, which is an unhandled
  // rejection with no request attached. In here the rejection is evicted,
  // recorded with its class, and then continues to the one caller awaiting it.
  const result = (async (): Promise<AnalyticsPanels> => {
    try {
      const answers = await Promise.all(
        named.map(async ([name, sql]) => [name, await runAnalyticsSql(env, sql)] as const),
      );
      return Object.fromEntries(answers);
    } catch (cause) {
      // A rejected fill must not be cached, or one transient failure is served
      // for the whole TTL. `runAnalyticsSql` returns rather than throws, so this
      // is reached only on a programming error — exactly when a sticky cache
      // entry is hardest to diagnose.
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

/** Drop every cached batch. For tests, and for the view's explicit refresh. */
export function clearAnalyticsCache(): void {
  batches.clear();
}
