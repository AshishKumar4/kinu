/**
 * The one thing that turns a typed row into an Analytics Engine data point.
 *
 * ## Everything the platform silently drops, made countable
 *
 * `writeDataPoint` returns `void` and reports nothing. An oversized blob, a
 * 21st double, a 97-byte index and the 251st write in an invocation all produce
 * the same observable result as a successful write: nothing. So a dataset that
 * is missing half its rows reads exactly like a dataset that is complete, and
 * the only way to find out is to already suspect it.
 *
 * Every one of those limits is therefore enforced here, where the outcome can be
 * counted. `AnalyticsStats` is not decoration: `clamped` rising means a slot's
 * byte budget is too small for real data, `refused` rising means a unit of work
 * is producing more rows than the platform will take, and `skipped` rising means
 * the binding is absent — three different problems that the platform reports
 * identically.
 *
 * ## The window, and where it stops being exact
 *
 * The platform's write cap is per INVOCATION. An invocation is not a thing this
 * module can observe, so the cap is applied to a WINDOW that a caller opens at
 * every seam an invocation is known to begin: the Worker's fetch and scheduled
 * entries, an actor's turn, and each Durable Object's own RPC gate. Opening it
 * once per ACTIVATION instead would be one budget for the whole life of a hot
 * object, which is how a fleet singleton stopped producing audit evidence after
 * its 250th row and stayed silent until eviction.
 *
 * TWO WAYS IT IS STILL INEXACT, both in the safe direction and neither silent.
 * An actor's turn may span invocations, so past 250 rows in one turn it can
 * refuse a write the platform would have accepted. And the plane is memoised on
 * the ENVIRONMENT object, which a Worker shares across concurrent requests, so a
 * second request's entry re-opens the counter mid-flight of the first — the
 * shared window bounds neither request exactly. Both cases are counted as
 * `refused` and reported once per window.
 *
 * ONE WINDOW FOR ALL THREE DATASETS, because the platform's sentence is "each
 * call to `writeDataPoint` counts towards this limit" — the cap is per
 * invocation, not per dataset. Three private budgets of 250 would be a cap of
 * 750.
 *
 * ## Why nothing here throws
 *
 * Every call site is fire-and-forget from inside a turn, a route handler or a
 * `.catch()`. A telemetry write that can fail a turn is worse than no telemetry.
 */
import { diagnostics } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { MAX_WRITES_PER_INVOCATION } from './limits';
import {
  AGENT_METRICS_SCHEMA, ANALYTICS_SCHEMAS, CONTROL_PLANE_OPS_SCHEMA,
  FEEDBACK_MARKERS_SCHEMA,
  type AnalyticsRow, type AnalyticsSchema,
} from './schemas';

/**
 * A double the platform can store. A schema rather than a `typeof` pair because
 * the two conditions are one contract — AE takes a finite double, and `NaN` from
 * arithmetic over an absent usage field is exactly the value that must not be
 * mistaken for one.
 */
export const FiniteNumber = v.pipe(v.number(), v.finite());

/**
 * The Analytics Engine members of the Worker's environment. A structural type
 * rather than the global `Env` so a test can hand this module a fake binding
 * without standing up fifty unrelated ones, and so nothing here depends on the
 * order in which the binding declaration and the writer land.
 *
 * ALL THREE ARE OPTIONAL, and that is the deployment contract: a Worker with no
 * analytics datasets bound must run normally and write nothing, because the
 * alternative is a deployment that cannot boot until an observability binding
 * exists.
 */
export interface AnalyticsEnv {
  readonly AGENT_METRICS?: AnalyticsEngineDataset;
  readonly FEEDBACK_MARKERS?: AnalyticsEngineDataset;
  readonly CONTROL_PLANE_OPS?: AnalyticsEngineDataset;
}

/** What happened to the rows this writer was given. Every counter is a distinct
 *  failure the platform reports identically, which is the reason they are
 *  separate rather than one `dropped`. */
export interface AnalyticsStats {
  /** Points handed to the platform. */
  readonly written: number;
  /** Points not written because the dataset is not bound. */
  readonly skipped: number;
  /** Points not written because the window's budget was spent. */
  readonly refused: number;
  /** Slots cut to their declared byte bound. The row was still written. */
  readonly clamped: number;
  /** Doubles that were not finite and were written as 0. */
  readonly coerced: number;
}

interface MutableStats {
  written: number;
  skipped: number;
  refused: number;
  clamped: number;
  coerced: number;
}

export interface AnalyticsWriter<S extends AnalyticsSchema> {
  write(row: AnalyticsRow<S>): void;
  readonly stats: AnalyticsStats;
}

/**
 * The per-invocation write budget, shared by every dataset.
 *
 * `open` starts a new window. It does NOT top up a running one: a caller that
 * opens twice inside one invocation would otherwise be granted 500 writes, and
 * the whole value of the cap is that it bounds what one invocation can attempt.
 */
export interface AnalyticsWindow {
  open(): void;
  /** Claim one write. False when the window is spent. */
  take(): boolean;
  readonly remaining: number;
  readonly refused: number;
}

function createAnalyticsWindow(capacity = MAX_WRITES_PER_INVOCATION): AnalyticsWindow {
  let remaining = capacity;
  let refused = 0;
  return {
    open() {
      remaining = capacity;
    },
    take() {
      if (remaining <= 0) {
        refused += 1;
        // Once per window, not once per refusal: a unit of work producing
        // thousands of rows would otherwise report the overflow thousands of
        // times, on the sink the overflow is already crowding.
        if (refused === 1) {
          diagnostics.event('analytics.window_exhausted', { capacity });
        }
        return false;
      }
      remaining -= 1;
      return true;
    },
    get remaining() {
      return remaining;
    },
    get refused() {
      return refused;
    },
  };
}

const ENCODER = new TextEncoder();
/** Non-fatal: the input is already valid UTF-16, so the only ill-formed bytes a
 *  decode can meet are the ones this module's own cut created, and it backs off
 *  to a code-point boundary before decoding. */
const DECODER = new TextDecoder();

/** UTF-8 continuation bytes are `10xxxxxx`. */
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BITS = 0x80;

/** A value cut to a slot's byte bound, and whether the cut happened. Named
 *  rather than inferred so the two facts travel together: a caller that read the
 *  text and dropped the flag would lose the only evidence a slot's budget is too
 *  small for real data. */
interface ClampedText {
  readonly text: string;
  readonly clamped: boolean;
}

/**
 * `value` cut to at most `maxBytes` UTF-8 bytes, never mid-character, with
 * whether it was cut. Byte-measured rather than length-measured because the
 * platform's budget is bytes: a 96-character index of emoji is 384 of them.
 */
function clampToBytes(value: string, maxBytes: number): ClampedText {
  const bytes = ENCODER.encode(value);
  if (bytes.length <= maxBytes) return { text: value, clamped: false };
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & CONTINUATION_MASK) === CONTINUATION_BITS) cut -= 1;
  return { text: DECODER.decode(bytes.subarray(0, cut)), clamped: true };
}

/**
 * A row read by slot NAME.
 *
 * A parameter type rather than a cast at the read: `AnalyticsRow<S>` is a mapped
 * type whose keys are exactly the schema's slot names, so passing one here is
 * plain assignability and the writer never has to claim anything about its own
 * argument. The three call sites below — the index, the blob loop and the double
 * loop — are what make it a function rather than a local.
 */
type SlotLookup = Readonly<Record<string, string | number>>;

function slotOf(row: SlotLookup, name: string): string | number | undefined {
  return row[name];
}

/**
 * A writer over one dataset. `dataset` absent means the binding is not declared
 * on this deployment: the writer still projects nothing and counts, so "we are
 * not writing because there is no binding" is distinguishable from "we are not
 * writing because nothing called us".
 */
function createAnalyticsWriter<S extends AnalyticsSchema>(
  dataset: AnalyticsEngineDataset | undefined,
  schema: S,
  window: AnalyticsWindow,
): AnalyticsWriter<S> {
  const stats: MutableStats = { written: 0, skipped: 0, refused: 0, clamped: 0, coerced: 0 };
  return {
    stats,
    write(row: AnalyticsRow<S>): void {
      if (!dataset) {
        stats.skipped += 1;
        return;
      }
      if (!window.take()) {
        stats.refused += 1;
        return;
      }
      const index = clampToBytes(
        String(slotOf(row, schema.index.name) ?? ''), schema.index.maxBytes,
      );
      if (index.clamped) stats.clamped += 1;
      const blobs: string[] = [];
      for (const slot of schema.blobs) {
        const held = clampToBytes(String(slotOf(row, slot.name) ?? ''), slot.maxBytes);
        if (held.clamped) stats.clamped += 1;
        blobs.push(held.text);
      }
      const doubles: number[] = [];
      for (const slot of schema.doubles) {
        const held = slotOf(row, slot.name);
        if (v.is(FiniteNumber, held)) {
          doubles.push(held);
          continue;
        }
        // A NaN reaches here from arithmetic over an absent usage field, and
        // writing it would make one row's absence indistinguishable from the
        // whole column being broken. Zero, counted.
        stats.coerced += 1;
        doubles.push(0);
      }
      dataset.writeDataPoint({ indexes: [index.text], blobs, doubles });
      stats.written += 1;
    },
  };
}

/** The three writers, the schemas they project, and the window they share. The
 *  census travels with the writers so the set a caller can ask for and the set
 *  this module builds cannot drift apart silently. */
export interface AnalyticsPlane {
  readonly agent: AnalyticsWriter<typeof AGENT_METRICS_SCHEMA>;
  readonly feedback: AnalyticsWriter<typeof FEEDBACK_MARKERS_SCHEMA>;
  readonly ops: AnalyticsWriter<typeof CONTROL_PLANE_OPS_SCHEMA>;
  readonly window: AnalyticsWindow;
  readonly schemas: typeof ANALYTICS_SCHEMAS;
}

/**
 * The plane for one environment, memoised on the environment OBJECT.
 *
 * Memoised because the window is state: a fresh plane per call would be a fresh
 * budget per call, which is a cap of infinity. Keyed on the object rather than on
 * a module-level singleton because a Durable Object and the Worker that routes to
 * it are different isolates with different environments, and the isolate a write
 * happens in is not something a call site should have to know.
 */
const PLANES = new WeakMap<AnalyticsEnv, AnalyticsPlane>();

export function analyticsPlane(env: AnalyticsEnv): AnalyticsPlane {
  const existing = PLANES.get(env);
  if (existing) return existing;
  const window = createAnalyticsWindow();
  // Built FROM the census rather than beside it: a dataset added to
  // `ANALYTICS_SCHEMAS` lands here, and a binding the env declares that no
  // schema claims is a type error on `AnalyticsEnv` itself.
  const plane = {
    window,
    agent: createAnalyticsWriter(env.AGENT_METRICS, AGENT_METRICS_SCHEMA, window),
    feedback: createAnalyticsWriter(env.FEEDBACK_MARKERS, FEEDBACK_MARKERS_SCHEMA, window),
    ops: createAnalyticsWriter(env.CONTROL_PLANE_OPS, CONTROL_PLANE_OPS_SCHEMA, window),
    schemas: ANALYTICS_SCHEMAS,
  } satisfies AnalyticsPlane;
  PLANES.set(env, plane);
  return plane;
}

/**
 * Start a new write window for this environment.
 *
 * Called at every seam where a bounded unit of work begins: the Worker's fetch
 * and scheduled entries, an actor's turn, and the RPC gate of each Durable
 * Object that writes rows. A constructor is NOT such a seam — it runs once per
 * activation, and the platform's budget is per invocation.
 */
export function openAnalyticsWindow(env: AnalyticsEnv): void {
  analyticsPlane(env).window.open();
}
