// Analytics Engine SQL transport only; queries come from `analytics/query.ts`. REST because the
// dataset binding has no read side. Aggregates are sample-weighted upstream, so never post-process a number.
import { Cause, Effect } from 'effect';
import { diagnostics, renderThrownChain, toKinuError, type KinuError } from '../obs/index';
import { settle } from '../obs/effect';
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
