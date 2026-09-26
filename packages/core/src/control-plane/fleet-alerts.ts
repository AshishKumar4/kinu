
import { analyticsMissingSettings, runAnalyticsBatch, type AnalyticsResult } from './analytics-sql';
import type { ProbeOutcome } from '../http/synthetic-probes';
import type { SqlExec } from '../types/primitives';
import {
  ALERT_SIGNALS, evaluateFleet, settleSignal, type AlertSignal, type FleetSample, type SignalStreak,
} from '../obs/analytics/alerts';
import { fleetAlertQueries } from '../obs/analytics/query';
import * as v from 'valibot';

const HOUR_MS = 3_600_000;

export const FLEET_PROBE_PREFIX = 'fleet.';

const FLEET_SOURCES_PROBE = `${FLEET_PROBE_PREFIX}sources`;

export interface FleetEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_SQL_API_TOKEN?: string;
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
  readonly why: string;
}

interface Read<T> {
  readonly value: T | null;
  readonly unavailable: Unavailable | null;
}

type PanelRows = Extract<AnalyticsResult, { status: 'ok' }>['rows'];

function fromPanel<T>(source: string, panel: AnalyticsResult | undefined, parse: (rows: PanelRows) => T): Read<T> {
  if (panel === undefined) return { value: null, unavailable: { source, why: 'no answer' } };

  if (panel.status === 'unconfigured') return { value: null, unavailable: { source, why: `set ${panel.missing.join(' and ')}` } };

  if (panel.status === 'failed') return { value: null, unavailable: { source, why: panel.reason } };

  return { value: parse(panel.rows), unavailable: null };
}

function hourOf(text: string): number {
  return Date.parse(`${text.replace(' ', 'T')}Z`);
}

const TelemetryAnswer = v.object({
  result: v.object({
    calculations: v.array(v.object({
      alias: v.optional(v.string(), ''),
      aggregates: v.array(v.object({
        groups: v.optional(v.array(v.object({ value: v.pipe(v.union([v.string(), v.number()]), v.transform(String)) })), []),
        value: v.number(),
      })),
    })),
  }),
});

async function readKills(env: FleetEnv, now: number, fetch: Fetch): Promise<Read<NonNullable<FleetSample['kills']>>> {
  const source = 'invocation outcomes';

  const missing = [
    ...(env.KINU_OBS_TOKEN ?? '').trim() === '' ? ['KINU_OBS_TOKEN'] : [],
    ...(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim() === '' ? ['CLOUDFLARE_ACCOUNT_ID'] : [],
    ...env.CF_VERSION_METADATA === undefined ? ['the CF_VERSION_METADATA binding'] : [],
  ];

  if (missing.length > 0 || env.CF_VERSION_METADATA === undefined) return { value: null, unavailable: { source, why: `set ${missing.join(' and ')}` } };

  const eq = (key: string, value: string) => ({ key, operation: 'eq', value, type: 'string' });

  const response = await fetch(
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
            eq('$workers.scriptVersion.id', env.CF_VERSION_METADATA.id),
            eq('$workers.entrypoint', 'OrchestratorAgent'),
            { key: '$workers.outcome', operation: 'neq', value: 'ok', type: 'string' },
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
  );

  if (!response.ok) return { value: null, unavailable: { source, why: `the telemetry API answered ${String(response.status)}` } };
  const { calculations } = v.parse(TelemetryAnswer, await response.json()).result;

  const valueOf = (alias: string, outcome: string): number => calculations.find((c) => c.alias === alias)?.aggregates
    .find((a) => a.groups[0]?.value === outcome)?.value ?? 0;

  return { value: { exceededMemory: valueOf('count', 'exceededMemory'), exceededWallTimeObjects: valueOf('objects', 'exceededWallTime') }, unavailable: null };
}

export async function sampleFleet(env: FleetEnv, now: number, fetch: Fetch): Promise<{ sample: FleetSample; unavailable: Unavailable[] }> {
  const queries = fleetAlertQueries();
  const missing = analyticsMissingSettings(env);

  const panels = missing.length > 0
    ? {}
    : await runAnalyticsBatch(env, new Map(Object.entries(queries)), now);

  const unconfigured: AnalyticsResult = { status: 'unconfigured', missing };
  const panel = (name: keyof typeof queries): AnalyticsResult | undefined => missing.length > 0 ? unconfigured : panels[name];

  const startups = fromPanel('startups', panel('startups'), (rows) => rows.map((row) => {
    const parsed = v.parse(StartupRow, row);

    return { object: parsed.workspace, hour: hourOf(parsed.hour), startups: parsed.startups };
  }));

  const events = fromPanel('events', panel('events'), (rows) => rows.map((row) => v.parse(EventRow, row)));

  const turns = fromPanel('turns', panel('turns'), (rows) => {
    const parsed = rows.map((row) => v.parse(TurnRow, row));

    return {
      settled: parsed.reduce((sum, row) => sum + row.count, 0),
      failed: parsed.filter((row) => row.outcome === 'failed').reduce((sum, row) => sum + row.count, 0),
    };
  });

  const kills = await readKills(env, now, fetch);

  return {
    sample: { startups: startups.value, events: events.value, turns: turns.value, kills: kills.value },
    unavailable: [startups, events, turns, kills].flatMap((read) => read.unavailable === null ? [] : [read.unavailable]),
  };
}

const STREAKS_DDL = `
CREATE TABLE IF NOT EXISTS monitor_signal_streaks (
  signal  TEXT    PRIMARY KEY,
  crossed INTEGER NOT NULL,
  clean   INTEGER NOT NULL
)`;

const StreakRow = v.object({ signal: v.picklist(ALERT_SIGNALS), crossed: v.number(), clean: v.number() });

export function settleFleet(
  sql: SqlExec,
  read: { readonly sample: FleetSample; readonly unavailable: readonly Unavailable[] },
  open: ReadonlyMap<string, string>,
): ProbeOutcome[] {
  sql.exec(STREAKS_DDL);

  const streaks = new Map<AlertSignal, SignalStreak>(
    v.parse(v.array(StreakRow), sql.exec('SELECT signal, crossed, clean FROM monitor_signal_streaks').toArray())
      .map((row) => [row.signal, { crossed: row.crossed, clean: row.clean }]),
  );

  const outcomes = evaluateFleet(read.sample).map((verdict): ProbeOutcome => {
    const probe = `${FLEET_PROBE_PREFIX}${verdict.signal}`;
    const settled = settleSignal(streaks.get(verdict.signal) ?? { crossed: 0, clean: 0 }, verdict, open.has(probe));

    sql.exec(
      `INSERT INTO monitor_signal_streaks (signal, crossed, clean) VALUES (?, ?, ?)
       ON CONFLICT(signal) DO UPDATE SET crossed = excluded.crossed, clean = excluded.clean`,
      verdict.signal, settled.streak.crossed, settled.streak.clean,
    );
    const detail = verdict.state === 'crossed' ? verdict.detail : open.get(probe) ?? 'clear';

    return { probe, ok: !settled.failing, detail };
  });

  const sources: ProbeOutcome = read.unavailable.length === 0
    ? { probe: FLEET_SOURCES_PROBE, ok: true, detail: 'every source reads' }
    : { probe: FLEET_SOURCES_PROBE, ok: false, detail: read.unavailable.map((u) => `${u.source}: ${u.why}`).join('; ') };

  return [...outcomes, sources];
}
