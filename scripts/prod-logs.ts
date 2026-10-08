/**
 * Production log access for the deployed workers.
 *
 * Two halves, by access:
 *  - `live` spawns `wrangler tail` (the OAuth session can do this) and filters
 *    the stream to typed events / substrings. Live-only: Workers keeps no
 *    scrollback for a tail.
 *  - Everything else reads HISTORY through the Workers Observability telemetry
 *    API, which refuses the wrangler OAuth token (measured 2026-08-21: HTTP
 *    403, code 10000). It needs a real API token in KINU_OBS_TOKEN (or
 *    ~/.config/kinu/obs-token) with "Account > Workers Observability > Read".
 *    Mint once: dash.cloudflare.com -> My Profile -> API Tokens -> Create Token.
 *    Retention is about 7 days.
 *
 * History commands:
 *  - `query`: raw events, optionally filtered by a message substring.
 *  - `timeline <workspace-name|do-id>`: one object's startups by hour, its
 *    invocation outcomes, top events, failures with a sample cause, and the gaps
 *    between its startups and between its alarms.
 *  - `errors`: fleet failures by event and code, with the objects each touched,
 *    and invocations that did not end `ok`.
 *  - `wakes`: objects ranked by startups per hour; `findWakeLoops` flags loops.
 *  - `version <version-id>`: what one deployed version did on its own (L18), each a finding however its tests went:
 *    an invocation that ended in an uncaught exception or that the platform ended (a reset), a terminal effect that
 *    failed or was left owed, an object started {@link ALERT_THRESHOLDS}.startupsPerHour or more times in an hour (a
 *    wake loop), and any idle wake: an alarm with nothing to watch, no invocation of its object but alarms and no
 *    model call the object opened within {@link IDLE_WAKE_DISTANCE_MS}, the same target 0 as the durability canary's
 *    idle window. It does not count alarms busy beside their object's work: the SDK's keepAlive heartbeat, a lap or
 *    a timer that served a live turn, or a turn that runs inside alarm invocations. Raw alarm counts measured that
 *    work instead (staging fb848438c, 2026-10-08: 46 object-hours at 30-122 alarms, every one of 2,600 alarms within
 *    five minutes of its object's own work), while the event-drain storm's 3,041 alarms came 709 then 2,332 an hour
 *    with none. What an alarm watches without a call or a model call reads as idle here, and its finding names the
 *    object for `timeline` to say which: Nimbus's 5-second resident keep-alive while a silent socket is attached, a
 *    devbox's minute heartbeat for its container, a timer whose work makes no model call. Exits 1 on a finding, and
 *    writes each into the deploy's report when KINU_DEPLOY_REPORT names one.
 *
 * A startup is counted by `actor.startup` (one per workspace object
 * activation). Hours before that event shipped fall back to
 * `vector.store_registered`, logged once per runtime build: on 2026-09-26
 * 03:00-03:40Z warm-forge-4d6acc02 logged 78 of them against 74 of the SDK's
 * "during startup" warnings, so the fallback overcounts by a hosted actor's
 * build now and then.
 *
 * `--worker` is the SERVICE name the account files events under, not the
 * project's name. It defaults to the top-level `name` in
 * `packages/cf-backend/wrangler.jsonc`, and the account id is read from the
 * same file rather than restated here.
 *
 * Telemetry API facts, measured 2026-09-26 unless dated otherwise:
 *  - The operator set is `count`, `avg`, `min`, `max`, `sum`, `stddev`, `uniq`,
 *    `median`, `p25`, `p75`, `p90`, `p95`, `p99`. There is no `p50` (HTTP 400).
 *  - `limit` for grouped results goes inside `parameters`; at the top level
 *    it is ignored and a grouped query answers 10 groups.
 *  - A top-level `granularity` in ms sets the series bucket (3,600,000 for
 *    hours); without it the API picks about 60 buckets.
 *  - A 7-day grouped query came back sampled (`abr_level` 10, counts in
 *    multiples of 10); 24-hour windows came back unsampled. Sampled output
 *    says so.
 *  - Grouping by a field drops the rows that lack it. `level` is `error` on
 *    ordinary diagnostics events too, so a failure is a row with a `code`.
 *  - `$workers.wallTimeMs` mixes request duration with WebSocket lifetime
 *    (measured median 119,960 ms, 2026-08-21), so a latency question has to
 *    exclude the upgrades before it means anything.
 *
 * Usage:
 *   bun scripts/prod-logs.ts live [--seconds 120] [--grep swarm]
 *   bun scripts/prod-logs.ts query [--since 6h] [--grep head.]
 *   bun scripts/prod-logs.ts timeline <name|do-id> [--since 24h] [--until ISO] [--json]
 *   bun scripts/prod-logs.ts errors [--since 24h] [--until ISO] [--json]
 *   bun scripts/prod-logs.ts wakes [--since 24h] [--until ISO] [--json]
 *   bun scripts/prod-logs.ts version <version-id> [--since ISO] [--json]
 * `--since` takes 30m / 6h / 7d or an ISO instant; `--worker` works everywhere.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as v from 'valibot';
import { ALERT_THRESHOLDS, findWakeLoops, type StartupHour, type WakeLoop } from '@kinu.run/core/analytics';
import { PLATFORM_CATALOG } from '../packages/core/src/platform-catalog';
import { recordStep } from './deploy-report';
import { parseJsonc } from './jsonc';

/** The account this queries and the default worker, read off the manifest this
 *  inspects rather than restated beside it: a second spelling of the id is how
 *  a query runs against one account while the deploy targets another. */
const WRANGLER_CONFIG = new URL('../packages/cf-backend/wrangler.jsonc', import.meta.url).pathname;

const WranglerRef = v.object({ account_id: v.string(), name: v.string() });

const WRANGLER = parseJsonc(readFileSync(WRANGLER_CONFIG, 'utf8'), WranglerRef, 'wrangler.jsonc');

const ACCOUNT = WRANGLER.account_id;

const HOUR_MS = 3_600_000;

const MINUTE_MS = 60_000;

/** An alarm this close to its object's own work served it; past it, nothing was left to watch. */
export const IDLE_WAKE_DISTANCE_MS = 5 * MINUTE_MS;

/** Objects a per-minute read keeps; a read that reaches it is capped, and an object it drops would read as idle. */
const MINUTE_GROUPS_CAP = 2000;

const MODES = ['live', 'query', 'timeline', 'errors', 'wakes', 'version'] as const;

type Mode = (typeof MODES)[number];

interface Args {
  readonly mode: Mode;
  readonly target: string | null;
  readonly worker: string;
  readonly seconds: number;
  readonly from: number;
  readonly to: number;
  readonly grep: string | null;
  readonly json: boolean;
}

const USAGE = 'usage: prod-logs.ts <live|query|timeline <name|do-id>|errors|wakes|version <version-id>> '
  + '[--worker kinu] [--seconds 120] [--since 6h|7d|ISO] [--until ISO] [--grep text] [--json]';

function instant(raw: string, flag: string): number {
  const at = Date.parse(raw);

  if (Number.isNaN(at)) throw new Error(`${flag} takes an ISO instant, got ${raw}`);

  return at;
}

function parseArgs(argv: readonly string[]): Args {
  const mode = MODES.find((m) => m === argv[0]);

  if (mode === undefined) throw new Error(USAGE);

  const opt = (name: string): string | null => {
    const at = argv.indexOf(`--${name}`);

    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : null;
  };

  const named = mode === 'timeline' || mode === 'version';
  const target = named ? argv[1] ?? null : null;

  if (named && (target === null || target.startsWith('--'))) throw new Error(USAGE);
  const to = opt('until') === null ? Date.now() : instant(opt('until') ?? '', '--until');
  const sinceRaw = opt('since') ?? (mode === 'query' ? '6h' : '24h');
  const relative = /^(\d+)([mhd])$/.exec(sinceRaw);
  const unitMs = { m: 60_000, h: HOUR_MS, d: 24 * HOUR_MS };

  const from = relative === null
    ? instant(sinceRaw, '--since')
    : to - Number(relative[1]) * unitMs[v.parse(v.picklist(['m', 'h', 'd']), relative[2])];

  if (from >= to) throw new Error(`--since ${sinceRaw} is not before --until`);

  return {
    mode,
    target,
    worker: opt('worker') ?? WRANGLER.name,
    seconds: Number(opt('seconds') ?? '120'),
    from,
    to,
    grep: opt('grep'),
    json: argv.includes('--json'),
  };
}

/** The slice of a tail event this tool reads; everything else passes through. */
const TailEventSchema = v.looseObject({
  logs: v.optional(v.array(v.looseObject({
    level: v.optional(v.string()),
    // A part is prose or a structured value; the schema renders the value, so
    // downstream code only ever holds strings.
    message: v.optional(v.array(v.union([
      v.string(),
      v.pipe(v.unknown(), v.transform((part) => JSON.stringify(part))),
    ]))),
  }))),
  exceptions: v.optional(v.array(v.unknown())),
});

/** Every log line of one tail event, joined the way the dashboard renders it. */
function linesOf(event: v.InferOutput<typeof TailEventSchema>): string[] {
  const out = (event.logs ?? []).map((lg) => {
    return `${lg.level ?? '?'} ${(lg.message ?? []).join(' ')}`;
  });

  return out.concat((event.exceptions ?? []).map((ex) => `EXCEPTION ${JSON.stringify(ex)}`));
}

async function live(args: Args): Promise<void> {
  const child = spawn('bunx', ['wrangler', 'tail', args.worker, '--format', 'json'], {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const stop = setTimeout(() => child.kill('SIGINT'), args.seconds * 1000);
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let brace = buffer.indexOf('\n');

    while (brace >= 0) {
      const line = buffer.slice(0, brace).trim();
      buffer = buffer.slice(brace + 1);
      brace = buffer.indexOf('\n');

      if (!line.startsWith('{')) continue;
      let raw: unknown;

      try {
        raw = JSON.parse(line);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error; // JSON.parse's only throw
        continue; // a split frame; the remainder arrives with the next chunk
      }

      const event = v.safeParse(TailEventSchema, raw);

      if (!event.success) continue;

      for (const rendered of linesOf(event.output)) {
        if (args.grep === null || rendered.includes(args.grep)) console.log(rendered);
      }
    }
  });
  await new Promise<void>((resolve) => child.on('exit', () => { clearTimeout(stop); resolve(); }));
}

// ---- telemetry client ------------------------------------------------------

export interface Filter {
  readonly key: string;
  readonly operation: 'eq' | 'neq' | 'includes' | 'exists';
  readonly value?: string;
  readonly type: 'string';
}

const eq = (key: string, value: string): Filter => ({ key, operation: 'eq', value, type: 'string' });

const HAS_CODE: Filter = { key: 'code', operation: 'exists', type: 'string' };

interface Calculation {
  readonly operator: 'count' | 'uniq';
  readonly alias: string;
  readonly key?: string;
  readonly keyType?: 'string';
}

interface QueryBody {
  readonly view: 'events' | 'calculations';
  /** Rows of the events view; grouped results take theirs in `parameters`. */
  readonly limit?: number;
  readonly granularity?: number;
  readonly timeframe?: { readonly from: number; readonly to: number };
  readonly parameters: {
    readonly datasets: readonly string[];
    readonly filters: readonly Filter[];
    readonly calculations?: readonly Calculation[];
    readonly groupBys?: readonly { readonly type: 'string'; readonly value: string }[];
    readonly orderBy?: { readonly value: string; readonly order: 'desc' };
    readonly limit?: number;
  };
}

const GroupValue = v.pipe(v.union([v.string(), v.number(), v.boolean()]), v.transform(String));

const Aggregate = v.looseObject({
  groups: v.optional(v.array(v.looseObject({ key: v.string(), value: GroupValue })), []),
  value: v.number(),
  sampleInterval: v.optional(v.number(), 1),
});

const Calculation = v.looseObject({
  alias: v.optional(v.string(), ''),
  aggregates: v.optional(v.array(Aggregate), []),
  series: v.optional(v.array(v.looseObject({ time: v.string(), data: v.array(Aggregate) })), []),
});

const TelemetryFields = v.looseObject({
  sequence: v.optional(v.string()), owed: v.optional(v.string()),
  workspace: v.optional(v.string()), actor: v.optional(v.string()),
  sameBuild: v.optional(v.string()), midStep: v.optional(v.boolean()),
  stepsKept: v.optional(v.number()), fiber: v.optional(v.string()), fiberId: v.optional(v.string()),
  cause: v.optional(v.string()),
});

const TelemetryEvent = v.looseObject({
  timestamp: v.number(),
  // A plain log line's source is a string; only a structured line has these keys.
  source: v.fallback(v.looseObject({
    event: v.optional(v.string(), ''),
    code: v.optional(v.string(), ''),
    cause: v.optional(v.string(), ''),
    message: v.optional(v.string()),
    fields: v.fallback(TelemetryFields, {}),
  }), { event: '', code: '', cause: '', fields: {} }),
  $workers: v.optional(v.looseObject({
    durableObjectId: v.optional(v.string()),
    eventType: v.optional(v.string()),
    outcome: v.optional(v.string()),
    scriptVersion: v.optional(v.looseObject({ id: v.optional(v.string()) })),
    wallTimeMs: v.optional(v.number()),
    event: v.optional(v.looseObject({ rpcMethod: v.optional(v.string()), rpcMethods: v.optional(v.array(v.string())) })),
  }), {}),
  $metadata: v.optional(v.looseObject({
    type: v.optional(v.string()), message: v.optional(v.string()), error: v.optional(v.string()),
    id: v.optional(v.string()), requestId: v.optional(v.string()), traceId: v.optional(v.string()),
  }), {}),
});

const TelemetryResult = v.looseObject({
  result: v.looseObject({
    calculations: v.optional(v.array(Calculation), []),
    events: v.optional(v.looseObject({ events: v.optional(v.array(TelemetryEvent), []) }), { events: [] }),
    statistics: v.optional(v.looseObject({ abr_level: v.optional(v.number(), 1) }), { abr_level: 1 }),
  }),
});

type Aggregate = v.InferOutput<typeof Aggregate>;

export type TelemetryEvent = v.InferOutput<typeof TelemetryEvent>;

/** One event of a version's signal as a fixer reads it: what was thrown or owed, by which object, in which request. */
const SampleEvent = v.looseObject({
  source: v.fallback(v.looseObject({
    message: v.optional(v.string()),
    code: v.optional(v.string()),
    cause: v.optional(v.string()),
    fields: v.optional(v.looseObject({ sequence: v.optional(v.string()), owed: v.optional(v.string()), effect: v.optional(v.string()) }), {}),
  }), { fields: {} }),
  $workers: v.optional(v.looseObject({ durableObjectId: v.optional(v.string()), entrypoint: v.optional(v.string()) }), {}),
  $metadata: v.optional(v.looseObject({ error: v.optional(v.string()), requestId: v.optional(v.string()), traceId: v.optional(v.string()) }), {}),
  timestamp: v.optional(v.number(), 0),
});

type SampleEvent = v.InferOutput<typeof SampleEvent>;

const SampleResult = v.looseObject({
  result: v.looseObject({ events: v.optional(v.looseObject({ events: v.optional(v.array(SampleEvent), []) }), { events: [] }) }),
});

export async function readToken(): Promise<string> {
  const tokenFile = `${process.env['HOME']}/.config/kinu/obs-token`;

  const token = process.env['KINU_OBS_TOKEN']
    ?? (await Bun.file(tokenFile).exists() ? (await Bun.file(tokenFile).text()).trim() : undefined);

  if (token === undefined || token === '') {
    throw new Error(
      'historical queries need KINU_OBS_TOKEN, an API token with "Account > Workers '
      + 'Observability > Read" (the wrangler OAuth token answers 403 here — measured '
      + '2026-08-21). Mint once at dash.cloudflare.com -> My Profile -> API Tokens.',
    );
  }

  return token;
}

export class Telemetry {
  /** Largest sampling level any answer carried; above 1 the counts are estimates. */
  sampling = 1;

  constructor(
    private readonly token: string,
    private readonly args: Pick<Args, 'worker' | 'from' | 'to'>,
  ) {}

  /** The answer's JSON text; `result` parses it. */
  async raw(body: QueryBody): Promise<string> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          // REQUIRED: the endpoint rejects a body without it as `ZodError … path:
          // ["queryId"]` under HTTP 400 (measured 2026-08-21). It names the saved
          // query the run is filed under, so it is a constant rather than a flag.
          queryId: 'kinu-prod-logs',
          timeframe: { from: this.args.from, to: this.args.to },
          ...body,
        }),
      },
    );

    const answer = await response.text();

    if (!response.ok) throw new Error(`telemetry query answered ${response.status}: ${answer.slice(0, 300)}`);

    return answer;
  }

  private filters(filters: readonly Filter[]): Filter[] {
    return [eq('$metadata.service', this.args.worker), ...filters];
  }

  private async result(body: QueryBody): Promise<v.InferOutput<typeof TelemetryResult>['result']> {
    const { result } = v.parse(TelemetryResult, JSON.parse(await this.raw(body)));
    this.sampling = Math.max(this.sampling, result.statistics.abr_level);

    return result;
  }

  /** One count per group (plus `uniq` of `distinct` when asked), largest first. */
  async count(opts: {
    filters: readonly Filter[];
    groupBy: readonly string[];
    distinct?: string;
    limit?: number;
  }): Promise<{ groups: string[]; count: number; distinct: number }[]> {
    const calculations: Calculation[] = [{ operator: 'count', alias: 'count' }];

    if (opts.distinct !== undefined) {
      calculations.push({ operator: 'uniq', key: opts.distinct, keyType: 'string', alias: 'distinct' });
    }

    const result = await this.result({
      view: 'calculations',
      parameters: {
        datasets: ['cloudflare-workers'],
        filters: this.filters(opts.filters),
        calculations,
        groupBys: opts.groupBy.map((value) => ({ type: 'string', value })),
        orderBy: { value: 'count', order: 'desc' },
        limit: opts.limit ?? 50,
      },
    });

    const valueOf = (alias: string, groupKey: string): number => {
      const calc = result.calculations.find((c) => c.alias === alias);

      return calc?.aggregates.find((a) => keyOf(a) === groupKey)?.value ?? 0;
    };

    const counted = result.calculations.find((c) => c.alias === 'count')?.aggregates ?? [];

    return counted
      .map((a) => ({ groups: a.groups.map((g) => g.value), count: a.value, distinct: valueOf('distinct', keyOf(a)) }))
      .sort((a, b) => b.count - a.count);
  }

  /** Counts per group per hour. */
  async hourly(opts: { filters: readonly Filter[]; groupBy: readonly string[]; limit?: number }): Promise<{ groups: string[]; hour: number; count: number }[]> {
    return (await this.buckets(opts, HOUR_MS)).map(({ groups, at, count }) => ({ groups, hour: at, count }));
  }

  /** Counts per `bucketMs` bucket; `at` is the bucket's start. */
  async buckets(opts: { filters: readonly Filter[]; groupBy: readonly string[]; limit?: number }, bucketMs: number): Promise<{ groups: string[]; at: number; count: number }[]> {
    const result = await this.result({
      view: 'calculations',
      granularity: bucketMs,
      parameters: {
        datasets: ['cloudflare-workers'],
        filters: this.filters(opts.filters),
        calculations: [{ operator: 'count', alias: 'count' }],
        groupBys: opts.groupBy.map((value) => ({ type: 'string', value })),
        orderBy: { value: 'count', order: 'desc' },
        limit: opts.limit ?? 200,
      },
    });

    return (result.calculations[0]?.series ?? []).flatMap((bucket) => bucket.data.map((a) => ({
      groups: a.groups.map((g) => g.value),
      // The API writes UTC bucket starts as `YYYY-MM-DD HH:MM:SS`.
      at: Math.floor(Date.parse(`${bucket.time.replace(' ', 'T')}Z`) / bucketMs) * bucketMs,
      count: a.value,
    })));
  }

  /** Events as {@link SampleEvent}s, the fields a fixer reads kept: what was thrown or owed, where, in which request. */
  async sampleEvents(filters: readonly Filter[], limit: number): Promise<SampleEvent[]> {
    const text = await this.raw({ view: 'events', limit, parameters: { datasets: ['cloudflare-workers'], filters: this.filters(filters) } });

    return v.parse(SampleResult, JSON.parse(text)).result.events.events;
  }

  /** `from` narrows the window: a sampled events view drops rows, and gaps between kept rows are fiction. */
  async events(filters: readonly Filter[], limit: number, from = this.args.from): Promise<{ events: TelemetryEvent[]; sampling: number }> {
    const result = await this.result({
      view: 'events',
      limit,
      timeframe: { from, to: this.args.to },
      parameters: { datasets: ['cloudflare-workers'], filters: this.filters(filters) },
    });

    return { events: result.events.events.sort((a, b) => a.timestamp - b.timestamp), sampling: result.statistics.abr_level };
  }
}

function keyOf(a: Aggregate): string {
  return a.groups.map((g) => g.value).join('\u0000');
}

// ---- shared readings -------------------------------------------------------

/** Newest first: `actor.startup` counts an activation exactly; the fallback covers older hours. */
const STARTUP_MARKERS = [
  { event: 'actor.startup', nameField: 'fields.workspace' },
  { event: 'vector.store_registered', nameField: 'fields.namespace' },
] as const;

const DO_ID = '$workers.durableObjectId';

const HEX_ID = /^[0-9a-f]{64}$/;

interface ObjectHour extends StartupHour {
  readonly name: string;
  readonly marker: string;
}

/** Per object and hour, the first marker that counted anything there. */
async function startupHours(t: Telemetry, extra: readonly Filter[]): Promise<ObjectHour[]> {
  const chosen = new Map<string, ObjectHour>();
  const names = new Map<string, string>();

  for (const marker of STARTUP_MARKERS) {
    const rows = await t.hourly({ filters: [eq('event', marker.event), ...extra], groupBy: [DO_ID, marker.nameField], limit: 500 });

    for (const row of rows) {
      const [object = '', name = ''] = row.groups;

      if (name !== '') names.set(object, name);
      const key = `${object}@${row.hour}`;

      if (chosen.has(key) || row.count === 0) continue;
      chosen.set(key, { object, hour: row.hour, startups: row.count, name: '', marker: marker.event });
    }
  }

  return [...chosen.values()].map((row) => ({ ...row, name: names.get(row.object) ?? '' }));
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function hourLabel(ms: number): string {
  return new Date(ms).toISOString().slice(5, 13).replace('T', ' ') + 'Z';
}

interface GapStats {
  readonly count: number;
  readonly medianSec: number | null;
  readonly p10Sec: number | null;
  readonly p90Sec: number | null;
  readonly buckets: Record<string, number>;
}

const GAP_BUCKETS: readonly [string, number][] = [
  ['<10s', 10], ['10-60s', 60], ['1-5m', 300], ['5-60m', 3600], ['>1h', Number.POSITIVE_INFINITY],
];

export function gapStats(timestamps: readonly number[]): GapStats {
  const gaps = timestamps.slice(1).map((t, i) => (t - timestamps[i]) / 1000).sort((a, b) => a - b);
  const pick = (p: number): number | null => gaps.length === 0 ? null : Math.round(gaps[Math.floor(p * (gaps.length - 1))]);
  const buckets: Record<string, number> = {};

  for (const gap of gaps) {
    const [label] = GAP_BUCKETS.find(([, upper]) => gap < upper) ?? GAP_BUCKETS[GAP_BUCKETS.length - 1];
    buckets[label] = (buckets[label] ?? 0) + 1;
  }

  return { count: timestamps.length, medianSec: pick(0.5), p10Sec: pick(0.1), p90Sec: pick(0.9), buckets };
}

function renderGaps(label: string, gaps: GapStats, capped: boolean): string {
  if (gaps.count < 2) return `  ${label}: ${gaps.count} seen, no gaps to measure`;

  const spread = GAP_BUCKETS.map(([b]) => `${b} ${gaps.buckets[b] ?? 0}`).join(', ');

  return `  ${label}: ${gaps.count}${capped ? ' (event cap reached: the oldest are missing)' : ''}; `
    + `gap median ${gaps.medianSec}s, p10 ${gaps.p10Sec}s, p90 ${gaps.p90Sec}s; ${spread}`;
}

function samplingNote(t: Telemetry): string[] {
  return t.sampling > 1
    ? [`note: the API sampled this window (level ${t.sampling}); counts are estimates. Narrow --since for exact counts.`]
    : [];
}

// ---- commands --------------------------------------------------------------

async function query(t: Telemetry, args: Args): Promise<void> {
  const filters: Filter[] = args.grep === null ? [] : [{ key: '$metadata.message', operation: 'includes', value: args.grep, type: 'string' }];

  console.log(await t.raw({ view: 'events', limit: 500, parameters: { datasets: ['cloudflare-workers'], filters: [eq('$metadata.service', args.worker), ...filters] } }));
}

/** Name -> object id through the startup markers, which log the workspace name. */
async function resolveObject(t: Telemetry, target: string): Promise<{ id: string; name: string; others: string[] }> {
  if (HEX_ID.test(target)) return { id: target, name: '', others: [] };

  for (const marker of STARTUP_MARKERS) {
    const rows = await t.count({ filters: [eq('event', marker.event), eq(marker.nameField, target)], groupBy: [DO_ID], limit: 10 });

    if (rows.length > 0) {
      return { id: rows[0].groups[0], name: target, others: rows.slice(1).map((r) => r.groups[0]) };
    }
  }

  throw new Error(`no startup in the window names "${target}"; widen --since (telemetry keeps about 7 days) or pass the object id`);
}

const EVENT_CAP = 2000;

/** Gaps are read over the window's last 6 hours: 24-hour windows came back unsampled, 7-day ones did not. */
const CADENCE_WINDOW_MS = 6 * HOUR_MS;

async function timeline(t: Telemetry, args: Args): Promise<void> {
  const target = await resolveObject(t, args.target ?? '');
  const scope = [eq(DO_ID, target.id)];
  const hours = await startupHours(t, scope);
  const name = target.name || (hours.find((h) => h.name !== '')?.name ?? '');
  const outcomes = await t.count({ filters: [...scope, eq('$metadata.type', 'cf-worker-event')], groupBy: ['$workers.eventType', '$workers.outcome'] });
  const events = await t.count({ filters: scope, groupBy: ['event'], limit: 15 });
  const failures = await t.count({ filters: [...scope, HAS_CODE], groupBy: ['event', 'code'], limit: 20 });
  const { events: failureSamples } = await t.events([...scope, HAS_CODE], 200);

  const causes = failures.map((f) => {
    const sample = failureSamples.filter((e) => e.source.event === f.groups[0] && e.source.code === f.groups[1]).at(-1);

    return { event: f.groups[0], code: f.groups[1], count: f.count, cause: sample?.source.cause ?? '', at: sample?.timestamp ?? null };
  });

  const cadenceFrom = Math.max(args.from, args.to - CADENCE_WINDOW_MS);
  const startupEvents: number[] = [];

  for (const marker of STARTUP_MARKERS) {
    const { events: seen } = await t.events([...scope, eq('event', marker.event)], EVENT_CAP, cadenceFrom);

    if (seen.length > 0) {
      startupEvents.push(...seen.map((e) => e.timestamp));
      break;
    }
  }

  const { events: alarms } = await t.events([...scope, eq('$workers.eventType', 'alarm'), eq('$metadata.type', 'cf-worker-event')], EVENT_CAP, cadenceFrom);
  const { events: arms } = await t.events([...scope, eq('event', 'wake.unfinished_arms')], 50);

  const report = {
    object: target.id,
    name,
    otherObjectsWithThisName: target.others,
    window: { from: iso(args.from), to: iso(args.to) },
    startupsByHour: hours.sort((a, b) => a.hour - b.hour).map((h) => ({ hour: iso(h.hour), startups: h.startups, marker: h.marker })),
    outcomes: outcomes.map((o) => ({ eventType: o.groups[0], outcome: o.groups[1], count: o.count })),
    topEvents: events.map((e) => ({ event: e.groups[0], count: e.count })),
    failures: causes,
    cadence: {
      from: iso(cadenceFrom),
      startups: gapStats(startupEvents),
      startupsCapped: startupEvents.length >= EVENT_CAP,
      alarms: gapStats(alarms.map((e) => e.timestamp)),
      alarmsCapped: alarms.length >= EVENT_CAP,
    },
    unfinishedArms: arms.map((e) => ({ at: iso(e.timestamp), arms: Object.entries(e.source.fields).filter(([, on]) => on === true).map(([arm]) => arm) })),
    sampling: t.sampling,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 1));

    return;
  }

  const nonOk = report.outcomes.filter((o) => o.outcome !== 'ok');

  const lines = [
    `${name || '(unnamed)'} ${target.id}`,
    `window ${report.window.from} .. ${report.window.to}`,
    ...(target.others.length > 0 ? [`other objects logging this name: ${target.others.join(', ')}`] : []),
    '',
    'startups by hour:',
    ...(report.startupsByHour.length === 0 ? ['  none'] : report.startupsByHour.map((h) => `  ${hourLabel(Date.parse(h.hour))}  ${String(h.startups).padStart(5)}${h.marker === 'actor.startup' ? '' : '  (by vector.store_registered)'}`)),
    '',
    'invocation outcomes:',
    ...report.outcomes.map((o) => `  ${o.eventType.padEnd(12)} ${o.outcome.padEnd(18)} ${o.count}`),
    ...(nonOk.length > 0 ? [`  not ok: ${nonOk.reduce((s, o) => s + o.count, 0)} of ${report.outcomes.reduce((s, o) => s + o.count, 0)}`] : []),
    '',
    'top events:',
    ...report.topEvents.map((e) => `  ${String(e.count).padStart(6)}  ${e.event}`),
    '',
    'failures (event / code, newest cause):',
    ...(causes.length === 0 ? ['  none'] : causes.flatMap((c) => [
      `  ${String(c.count).padStart(6)}  ${c.event} / ${c.code}${c.at === null ? '' : `  last ${iso(c.at)}`}`,
      ...(c.cause === '' ? [] : [`          ${c.cause.replace(/\s+/g, ' ').slice(0, 300)}`]),
    ])),
    '',
    `wake cadence since ${report.cadence.from}:`,
    renderGaps('startups', report.cadence.startups, report.cadence.startupsCapped),
    renderGaps('alarm invocations', report.cadence.alarms, report.cadence.alarmsCapped),
    ...(arms.length === 0 ? [] : ['  unfinished arms (once per streak or change):', ...report.unfinishedArms.map((a) => `    ${a.at}  ${a.arms.join(',')}`)]),
    ...samplingNote(t),
  ];

  console.log(lines.join('\n'));
}

async function errors(t: Telemetry, args: Args): Promise<void> {
  const failures = await t.count({ filters: [HAS_CODE], groupBy: ['event', 'code'], distinct: DO_ID, limit: 40 });

  const outcomes = await t.count({
    filters: [eq('$metadata.type', 'cf-worker-event'), { key: '$workers.outcome', operation: 'neq', value: 'ok', type: 'string' }],
    groupBy: ['$workers.outcome', '$workers.eventType', '$workers.entrypoint'],
    distinct: DO_ID,
  });

  const report = {
    window: { from: iso(args.from), to: iso(args.to) },
    failures: failures.map((f) => ({ event: f.groups[0], code: f.groups[1], count: f.count, objects: f.distinct })),
    invocations: outcomes.map((o) => ({ outcome: o.groups[0], eventType: o.groups[1], entrypoint: o.groups[2], count: o.count, objects: o.distinct })),
    sampling: t.sampling,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 1));

    return;
  }

  console.log([
    `window ${report.window.from} .. ${report.window.to}`,
    '',
    'failures by event / code (count, objects):',
    ...report.failures.map((f) => `  ${String(f.count).padStart(7)}  ${String(f.objects).padStart(5)}  ${f.event} / ${f.code}`),
    '',
    'invocations not ok (count, objects):',
    ...(report.invocations.length === 0 ? ['  none'] : report.invocations.map((o) => `  ${String(o.count).padStart(7)}  ${String(o.objects).padStart(5)}  ${o.outcome} ${o.eventType} ${o.entrypoint}`)),
    ...samplingNote(t),
  ].join('\n'));
}

async function wakes(t: Telemetry, args: Args): Promise<void> {
  const hours = await startupHours(t, []);
  const names = new Map(hours.map((h) => [h.object, h.name] as const));
  const loops = findWakeLoops(hours);
  const byObject = new Map<string, { startups: number; peak: number }>();

  for (const h of hours) {
    const seen = byObject.get(h.object) ?? { startups: 0, peak: 0 };
    byObject.set(h.object, { startups: seen.startups + h.startups, peak: Math.max(seen.peak, h.startups) });
  }

  const quiet = [...byObject.entries()]
    .filter(([object]) => !loops.some((l) => l.object === object))
    .sort(([, a], [, b]) => b.peak - a.peak)
    .slice(0, 10);

  const render = (loop: WakeLoop) => ({ ...loop, name: names.get(loop.object) ?? '', firstLoopHour: iso(loop.firstLoopHour), lastLoopHour: iso(loop.lastLoopHour) });

  const report = {
    window: { from: iso(args.from), to: iso(args.to) },
    objects: byObject.size,
    loops: loops.map(render),
    nextBusiest: quiet.map(([object, s]) => ({ object, name: names.get(object) ?? '', startups: s.startups, peakPerHour: s.peak })),
    sampling: t.sampling,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 1));

    return;
  }

  console.log([
    `window ${report.window.from} .. ${report.window.to}; ${report.objects} objects started`,
    '',
    `loops (an hour at ${ALERT_THRESHOLDS.startupsPerHour}+ startups; SUSTAINED = 2+ consecutive hours):`,
    ...(loops.length === 0 ? ['  none'] : report.loops.map((l) => `  ${l.sustained ? 'SUSTAINED' : 'burst    '}  peak ${String(l.peakPerHour).padStart(4)}/h  ${String(l.loopHours).padStart(3)} loop h (run ${l.longestRunHours})  ${hourLabel(Date.parse(l.firstLoopHour))} .. ${hourLabel(Date.parse(l.lastLoopHour))}  ${l.object.slice(0, 16)}  ${l.name}`)),
    '',
    'busiest others:',
    ...report.nextBusiest.map((o) => `  peak ${String(o.peakPerHour).padStart(4)}/h  total ${String(o.startups).padStart(5)}  ${o.object.slice(0, 16)}  ${o.name}`),
    ...samplingNote(t),
  ].join('\n'));
}

// ---- one deployed version (L18) -----------------------------------------------

/** An uncaught exception of the version, as its fixer starts from it: its text, the request it ended, and the
 *  Durable Object whose invocation, or whose call, it was (empty when its trace names none). */
export interface ExceptionSample {
  readonly entrypoint: string;
  readonly message: string;
  readonly object: string;
  readonly request: string;
}

/** A terminal effect the version failed or left owed: its object, its turn, and what it says. */
export interface EffectSample {
  readonly object: string;
  readonly sequence: string;
  readonly detail: string;
}

export interface TerminalEffectStates {
  readonly observations: number;
  readonly settled: readonly EffectSample[];
  readonly owed: readonly EffectSample[];
}

/** Summarizes the version's terminal-effect observations for its deploy report. */
export function terminalEffectStates(events: readonly Pick<TelemetryEvent, 'timestamp' | 'source' | '$workers'>[]): TerminalEffectStates {
  const states = new Map<string, Map<string, { latest: (typeof events)[number]; observed: boolean }>>();
  let observations = 0;

  for (const event of events) {
    const isOwed = event.source.event === 'turn.terminal_effects_owed';
    const isSettled = event.source.event === 'turn.terminal_effects_settled';
    const sequence = event.source.fields.sequence;

    if ((!isOwed && !isSettled) || sequence === undefined) continue;

    if (isOwed) observations += 1;

    const object = event.$workers.durableObjectId ?? '';
    let sequences = states.get(object);

    if (sequences === undefined) {
      sequences = new Map();
      states.set(object, sequences);
    }

    const state = sequences.get(sequence);

    if (state === undefined) sequences.set(sequence, { latest: event, observed: isOwed });
    else {
      state.observed ||= isOwed;

      if (event.timestamp > state.latest.timestamp || (event.timestamp === state.latest.timestamp && isSettled)) state.latest = event;
    }
  }

  const settled: EffectSample[] = [];
  const owed: EffectSample[] = [];

  for (const [object, sequences] of states) {
    for (const [sequence, { latest, observed }] of sequences) {
      if (!observed) continue;
      const isSettled = latest.source.event === 'turn.terminal_effects_settled';
      const sample = { object, sequence, detail: isSettled ? 'settled after owing' : `owed ${latest.source.fields.owed ?? ''}` };

      (isSettled ? settled : owed).push(sample);
    }
  }

  return { observations, settled, owed };
}

/** What one version did, as `version` reads it. */
export interface VersionRead {
  /** Its invocations that did not end `ok`, by outcome and entrypoint. */
  readonly ended: readonly { readonly outcome: string; readonly entrypoint: string; readonly count: number; readonly objects: number }[];
  /** One exception per entrypoint whose invocations ended in one a code update did not cause. */
  readonly thrown: readonly ExceptionSample[];
  /** Its invocations a deploy rolled over: the runtime ended each with {@link CODE_UPDATE_RESET}, by entrypoint. */
  readonly deployResets: readonly { readonly entrypoint: string; readonly count: number }[];
  readonly effects: {
    readonly failed: number; readonly failedTurns: number;
    readonly failedSample?: EffectSample;
    readonly terminal: TerminalEffectStates;
  };
  readonly startups: readonly StartupHour[];
  /** Alarms with nothing to watch, by object-hour; see {@link idleWakeHours}. */
  readonly idleWakes: readonly ObjectHourCount[];
}

export interface ObjectMinuteCount { readonly object: string; readonly minute: number; readonly count: number }

export interface ObjectHourCount { readonly object: string; readonly hour: number; readonly count: number }

/** The alarms in `alarms` with no `work` minute of their object within {@link IDLE_WAKE_DISTANCE_MS}, by object-hour. */
export function idleWakeHours(alarms: readonly ObjectMinuteCount[], work: readonly ObjectMinuteCount[]): ObjectHourCount[] {
  const worked = new Set(work.map((row) => `${row.object}@${String(row.minute)}`));
  const idle = new Map<string, ObjectHourCount>();

  for (const alarm of alarms) {
    let near = false;

    for (let offset = -IDLE_WAKE_DISTANCE_MS; offset <= IDLE_WAKE_DISTANCE_MS && !near; offset += MINUTE_MS) {
      near = worked.has(`${alarm.object}@${String(alarm.minute + offset)}`);
    }

    if (near) continue;
    const hour = Math.floor(alarm.minute / HOUR_MS) * HOUR_MS;
    const key = `${alarm.object}@${String(hour)}`;
    idle.set(key, { object: alarm.object, hour, count: (idle.get(key)?.count ?? 0) + alarm.count });
  }

  return [...idle.values()];
}

/** One finding: `what` names its kind, stable from deploy to deploy, so a report can say whether it is new. */
export interface VersionFinding {
  readonly what: string;
  readonly finding: string;
}

function exceptionText(sample: ExceptionSample): string {
  return `"${sample.message}", in request ${sample.request}${sample.object === '' ? '' : ` of object ${sample.object}`}`;
}

function effectText(sample: EffectSample | undefined): string {
  return sample === undefined ? '' : `; e.g. object ${sample.object}, turn ${sample.sequence}: ${sample.detail}`;
}

/** The runtime's error for a call a code deploy cut off (platform-catalog.ts do.reset.transient): the deploy, not the version. */
const CODE_UPDATE_RESET = PLATFORM_CATALOG['do.reset.transient'].observable.find((seen) => seen.context === 'code deploy')?.message ?? '';

/** An entrypoint's uncaught exceptions, less those a code update caused. */
function versionThrew(deployResets: VersionRead['deployResets'], row: VersionRead['ended'][number]): number {
  return row.count - (deployResets.find((reset) => reset.entrypoint === row.entrypoint)?.count ?? 0);
}

/** Each signal `read` holds that a deploy reports whatever its tests said. A canceled or aborted invocation is the
 *  caller going away, and one a code update reset is the deploy rolling over, not the version failing. */
export function versionFindings(read: VersionRead): VersionFinding[] {
  const findings: VersionFinding[] = [];

  for (const row of read.ended) {
    const threw = row.outcome === 'exception' ? versionThrew(read.deployResets, row) : 0;

    if (threw > 0) {
      const sample = read.thrown.find((thrown) => thrown.entrypoint === row.entrypoint);

      findings.push({
        what: `uncaught exceptions in ${row.entrypoint}`,
        finding: `${String(threw)} invocation(s) of ${row.entrypoint} ended in an uncaught exception${sample === undefined ? ', and none left its text' : `: ${exceptionText(sample)}`}`,
      });
    } else if (row.outcome.startsWith('exceeded')) {
      findings.push({ what: `${row.entrypoint} ended by the platform (${row.outcome})`, finding: `${String(row.count)} invocation(s) of ${row.entrypoint} ended with ${row.outcome}, resetting ${String(row.objects)} object(s)` });
    }
  }

  if (read.effects.failed > 0) {
    findings.push({
      what: 'failed terminal effects',
      finding: `${String(read.effects.failed)} terminal effect run(s) failed, in ${String(read.effects.failedTurns)} turn(s)${effectText(read.effects.failedSample)}`,
    });
  }

  if (read.effects.terminal.owed.length > 0) {
    findings.push({ what: 'owed terminal effects', finding: `${String(read.effects.terminal.owed.length)} terminal sequence(s) still owed at the window's end${effectText(read.effects.terminal.owed[0])}` });
  }

  for (const loop of findWakeLoops(read.startups)) {
    findings.push({ what: 'a wake loop', finding: `object ${loop.object} started ${String(loop.peakPerHour)} times in an hour, ${String(loop.loopHours)} such hour(s)` });
  }

  for (const idle of read.idleWakes) {
    findings.push({ what: 'idle wakes', finding: `object ${idle.object} woke ${String(idle.count)} time(s) with nothing to watch in the hour from ${iso(idle.hour)}` });
  }

  return findings;
}

/** One exception per entrypoint in `entrypoints`, each sampled from that entrypoint's own: one sample of all of them
 *  held none of an entrypoint that threw 20 times beside two that threw 184 (staging, 2026-10-08). Its text is the last
 *  line the request logged, the error that ended it; the object is the invocation's, or, for an RPC entrypoint, the
 *  call's in its trace that has one. The first exception a code update did not cause is the one shown. */
async function exceptionSamples(t: Telemetry, scope: readonly Filter[], entrypoints: ReadonlySet<string>): Promise<ExceptionSample[]> {
  const samples: ExceptionSample[] = [];

  for (const entrypoint of entrypoints) {
    const sample = await exceptionSample(t, scope, entrypoint);

    if (sample !== undefined) samples.push(sample);
  }

  return samples;
}

async function exceptionSample(t: Telemetry, scope: readonly Filter[], entrypoint: string): Promise<ExceptionSample | undefined> {
  const ended = await t.sampleEvents([
    ...scope, eq('$metadata.type', 'cf-worker-event'), eq('$workers.outcome', 'exception'), eq('$workers.entrypoint', entrypoint),
  ], 10);

  // A reset ends every call the object was serving, but only the invocation that met it logs its words: a sample
  // without text gives way to a later one with it.
  let textless: ExceptionSample | undefined;

  for (const event of ended) {
    const request = event.$metadata.requestId ?? '';

    if (request === '') continue;
    const logged = await t.sampleEvents([eq('$metadata.requestId', request), eq('$metadata.type', 'cf-worker')], 20);

    const message = [...logged].sort((a, b) => b.timestamp - a.timestamp)
      .map((line) => line.$metadata.error ?? line.source.message ?? '').find((text) => text !== '') ?? '';

    if (message === CODE_UPDATE_RESET || (message === '' && textless !== undefined)) continue;
    const own = event.$workers.durableObjectId ?? '';
    const trace = event.$metadata.traceId ?? '';
    const traced = own !== '' || trace === '' ? [] : await t.sampleEvents([eq('$metadata.traceId', trace), eq('$metadata.type', 'cf-worker-event')], 20);

    const sample = {
      entrypoint,
      message,
      object: own !== '' ? own : traced.map((call) => call.$workers.durableObjectId ?? '').find((id) => id !== '') ?? '',
      request,
    };

    if (message !== '') return sample;
    textless = sample;
  }

  return textless;
}

/** The first event of `event` for the version, as an effect sample. */
async function effectSample(t: Telemetry, scope: readonly Filter[], event: string): Promise<EffectSample | undefined> {
  const [first] = await t.sampleEvents([...scope, eq('event', event)], 1);

  if (first === undefined) return undefined;
  const { fields, code, cause } = first.source;

  return {
    object: first.$workers.durableObjectId ?? '',
    sequence: fields.sequence ?? '',
    detail: fields.effect === undefined ? `owed ${fields.owed ?? ''}` : `${fields.effect} (${code ?? ''}): ${cause ?? ''}`,
  };
}

async function versionRead(t: Telemetry, versionId: string): Promise<VersionRead> {
  const scope = [eq('$workers.scriptVersion.id', versionId)];
  const invocations = [...scope, eq('$metadata.type', 'cf-worker-event')];
  const notOk: Filter = { key: '$workers.outcome', operation: 'neq', value: 'ok', type: 'string' };
  const ended = await t.count({ filters: [...invocations, notOk], groupBy: ['$workers.outcome', '$workers.entrypoint'], distinct: DO_ID, limit: 100 });

  // One runtime error line per invocation the reset ended; their request ids need not be theirs (staging 3fe2aa81: three
  // KinuDevbox calls ended at 02:41:09.120Z, and all three lines named one request).
  const deployResets = await t.count({
    filters: [...scope, eq('$metadata.type', 'cf-worker'), eq('$metadata.error', CODE_UPDATE_RESET)], groupBy: ['$workers.entrypoint'], limit: 100,
  });

  const failed = await t.count({ filters: [...scope, eq('event', 'turn.terminal_effect_failed')], groupBy: ['fields.sequence'], limit: 500 });
  const { events: terminal, sampling: terminalSampling } = await t.events([...scope, { key: 'event', operation: 'includes', value: 'turn.terminal_effects_', type: 'string' }], EVENT_CAP);

  if (terminal.length === EVENT_CAP || terminalSampling > 1) {
    throw new Error('terminal-effect history is capped or sampled; narrow the window before classifying its sequences');
  }

  const alarm = eq('$workers.eventType', 'alarm');
  const alarms = await perMinute(t, [...invocations, alarm]);
  const called = await perMinute(t, [...invocations, { ...alarm, operation: 'neq' }]);
  const modelCalls = await perMinute(t, [...scope, eq('$metadata.type', 'cf-worker'), eq('event', 'provider.stream_opened')]);
  const total = (rows: readonly { readonly count: number }[]): number => rows.reduce((sum, row) => sum + row.count, 0);

  const read = {
    ended: ended.map((row) => ({ outcome: row.groups[0] ?? '', entrypoint: row.groups[1] ?? '', count: row.count, objects: row.distinct })),
    deployResets: deployResets.map((row) => ({ entrypoint: row.groups[0] ?? '', count: row.count })),
  };

  const threw = new Set(read.ended.filter((row) => row.outcome === 'exception' && versionThrew(read.deployResets, row) > 0)
    .map((row) => row.entrypoint));

  return {
    ...read,
    thrown: threw.size === 0 ? [] : await exceptionSamples(t, scope, threw),
    effects: {
      failed: total(failed), failedTurns: failed.length,
      failedSample: failed.length === 0 ? undefined : await effectSample(t, scope, 'turn.terminal_effect_failed'),
      terminal: terminalEffectStates(terminal),
    },
    startups: await startupHours(t, scope),
    idleWakes: idleWakeHours(alarms, [...called, ...modelCalls]),
  };
}

/** Per object and minute. */
async function perMinute(t: Telemetry, filters: readonly Filter[]): Promise<ObjectMinuteCount[]> {
  const rows = await t.buckets({ filters, groupBy: [DO_ID], limit: MINUTE_GROUPS_CAP }, MINUTE_MS);

  if (new Set(rows.map((row) => row.groups[0])).size >= MINUTE_GROUPS_CAP) {
    throw new Error('a per-minute read reached its object cap; narrow the window before reading idle wakes');
  }

  return rows.map((row) => ({ object: row.groups[0] ?? '', minute: row.at, count: row.count }));
}

/** `version`: its findings printed and, under a deploy, written into its report. A window that cannot be read is a
 *  finding of its own: a deploy cannot say what its version did. */
async function versionCommand(args: Args): Promise<number> {
  const subject = args.target ?? '';
  let findings: VersionFinding[];
  let sampling = 1;
  let terminal: TerminalEffectStates | undefined;

  try {
    const t = new Telemetry(await readToken(), args);

    const read = await versionRead(t, subject);

    terminal = read.effects.terminal;
    findings = versionFindings(read);
    sampling = t.sampling;
  } catch (cause) {
    findings = [{ what: 'the telemetry', finding: `${args.worker}'s telemetry for version ${subject} could not be read: ${cause instanceof Error ? cause.message : String(cause)}` }];
  }

  const dir = process.env['KINU_DEPLOY_REPORT'] ?? '';

  for (const found of findings) if (dir !== '') recordStep(dir, { phase: 'telemetry', what: found.what, finding: found.finding });

  const window = { from: iso(args.from), to: iso(args.to) };

  console.log(args.json
    ? JSON.stringify({ window, version: subject, worker: args.worker, findings, terminalEffects: terminal, sampling }, null, 1)
    : [`${args.worker} version ${subject}, ${window.from} .. ${window.to}:`, ...findings.length === 0 ? ['  nothing to report'] : findings.map((found) => `  ${found.finding}`),
      ...terminal === undefined ? [] : [`terminal effects: ${String(terminal.observations)} owed observation(s), ${String(terminal.settled.length + terminal.owed.length)} sequence(s): ${String(terminal.settled.length)} settled after owing, ${String(terminal.owed.length)} still owed at the window's end`],
      ...sampling > 1 ? [`note: the API sampled this window (level ${String(sampling)}); counts are estimates.`] : []].join('\n'));

  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'live') {
    await live(args);
  } else if (args.mode === 'version') {
    process.exitCode = await versionCommand(args);
  } else {
    const t = new Telemetry(await readToken(), args);
    const run = { query, timeline, errors, wakes }[args.mode];

    await run(t, args);
  }
}
