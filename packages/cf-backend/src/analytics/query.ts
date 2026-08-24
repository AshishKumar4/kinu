/**
 * Weighted SQL for the Analytics Engine read path.
 *
 * ## Why every aggregate here is weighted
 *
 * AE downsamples. Sampling happens on write and on read, keyed on `index1`, and
 * the surviving row carries `_sample_interval` — how many original rows it stands
 * for. A `COUNT()` over a sampled dataset is therefore not a count of anything: it
 * counts SURVIVORS. Cloudflare's own translation table is the contract these
 * builders implement:
 *
 *     COUNT()        →  SUM(_sample_interval)
 *     SUM(double1)   →  SUM(_sample_interval * double1)
 *     AVG(double1)   →  SUM(_sample_interval * double1) / SUM(_sample_interval)
 *     quantile       →  quantileExactWeighted(q)(double1, _sample_interval)
 *
 * The failure this prevents is not an error. An unweighted query returns a
 * plausible smaller number, and the moment one workspace gets busy enough to be
 * sampled, that number silently stops meaning what its column heading says. So
 * there is no unweighted aggregate in this module at all: the safe form is the
 * only form available.
 *
 * ## Why positions never appear
 *
 * Every column is resolved through the schema by NAME. A query that spelled
 * `blob7` would be a second declaration of a fact `schemas.ts` already owns, and
 * when the two disagree the query still returns strings — every one of them from
 * the wrong field. The name arguments are typed against the schema, so a slot
 * that moves is a compile error here and a slot that is renamed is a compile
 * error too.
 *
 * ## Purity
 *
 * Text in, text out. Nothing here reads an environment, touches a binding or
 * makes a request: the control plane owns the transport, the credential and the
 * not-configured arm, and it must be able to render "analytics not configured"
 * without this module existing at runtime.
 */
import {
  AGENT_METRICS_SCHEMA, CONTROL_PLANE_OPS_SCHEMA,
  blobColumn, doubleColumn, indexColumn,
  type AnalyticsSchema, type BlobName, type DoubleName,
} from './schemas';

/** `COUNT()`, weighted. The sample interval IS the count: one surviving row
 *  stands for `_sample_interval` originals. */
export function weightedCount(): string {
  return 'SUM(_sample_interval)';
}

/** `SUM(metric)`, weighted. */
export function weightedSum<S extends AnalyticsSchema>(schema: S, metric: DoubleName<S>): string {
  return `SUM(_sample_interval * ${doubleColumn(schema, metric)})`;
}

/** `AVG(metric)`, weighted — the weighted total over the weighted row count,
 *  which is what makes it an average of the ORIGINAL rows rather than of the
 *  survivors. */
export function weightedAvg<S extends AnalyticsSchema>(schema: S, metric: DoubleName<S>): string {
  return `SUM(_sample_interval * ${doubleColumn(schema, metric)}) / SUM(_sample_interval)`;
}

/**
 * A quantile of `metric`, weighted. `quantileExactWeighted` takes the weight as
 * its second argument and AE's documentation names `_sample_interval` as the
 * value to pass — the platform built the function for this.
 */
export function weightedQuantile<S extends AnalyticsSchema>(
  schema: S,
  metric: DoubleName<S>,
  quantile: number,
): string {
  if (!(quantile > 0 && quantile < 1)) {
    throw new RangeError(`quantile must be strictly between 0 and 1, got ${quantile}`);
  }
  return `quantileExactWeighted(${quantile})(${doubleColumn(schema, metric)}, _sample_interval)`;
}

/**
 * A ratio of two weighted sums — a mean of `metric` over the rows that actually
 * carried one, rather than over every row.
 *
 * The case it exists for: `usd` is 0 both when a call cost nothing and when it
 * could not be priced, so an average cost has to divide by the number of PRICED
 * calls. Dividing by the row count would report a fabricated discount that grows
 * with the number of unpriced calls.
 */
export function weightedRatio<S extends AnalyticsSchema>(
  schema: S,
  numerator: DoubleName<S>,
  denominator: DoubleName<S>,
): string {
  return `SUM(_sample_interval * ${doubleColumn(schema, numerator)})`
    + ` / SUM(_sample_interval * ${doubleColumn(schema, denominator)})`;
}

/** One selected metric: the expression, and the name it is reported under. */
export interface QueryMetric {
  readonly as: string;
  readonly expression: string;
}

export interface WeightedQuery<S extends AnalyticsSchema> {
  readonly schema: S;
  /** Blob slots to group by, in order. Reported under their own slot names. */
  readonly groupBy: readonly BlobName<S>[];
  readonly metrics: readonly QueryMetric[];
  /** The lookback, as an AE interval expression — `'24' HOUR`, `'7' DAY`. */
  readonly since: string;
  /** Extra predicates, ANDed. Build them with the column resolvers, never by
   *  spelling `blobN`. */
  readonly where?: readonly string[];
  /** A reported metric name to order by, descending. */
  readonly orderBy?: string;
  readonly limit?: number;
}

/**
 * The full SELECT.
 *
 * THE TIME PREDICATE IS MANDATORY, which is why `since` is a required field and
 * not an option. AE's query timeout is 30 seconds and an unbounded scan over a
 * three-month dataset reaches it; a builder that let a caller omit the window
 * would make "the metrics page times out" a thing a caller could cause by
 * forgetting one argument.
 */
export function buildWeightedQuery<S extends AnalyticsSchema>(query: WeightedQuery<S>): string {
  const { schema } = query;
  const grouped = query.groupBy.map((name) => `${blobColumn(schema, name)} AS ${String(name)}`);
  const selected = [
    ...grouped,
    ...query.metrics.map((metric) => `${metric.expression} AS ${metric.as}`),
  ];
  const predicates = [
    `timestamp > NOW() - INTERVAL ${query.since}`,
    ...(query.where ?? []),
  ];
  const lines = [
    `SELECT ${selected.join(', ')}`,
    `FROM ${schema.dataset}`,
    `WHERE ${predicates.join(' AND ')}`,
  ];
  if (query.groupBy.length > 0) {
    lines.push(`GROUP BY ${query.groupBy.map((name) => blobColumn(schema, name)).join(', ')}`);
  }
  if (query.orderBy !== undefined) lines.push(`ORDER BY ${query.orderBy} DESC`);
  if (query.limit !== undefined) lines.push(`LIMIT ${query.limit}`);
  return lines.join('\n');
}

/** One SQL string per panel the admin metrics view renders. A closed contract
 *  rather than an open dictionary, so a panel the reader expects and the builder
 *  stopped producing is a type error rather than an empty card. */
export interface ControlPlaneMetricQueries {
  readonly turns: string;
  readonly latency: string;
  readonly firstToken: string;
  readonly tokens: string;
  readonly toolFailures: string;
  readonly adminOps: string;
}

/**
 * The queries the control plane's metrics surface reads.
 *
 * Assembled here rather than there so slot positions never leave this module: the
 * control plane owns what to ASK and how to show it, and this owns how the
 * question is spelled. A rename on either side of that line is a type error
 * rather than a column of zeros.
 *
 * `workspaceDigest` is compared against `index1`, so a caller filters by
 * digesting a workspace id it already holds — the raw name is deliberately
 * unrecoverable from the dataset. `adminOps` ignores it: a different dataset with
 * a different index, where the same string would match nothing and a silently
 * empty panel is worse than an unfiltered one.
 */
export function controlPlaneMetricsQueries(
  opts: { sinceHours: number; workspaceDigest?: string },
): ControlPlaneMetricQueries {
  const since = `'${Math.max(1, Math.trunc(opts.sinceHours))}' HOUR`;
  const agent = AGENT_METRICS_SCHEMA;
  const ops = CONTROL_PLANE_OPS_SCHEMA;
  const workspace = opts.workspaceDigest;
  const scoped = (kind: string): string[] => {
    const predicates = [`${blobColumn(agent, 'kind')} = '${kind}'`];
    if (workspace !== undefined && workspace !== '') {
      predicates.push(`${indexColumn(agent)} = '${workspace}'`);
    }
    return predicates;
  };
  return {
    turns: buildWeightedQuery({
      schema: agent,
      groupBy: ['outcome', 'code'],
      metrics: [
        { as: 'turns', expression: weightedCount() },
        { as: 'avgDurationMs', expression: weightedAvg(agent, 'durationMs') },
        { as: 'avgSteps', expression: weightedAvg(agent, 'steps') },
        { as: 'avgToolCalls', expression: weightedAvg(agent, 'toolCalls') },
      ],
      since,
      where: scoped('turn'),
      orderBy: 'turns',
    }),
    latency: buildWeightedQuery({
      schema: agent,
      groupBy: ['model'],
      metrics: [
        { as: 'turns', expression: weightedCount() },
        { as: 'p50DurationMs', expression: weightedQuantile(agent, 'durationMs', 0.5) },
        { as: 'p95DurationMs', expression: weightedQuantile(agent, 'durationMs', 0.95) },
      ],
      since,
      where: scoped('turn'),
      orderBy: 'turns',
    }),
    tokens: buildWeightedQuery({
      schema: agent,
      groupBy: ['provider', 'model'],
      metrics: [
        { as: 'calls', expression: weightedCount() },
        { as: 'inputTokens', expression: weightedSum(agent, 'input') },
        { as: 'outputTokens', expression: weightedSum(agent, 'output') },
        { as: 'cachedInputTokens', expression: weightedSum(agent, 'cacheRead') },
        { as: 'usd', expression: weightedSum(agent, 'usd') },
        // Not `usd / calls`: `usd` is 0 for an unpriced call as well as a free
        // one, so the denominator has to be the calls that carried a rate.
        { as: 'usdPerPricedCall', expression: weightedRatio(agent, 'usd', 'priced') },
      ],
      since,
      where: scoped('model'),
      orderBy: 'calls',
    }),
    toolFailures: buildWeightedQuery({
      schema: agent,
      groupBy: ['tool', 'outcome', 'code'],
      metrics: [
        { as: 'calls', expression: weightedCount() },
        { as: 'avgDurationMs', expression: weightedAvg(agent, 'durationMs') },
      ],
      since,
      where: [...scoped('tool'), `${blobColumn(agent, 'outcome')} != 'ok'`],
      orderBy: 'calls',
    }),
    firstToken: buildWeightedQuery({
      schema: agent,
      groupBy: ['provider', 'model'],
      metrics: [
        { as: 'turns', expression: weightedCount() },
        { as: 'p50TtftMs', expression: weightedQuantile(agent, 'ttftMs', 0.5) },
        { as: 'p95TtftMs', expression: weightedQuantile(agent, 'ttftMs', 0.95) },
      ],
      since,
      // A DIFFERENT ROW KIND, which is why this is its own panel rather than two
      // more metrics on `latency`: a first-token row exists only for a turn that
      // streamed something, so folding it in would average first-token latency
      // over turns that never produced a token — and those two populations are
      // exactly the ones to keep apart when latency is the complaint.
      where: scoped('ttft'),
      orderBy: 'turns',
    }),
    adminOps: buildWeightedQuery({
      schema: ops,
      groupBy: ['operation', 'outcome'],
      metrics: [
        { as: 'operations', expression: weightedCount() },
        { as: 'avgDurationMs', expression: weightedAvg(ops, 'durationMs') },
      ],
      since,
      orderBy: 'operations',
    }),
  };
}
