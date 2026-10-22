// Analytics Engine SQL transport only; queries come from `analytics/query.ts`. REST because the
// dataset binding has no read side. Aggregates are sample-weighted upstream, so never post-process a number.
import { Cause, Effect } from 'effect';
import { diagnostics, renderThrownChain, toKinuError, type KinuError } from '../obs/index';
import { ANALYTICS_DATASET_SUFFIX } from '../obs/analytics/schemas';
import { settle } from '../obs/effect';
import * as v from 'valibot';

const SQL_API = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

export interface AnalyticsSqlEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_SQL_API_TOKEN?: string;
  /** What this deployment appends to a dataset name on the read path (`analyticsDataset`). */
  ANALYTICS_DATASET_SUFFIX?: string;
  /** The datasets a reader reads, by whether they are bound: their writes are what it would find. */
  readonly AGENT_METRICS?: unknown;
  readonly CONTROL_PLANE_OPS?: unknown;
}

/** What a reader says on a deployment bound to no dataset: one made on an account with Analytics Engine off, whose
 *  door left them out (core deploy/steps.ts), and whose one writer then writes nothing (core obs/analytics/writer.ts). */
export const ANALYTICS_OFF = 'Usage analytics are off on this deployment.';

export function analyticsOff(env: AnalyticsSqlEnv): boolean {
  return env.AGENT_METRICS === undefined && env.CONTROL_PLANE_OPS === undefined;
}

const AnalyticsRowSchema = v.record(v.string(), v.union([v.string(), v.number(), v.boolean(), v.null()]));

export type AnalyticsRow = v.InferOutput<typeof AnalyticsRowSchema>;

/** `unconfigured` is not `failed`: a missing token must not look like an outage. */
export const AnalyticsResultSchema = v.variant('status', [
  v.object({ status: v.literal('ok'), rows: v.pipe(v.array(AnalyticsRowSchema), v.readonly()) }),
  v.object({ status: v.literal('unconfigured'), missing: v.pipe(v.array(v.string()), v.readonly()) }),
  v.object({ status: v.literal('failed'), reason: v.string() }),
]);

export type AnalyticsResult = v.InferOutput<typeof AnalyticsResultSchema>;

const SqlResponseSchema = v.object({ data: v.array(AnalyticsRowSchema) });

// `errors` is required so a non-envelope body (valibot reads arrays as objects) fails to parse.
const SqlErrorSchema = v.object({
  errors: v.array(v.object({ message: v.optional(v.string()) })),
});

type SqlErrorEnvelope = v.InferOutput<typeof SqlErrorSchema>;

export function analyticsMissingSettings(env: AnalyticsSqlEnv): readonly string[] {
  const missing: string[] = [];

  // Nothing was written to read, which no setting changes.
  if (analyticsOff(env)) return [ANALYTICS_OFF];

  if (!(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim()) missing.push('CLOUDFLARE_ACCOUNT_ID');

  if (!(env.ANALYTICS_SQL_API_TOKEN ?? '').trim()) missing.push('ANALYTICS_SQL_API_TOKEN');

  // Malformed, it would name another deployment's datasets or none, so nothing is read.
  if (!ANALYTICS_DATASET_SUFFIX.test(env.ANALYTICS_DATASET_SUFFIX ?? '')) missing.push('ANALYTICS_DATASET_SUFFIX');

  return missing;
}

export type AnalyticsQuerySet = ReadonlyMap<string, string>;

export type AnalyticsPanels = Record<string, AnalyticsResult>;

function runAnalyticsSql(env: AnalyticsSqlEnv, sql: string): Effect.Effect<AnalyticsResult> {
  const missing = analyticsMissingSettings(env);

  if (missing.length > 0) return Effect.succeed({ status: 'unconfigured', missing });

  return Effect.catchCause(Effect.gen(function* () {
    const response = yield* Effect.promise(async () => fetch(SQL_API((env.CLOUDFLARE_ACCOUNT_ID ?? '').trim()), {
      method: 'POST',
      headers: {
        // The API takes the query as the raw request body, not as JSON.
        'authorization': `Bearer ${(env.ANALYTICS_SQL_API_TOKEN ?? '').trim()}`,
        'content-type': 'text/plain',
      },
      body: sql,
    }));

    const text = yield* Effect.promise(async () => response.text());

    if (!response.ok) {
      return { status: 'failed', reason: yield* apiErrorReason(response.status, text) } satisfies AnalyticsResult;
    }

    const parsed = v.safeParse(SqlResponseSchema, JSON.parse(text));

    if (!parsed.success) {
      return { status: 'failed', reason: 'the analytics API returned a shape this reader does not recognize' } satisfies AnalyticsResult;
    }

    return { status: 'ok', rows: parsed.output.data } satisfies AnalyticsResult;
  }), (failed) => Effect.sync((): AnalyticsResult => {
    const cause = Cause.squash(failed);

    diagnostics.failure('control_plane.analytics_query_failed', toKinuError({
      doing: 'querying the Analytics Engine SQL API',
      cause,
      otherwise: 'unavailable',
    }));

    return { status: 'failed', reason: renderThrownChain({ cause }) };
  }));
}

// Distinguishes an API refusal from a body the API never produced (proxy/HTML): different fixes.
type ErrorBody =
  | { readonly status: 'envelope'; readonly envelope: SqlErrorEnvelope }
  | { readonly status: 'unreadable'; readonly failure: KinuError; readonly bytes: number };

function errorBodyOf(text: string): Effect.Effect<ErrorBody> {
  return Effect.catchCause(
    Effect.sync((): ErrorBody => ({ status: 'envelope', envelope: v.parse(SqlErrorSchema, JSON.parse(text)) })),
    (failed) => Effect.succeed<ErrorBody>({
      status: 'unreadable',
      failure: toKinuError({
        doing: 'decoding an analytics API error body',
        cause: Cause.squash(failed),
        otherwise: 'bad_input',
      }),
      bytes: text.length,
    }),
  );
}

function apiErrorReason(status: number, body: string): Effect.Effect<string> {
  return Effect.gen(function* () {
    const decoded = yield* errorBodyOf(body);

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
  });
}

export function runAnalyticsBatch(env: AnalyticsSqlEnv, queries: AnalyticsQuerySet): Promise<AnalyticsPanels> {
  return settle(Effect.forEach([...queries], ([name, sql]) => Effect.map(runAnalyticsSql(env, sql), (answer) => [name, answer] as const), {
    concurrency: 'unbounded',
  }).pipe(Effect.map((answers) => Object.fromEntries(answers))));
}
