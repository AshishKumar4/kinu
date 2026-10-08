
import { analyticsMissingSettings, runAnalyticsBatch, type AnalyticsResult } from './analytics-sql';
import type { ProbeOutcome } from '../http/synthetic-probes';
import type { SqlExec } from '../types/primitives';
import {
  ALERT_SIGNALS, ALERT_UNMEASURED, evaluateFleet, settleSignal, type FleetSample, type SignalStreak, type SignalVerdict,
} from '../obs/analytics/alerts';
import { Effect } from 'effect';
import { renderThrownChain } from '../obs/index';
import { settle } from '../obs/effect';
import { fleetAlertQueries } from '../obs/analytics/query';
import * as v from 'valibot';

const HOUR_MS = 3_600_000;

export const FLEET_PROBE_PREFIX = 'fleet.';

const SOURCES = 'sources';

const FLEET_SOURCES_PROBE = `${FLEET_PROBE_PREFIX}${SOURCES}`;

export interface FleetEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_SQL_API_TOKEN?: string;
  ANALYTICS_DATASET_SUFFIX?: string;
  KINU_OBS_TOKEN?: string;
  CF_VERSION_METADATA?: { id: string };
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const Count = v.pipe(v.union([v.string(), v.number()]), v.transform(Number), v.number());

const StartupRow = v.object({ workspace: v.string(), hour: v.string(), startups: Count });

const EventRow = v.object({ event: v.string(), code: v.string(), count: Count });

const TurnRow = v.object({ outcome: v.string(), count: Count });

interface Unavailable {
  readonly source: string;
  readonly kind: 'unset' | 'unreadable';
  readonly why: string;
}

interface Read<T> {
  readonly value: T | null;
  readonly unavailable: Unavailable | null;
}

const unreadable = (source: string, why: string): Read<never> => ({ value: null, unavailable: { source, kind: 'unreadable', why } });

function fromPanel<R extends v.GenericSchema, T>(
  source: string,
  panel: AnalyticsResult | undefined,
  row: R,
  fold: (rows: readonly v.InferOutput<R>[]) => T,
): Read<T> {
  if (panel === undefined) return unreadable(source, 'no answer');

  if (panel.status === 'unconfigured') return { value: null, unavailable: { source, kind: 'unset', why: `set ${panel.missing.join(' and ')}` } };

  if (panel.status === 'failed') return unreadable(source, panel.reason);
  const rows = v.safeParse(v.array(row), panel.rows);

  if (!rows.success) return unreadable(source, `rows of an unexpected shape: ${v.summarize(rows.issues)}`);

  return { value: fold(rows.output), unavailable: null };
}

function hourOf(text: string): number {
  return Date.parse(`${text.replace(' ', 'T')}Z`);
}

const TelemetryAnswer = v.object({
  result: v.object({
    calculations: v.optional(v.array(v.object({
      alias: v.optional(v.string(), ''),
      aggregates: v.array(v.object({
        groups: v.optional(v.array(v.object({ value: v.pipe(v.union([v.string(), v.number()]), v.transform(String)) })), []),
        value: v.number(),
      })),
    })), []),
  }),
});

function readKills(env: FleetEnv, now: number, fetch: Fetch): Effect.Effect<Read<NonNullable<FleetSample['kills']>>> {
  const source = 'invocation outcomes';

  const missing = [
    ...(env.KINU_OBS_TOKEN ?? '').trim() === '' ? ['KINU_OBS_TOKEN'] : [],
    ...(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim() === '' ? ['CLOUDFLARE_ACCOUNT_ID'] : [],
    ...env.CF_VERSION_METADATA === undefined ? ['the CF_VERSION_METADATA binding'] : [],
  ];

  const version = env.CF_VERSION_METADATA;

  if (missing.length > 0 || version === undefined) {
    return Effect.succeed({ value: null, unavailable: { source, kind: 'unset', why: `set ${missing.join(' and ')}` } });
  }

  const eq = (key: string, value: string) => ({ key, operation: 'eq', value, type: 'string' });

  return Effect.gen(function* () {
    const answered = yield* Effect.tryPromise({ try: async () => fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID ?? ''}/workers/observability/telemetry/query`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${env.KINU_OBS_TOKEN ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          queryId: 'kinu-monitor-kills',
          timeframe: { from: now - HOUR_MS, to: now },
          view: 'calculations',
          parameters: {
            datasets: ['cloudflare-workers'],
            filters: [
              eq('$metadata.type', 'cf-worker-event'),
              eq('$workers.scriptVersion.id', version.id),
              eq('$workers.entrypoint', 'OrchestratorAgent'),
            ],
            calculations: [
              { operator: 'count', alias: 'count' },
              { operator: 'uniq', key: '$workers.durableObjectId', keyType: 'string', alias: 'objects' },
            ],
            groupBys: [{ type: 'string', value: '$workers.outcome' }],
            limit: 20,
          },
        }),
      },
    ), catch: (cause) => unreadable(source, `the telemetry API did not answer: ${renderThrownChain({ cause })}`) });

    if (!answered.ok) return unreadable(source, `the telemetry API answered ${String(answered.status)}`);

    const body: unknown = yield* Effect.tryPromise({
      try: async () => answered.json(),
      catch: (cause) => unreadable(source, `the telemetry API answered no JSON: ${renderThrownChain({ cause })}`),
    });

    const parsed = v.safeParse(TelemetryAnswer, body);

    if (!parsed.success) return unreadable(source, `the telemetry API answered an unexpected shape: ${v.summarize(parsed.issues)}`);
    const { calculations } = parsed.output.result;

    const valueOf = (alias: string, outcome: string): number => calculations.find((c) => c.alias === alias)?.aggregates
      .find((a) => a.groups[0]?.value === outcome)?.value ?? 0;

    const invocations = calculations.find((c) => c.alias === 'count')?.aggregates.reduce((sum, a) => sum + a.value, 0) ?? 0;

    return {
      value: { exceededMemory: valueOf('count', 'exceededMemory'), exceededWallTimeObjects: valueOf('objects', 'exceededWallTime'), invocations },
      unavailable: null,
    };
  }).pipe(Effect.catch((read) => Effect.succeed(read)));
}

/** `runAnalyticsSql` answers each failure as a `failed` panel, so the batch never rejects. */
async function analyticsPanels(env: FleetEnv, queries: ReadonlyMap<string, string>): Promise<Partial<Record<string, AnalyticsResult>>> {
  if (analyticsMissingSettings(env).length > 0) return {};

  return runAnalyticsBatch(env, queries);
}

export function sampleFleet(env: FleetEnv, now: number, fetch: Fetch): Promise<{ sample: FleetSample; unavailable: Unavailable[] }> {
  return settle(Effect.gen(function* () {
    const queries = fleetAlertQueries(env.ANALYTICS_DATASET_SUFFIX ?? '');
    const missing = analyticsMissingSettings(env);

    const panels = yield* Effect.promise(async () => analyticsPanels(env, new Map(Object.entries(queries))));
    const panel = (name: keyof typeof queries): AnalyticsResult | undefined => missing.length > 0 ? { status: 'unconfigured', missing } : panels[name];

    const startups = fromPanel('startups', panel('startups'), StartupRow, (rows) => rows.map((row) => (
      { object: row.workspace, hour: hourOf(row.hour), startups: row.startups }
    )));

    const events = fromPanel('events', panel('events'), EventRow, (rows) => rows);

    const turns = fromPanel('turns', panel('turns'), TurnRow, (rows) => ({
      settled: rows.reduce((sum, row) => sum + row.count, 0),
      failed: rows.filter((row) => row.outcome === 'failed').reduce((sum, row) => sum + row.count, 0),
    }));

    const kills = yield* readKills(env, now, fetch);

    return {
      sample: { startups: startups.value, events: events.value, turns: turns.value, kills: kills.value },
      unavailable: [startups, events, turns, kills].flatMap((read) => read.unavailable === null ? [] : [read.unavailable]),
    };
  }));
}

const STREAKS_DDL = `
CREATE TABLE IF NOT EXISTS monitor_signal_streaks (
  signal  TEXT    PRIMARY KEY,
  crossed INTEGER NOT NULL,
  clean   INTEGER NOT NULL
)`;

const StreakRow = v.object({ signal: v.picklist([...ALERT_SIGNALS, SOURCES]), crossed: v.number(), clean: v.number() });

function observedOf(verdict: SignalVerdict): string | undefined {
  return 'observed' in verdict ? verdict.observed : undefined;
}

export function settleFleet(
  sql: SqlExec,
  read: { readonly sample: FleetSample; readonly unavailable: readonly Unavailable[] },
  open: ReadonlyMap<string, string>,
): ProbeOutcome[] {
  sql.exec(STREAKS_DDL);

  const streaks = new Map<string, SignalStreak>(
    v.parse(v.array(StreakRow), sql.exec('SELECT signal, crossed, clean FROM monitor_signal_streaks').toArray())
      .map((row) => [row.signal, { crossed: row.crossed, clean: row.clean }]),
  );

  const settleStreak = (signal: string, tick: Parameters<typeof settleSignal>[1]): boolean => {
    const settled = settleSignal(streaks.get(signal) ?? { crossed: 0, clean: 0 }, tick, open.has(`${FLEET_PROBE_PREFIX}${signal}`));

    sql.exec(
      `INSERT INTO monitor_signal_streaks (signal, crossed, clean) VALUES (?, ?, ?)
       ON CONFLICT(signal) DO UPDATE SET crossed = excluded.crossed, clean = excluded.clean`,
      signal, settled.streak.crossed, settled.streak.clean,
    );

    return settled.failing;
  };

  const outcomes = evaluateFleet(read.sample).map((verdict): ProbeOutcome => {
    const probe = `${FLEET_PROBE_PREFIX}${verdict.signal}`;
    const failing = settleStreak(verdict.signal, verdict);
    const said = verdict.state === 'crossed' ? verdict.detail : observedOf(verdict);

    if (ALERT_UNMEASURED.includes(verdict.signal)) return { probe, ok: true, detail: `not alerting until measured; ${said ?? 'clear'}` };

    return { probe, ok: !failing, detail: said ?? open.get(probe) ?? 'clear' };
  });

  const unset = read.unavailable.filter((u) => u.kind === 'unset');
  const failing = settleStreak(SOURCES, { state: read.unavailable.some((u) => u.kind === 'unreadable') ? 'crossed' : 'ok' }) || unset.length > 0;
  const detail = read.unavailable.map((u) => `${u.source}: ${u.why}`).join('; ');

  return [...outcomes, { probe: FLEET_SOURCES_PROBE, ok: !failing, detail: detail === '' ? 'every source reads' : detail }];
}
