/**
 * Weighted SQL for the AE read path. AE samples on write and read, so every aggregate weights by
 * `_sample_interval`; no unweighted form exists. Columns resolve by slot name, never `blobN`.
 * Pure text: no env, binding or request.
 */
import { assertQuantileLevel } from './limits';
import {
  AGENT_METRICS_SCHEMA, CONTROL_PLANE_OPS_SCHEMA,
  blobColumn, doubleColumn, indexColumn,
  type AnalyticsSchema, type BlobName, type DoubleName,
} from './schemas';

function weightedCount(): string {
  return 'SUM(_sample_interval)';
}

function weightedSum<S extends AnalyticsSchema>(schema: S, metric: DoubleName<S>): string {
  return `SUM(_sample_interval * ${doubleColumn(schema, metric)})`;
}

function weightedAvg<S extends AnalyticsSchema>(schema: S, metric: DoubleName<S>): string {
  return `SUM(_sample_interval * ${doubleColumn(schema, metric)}) / SUM(_sample_interval)`;
}

function weightedQuantile<S extends AnalyticsSchema>(
  schema: S,
  metric: DoubleName<S>,
  quantile: number,
): string {
  assertQuantileLevel(quantile);

  return `quantileExactWeighted(${quantile})(${doubleColumn(schema, metric)}, _sample_interval)`;
}

/** Mean over rows that carried the metric, e.g. `usd` over priced calls, not over all rows. */
function weightedRatio<S extends AnalyticsSchema>(
  schema: S,
  numerator: DoubleName<S>,
  denominator: DoubleName<S>,
): string {
  return `SUM(_sample_interval * ${doubleColumn(schema, numerator)})`
    + ` / SUM(_sample_interval * ${doubleColumn(schema, denominator)})`;
}

interface QueryMetric {
  readonly as: string;
  readonly expression: string;
}

interface WeightedQuery<S extends AnalyticsSchema> {
  readonly schema: S;
  readonly groupBy: readonly BlobName<S>[];
  readonly metrics: readonly QueryMetric[];
  /** AE interval expression, e.g. `'24' HOUR`. */
  readonly since: string;
  /** ANDed; build with the column resolvers, never `blobN`. */
  readonly where?: readonly string[];
  readonly orderBy?: string;
  /** Required when `groupBy` has open cardinality (see `PANEL_ROW_LIMIT`). */
  readonly limit?: number;
}

/** `since` is required: an unbounded scan over the three-month dataset hits AE's query timeout. */
function buildWeightedQuery<S extends AnalyticsSchema>(query: WeightedQuery<S>): string {
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

export interface ControlPlaneMetricQueries {
  readonly turns: string;
  readonly latency: string;
  readonly firstToken: string;
  readonly tokens: string;
  readonly toolFailures: string;
  readonly adminOps: string;
}

/**
 * Bound for panels grouped by open-cardinality blobs (`model`, `tool`); the UI table has no
 * pagination. Mirrors `CONTROL_PAGE_DEFAULT`, restated because that module imports this one.
 */
const PANEL_ROW_LIMIT = 50;

/**
 * `workspaceDigest` filters `index1`; `adminOps` ignores it, since that dataset is indexed by
 * actor and the filter would silently empty the panel.
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
      limit: PANEL_ROW_LIMIT,
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
        { as: 'usdPerPricedCall', expression: weightedRatio(agent, 'usd', 'priced') },
      ],
      since,
      where: scoped('model'),
      orderBy: 'calls',
      limit: PANEL_ROW_LIMIT,
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
      limit: PANEL_ROW_LIMIT,
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
      // Separate row kind: exists only for turns that streamed.
      where: scoped('ttft'),
      orderBy: 'turns',
      limit: PANEL_ROW_LIMIT,
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
