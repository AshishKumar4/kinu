/**
 * The telemetry windows staging deploys have read, kept until every row of their events can have landed.
 *
 * A deploy reads its own version's window once the counts hold still past `SETTLE_HOLD_MS` (prod-logs.ts), which
 * covers 99.96% of rows. The rest land later, measured up to 151 min after their event. So each deploy keeps its
 * window with the count of every signal it found, and every later deploy reads each kept window once more beside its
 * own. Every signal is a counter late rows can only raise (prod-logs.ts `versionSignals`): one the window did not hold
 * before, or one that grew by more than its offset grew (a reset row that landed late takes back an exception, not a
 * red), landed late and is that deploy's red, named for the version that served it. A window stays kept until a read
 * that began `LATE_HORIZON_MS` past its end, so a late red is reported by a later deploy, never lost; one no deploy
 * read again within the logs' retention is reported as lost, never dropped silently.
 *
 * Each window is an object of its own, keyed by its version and start, so two deploys never rewrite one another's: a
 * deploy adds its own window and updates or retires only the windows it read, merging counts by their maximum, which
 * is the newest of a counter. Two that read one window at once may both report what landed in it; neither loses it.
 */

import * as v from 'valibot';
import { KinuError } from '@kinu.run/core/obs';
import { restAnswer, restCall } from './cloudflare-rest';
import { restApiToken } from './cloudflare-token';
import { requireCloudflareAccountId } from './infra-cloudflare';
import { type InfraEnvironment, bucketOf, deployedConfig } from './infra-manifest';

/** Beside the reset records, in the deployment's releases bucket, which a reset keeps. */
export const WINDOWS_PREFIX = 'telemetry/windows/';

/** A kept window's object: one under `WINDOWS_PREFIX`. The single `telemetry/windows.json` that 76e10e84b's deploys
 *  wrote held findings by their words, which nothing compares now, so it is not a window and no reader lists it. */
export const isWindowKey = (key: string): boolean => key.startsWith(WINDOWS_PREFIX) && key.endsWith('.json');

/** Past the latest row measured: an `actor.startup` 126-151 min after its event (staging 2026-10-08, prod-logs.ts
 *  `SETTLE_CAP_MS`). */
export const LATE_HORIZON_MS = 3 * 60 * 60_000;

/** How long Workers Logs keeps an event: about 7 days (packages/cf-backend/wrangler.jsonc, `observability`). */
export const LOGS_RETENTION_MS = 7 * 24 * 60 * 60_000;

export const TelemetryWindowSchema = v.object({
  worker: v.string(),
  version: v.string(),
  from: v.string(),
  to: v.string(),
  /** Each signal's counters at its reads so far, by its key; null for a window never read to a settled answer. */
  measures: v.nullable(v.record(v.string(), v.object({ count: v.number(), offset: v.number() }))),
});

export type TelemetryWindow = v.InferOutput<typeof TelemetryWindowSchema>;

/** A report's finding: what it is about, and its words. */
export interface WindowFinding {
  readonly what: string;
  readonly finding: string;
}

/** What a window's rows count, as a later read compares it: a key that names the signal whatever its words, a count
 *  late rows can only raise, and an offset that takes some of it back (the invocations a deploy reset, of those that
 *  threw), which late rows can only raise too. */
export interface WindowSignal extends WindowFinding {
  readonly key: string;
  readonly count: number;
  readonly offset?: number;
}

export interface KeptWindow {
  readonly key: string;
  readonly window: TelemetryWindow;
}

/** A kept window read again, stamped with the time its read began: what it holds now, why it could not be read, or
 *  that the logs no longer hold it. A key whose object another deploy retired since the listing is `gone`; one whose
 *  object could not be read at all is `unreadable`. */
export type Reread =
  | (KeptWindow & { readonly readAt: number } & ({ readonly found: readonly WindowSignal[] } | { readonly failed: string } | { readonly expired: true }))
  | { readonly key: string; readonly gone: true }
  | { readonly key: string; readonly unreadable: string };

/** Where the windows are kept. */
export interface WindowStore {
  readonly list: () => Promise<string[]>;
  readonly get: (key: string) => Promise<string>;
  readonly put: (kept: KeptWindow) => Promise<void>;
  readonly remove: (keys: readonly string[]) => Promise<void>;
}

/** A window's object, by its version and its start: one version read twice is two windows. */
export const windowKey = (window: Pick<TelemetryWindow, 'version' | 'from'>): string => `${WINDOWS_PREFIX}${window.version}-${String(Date.parse(window.from))}.json`;

const ListSchema = v.object({
  success: v.literal(true),
  result: v.array(v.object({ key: v.string() })),
  result_info: v.optional(v.object({ is_truncated: v.optional(v.boolean()) })),
});

const RemovedSchema = v.object({ success: v.literal(true) });

/** The objects under `WINDOWS_PREFIX` in `environment`'s releases bucket, through the REST API, which lists them. */
export function windowStore(environment: InfraEnvironment): WindowStore {
  const bucket = bucketOf(deployedConfig(environment), 'RELEASES_BUCKET');

  if (bucket === undefined) throw new Error(`the ${environment} deployment binds no RELEASES_BUCKET to keep its telemetry windows in`);
  const token = restApiToken();

  if (token === '') throw new Error('the telemetry windows are kept through the REST API, and no REST token is set (KINU_CLOUDFLARE_API_TOKEN)');
  const objects = `/accounts/${requireCloudflareAccountId()}/r2/buckets/${bucket}/objects`;

  return {
    list: async () => {
      const page = await restCall({ method: 'GET', path: `${objects}?prefix=${encodeURIComponent(WINDOWS_PREFIX)}&per_page=1000`, token }, ListSchema);

      if (page.result_info?.is_truncated === true) throw new Error(`${bucket} keeps more than 1000 telemetry windows; none is past ${String(LATE_HORIZON_MS / 3_600_000)} h`);

      return page.result.map((object) => object.key).filter(isWindowKey);
    },
    get: async (key) => restAnswer({ method: 'GET', path: `${objects}/${key}`, token }),
    put: async ({ key, window }) => {
      await restAnswer({ method: 'PUT', path: `${objects}/${key}`, token, body: window });
    },
    remove: async (keys) => {
      if (keys.length > 0) await restCall({ method: 'DELETE', path: objects, token, body: keys }, RemovedSchema);
    },
  };
}

/** Every window `store` keeps, read again by `read`, each stamped with when its read began. A window older than the
 *  logs' retention is not read: an empty answer from it would say nothing landed when the logs only forgot it. */
export async function rereadWindows(store: WindowStore, read: (window: TelemetryWindow) => Promise<readonly WindowSignal[]>, now: () => number): Promise<Reread[]> {
  const keys = await store.list();

  return Promise.all(keys.map(async (key): Promise<Reread> => {
    let window: TelemetryWindow;

    try {
      window = v.parse(TelemetryWindowSchema, JSON.parse(await store.get(key)));
    } catch (cause) {
      if (cause instanceof KinuError && cause.code === 'missing') return { key, gone: true };

      return { key, unreadable: cause instanceof Error ? cause.message : String(cause) };
    }

    const readAt = now();

    if (readAt - Date.parse(window.from) >= LOGS_RETENTION_MS) return { key, window, readAt, expired: true };

    try {
      return { key, window, readAt, found: await read(window) };
    } catch (cause) {
      return { key, window, readAt, failed: cause instanceof Error ? cause.message : String(cause) };
    }
  }));
}

/** A signal its window's earlier reads did not hold, or whose count grew by more than its offset did. */
function landedLate(window: TelemetryWindow, signal: WindowSignal): boolean {
  const before = window.measures?.[signal.key];

  return before === undefined || signal.count - before.count > (signal.offset ?? 0) - before.offset;
}

type Measures = NonNullable<TelemetryWindow['measures']>;

/** Two reads' counters, each the larger: a counter only rises, so the larger is the newer. */
export function mergeMeasures(left: Measures | null, right: Measures | null): Measures {
  const merged: Measures = { ...left };

  for (const [key, counters] of Object.entries(right ?? {})) {
    const held = merged[key];

    merged[key] = held === undefined ? counters : { count: Math.max(held.count, counters.count), offset: Math.max(held.offset, counters.offset) };
  }

  return merged;
}

/**
 * What re-reading the kept windows reports, and what to write back: each window's counts raised to what its read found,
 * or the window retired when that read began `LATE_HORIZON_MS` or more past its end. A window that could not be read
 * stays as it was, and says so; one past the logs' retention is retired, and says what was lost.
 */
export function afterRereads(rereads: readonly Reread[]) {
  const late: WindowFinding[] = [];
  const puts: KeptWindow[] = [];
  const removes: string[] = [];

  for (const reread of rereads) {
    if ('gone' in reread) continue;

    if ('unreadable' in reread) {
      late.push({ what: 'a kept telemetry window', finding: `the kept window ${reread.key} could not be read: ${reread.unreadable}; it stays for the next deploy` });
      continue;
    }

    const { key, window } = reread;
    const span = `${window.from} .. ${window.to}`;

    if ('failed' in reread) {
      late.push({ what: `version ${window.version}'s kept window`, finding: `${window.worker}'s telemetry for version `
        + `${window.version} (${span}) could not be read again: ${reread.failed}; it stays kept for the next deploy` });
      continue;
    }

    if ('expired' in reread) {
      late.push({ what: `version ${window.version}'s kept window`, finding: `${window.worker}'s telemetry for version `
        + `${window.version} (${span}) is past the logs' retention, and no deploy read it again before: a row that landed `
        + 'after its own deploy read it is lost' });
      removes.push(key);
      continue;
    }

    for (const signal of reread.found.filter((each) => landedLate(window, each))) {
      late.push({ what: `late, version ${window.version}: ${signal.what}`, finding: `${signal.finding} (in ${span}, landed after its own deploy read it)` });
    }

    if (reread.readAt - Date.parse(window.to) >= LATE_HORIZON_MS) {
      removes.push(key);
      continue;
    }

    puts.push({ key, window: { ...window, measures: mergeMeasures(window.measures, measuresOf(reread.found)) } });
  }

  return { late, puts, removes };
}

/** Each signal's counters, by its key: what a later read of the window compares with. */
export function measuresOf(signals: readonly WindowSignal[]): Measures {
  return Object.fromEntries(signals.map((signal) => [signal.key, { count: signal.count, offset: signal.offset ?? 0 }]));
}

/** The windows `afterRereads` kept, this deploy's own among them, written back, each merged with what another deploy
 *  may have written since it was read; the retired ones removed, never one being written. */
export async function keepWindows(store: WindowStore, puts: readonly KeptWindow[], removes: readonly string[]): Promise<void> {
  const writing = new Set(puts.map((kept) => kept.key));

  await Promise.all([
    ...puts.map(async ({ key, window }) => {
      let stored: Measures | null = null;

      try {
        stored = v.parse(TelemetryWindowSchema, JSON.parse(await store.get(key))).measures;
      } catch (cause) {
        // A window first written now has no object yet; any other failure is no answer.
        if (!(cause instanceof KinuError && cause.code === 'missing')) throw cause;
      }

      await store.put({ key, window: { ...window, measures: window.measures === null && stored === null ? null : mergeMeasures(stored, window.measures) } });
    }),
    store.remove(removes.filter((key) => !writing.has(key))),
  ]);
}
