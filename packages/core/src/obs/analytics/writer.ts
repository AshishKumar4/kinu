/**
 * Typed row → Analytics Engine data point. The platform drops over-limit points silently, so every
 * limit is enforced and counted here. The write cap is per invocation, applied to one window
 * shared by all datasets and opened at each known invocation seam; it can over-refuse (a turn
 * spanning invocations, concurrent requests sharing an env), never under-refuse. Nothing throws.
 */
import { diagnostics } from '../log';
import * as v from 'valibot';
import { MAX_WRITES_PER_INVOCATION } from './limits';
import {
  AGENT_METRICS_SCHEMA, ANALYTICS_SCHEMAS, CONTROL_PLANE_OPS_SCHEMA,
  FEEDBACK_MARKERS_SCHEMA,
  type AnalyticsRow, type AnalyticsSchema,
} from './schemas';

export const FiniteNumber = v.pipe(v.number(), v.finite());

/** Mirrors the platform's `AnalyticsEngineDataPoint` so shared code never names a runtime type. */
export interface AnalyticsDataPoint {
  indexes?: ((ArrayBuffer | string) | null)[];
  doubles?: number[];
  blobs?: ((ArrayBuffer | string) | null)[];
}

export interface AnalyticsDatasetSink {
  writeDataPoint(event?: AnalyticsDataPoint): void;
}

/** All optional: a deployment with no datasets bound runs normally and writes nothing. */
export interface AnalyticsEnv {
  readonly AGENT_METRICS?: AnalyticsDatasetSink;
  readonly FEEDBACK_MARKERS?: AnalyticsDatasetSink;
  readonly CONTROL_PLANE_OPS?: AnalyticsDatasetSink;
}

export interface AnalyticsStats {
  readonly written: number;
  readonly skipped: number;
  readonly refused: number;
  /** Slots cut to their byte bound; the row was still written. */
  readonly clamped: number;
  /** Non-finite doubles written as 0. */
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

/** Per-invocation write budget shared by every dataset. `open` resets it; it never tops up. */
export interface AnalyticsWindow {
  open(): void;
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

        // Reported once per window, not per refusal.
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

const DECODER = new TextDecoder();

/** UTF-8 continuation bytes are `10xxxxxx`. */
const CONTINUATION_MASK = 0xc0;

const CONTINUATION_BITS = 0x80;

interface ClampedText {
  readonly text: string;
  readonly clamped: boolean;
}

/** Cut to at most `maxBytes` UTF-8 bytes, never mid-character; the platform budgets bytes. */
function clampToBytes(value: string, maxBytes: number): ClampedText {
  const bytes = ENCODER.encode(value);

  if (bytes.length <= maxBytes) return { text: value, clamped: false };
  let cut = maxBytes;

  while (cut > 0 && (bytes[cut] & CONTINUATION_MASK) === CONTINUATION_BITS) cut -= 1;

  return { text: DECODER.decode(bytes.subarray(0, cut)), clamped: true };
}

type SlotLookup = Readonly<Record<string, string | number>>;

function slotOf(row: SlotLookup, name: string): string | number | undefined {
  return row[name];
}

/** An absent `dataset` counts `skipped`, distinguishing "unbound" from "never called". */
function createAnalyticsWriter<S extends AnalyticsSchema>(
  dataset: AnalyticsDatasetSink | undefined,
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

        stats.coerced += 1;
        doubles.push(0);
      }

      dataset.writeDataPoint({ indexes: [index.text], blobs, doubles });
      stats.written += 1;
    },
  };
}

export interface AnalyticsPlane {
  readonly agent: AnalyticsWriter<typeof AGENT_METRICS_SCHEMA>;
  readonly feedback: AnalyticsWriter<typeof FEEDBACK_MARKERS_SCHEMA>;
  readonly ops: AnalyticsWriter<typeof CONTROL_PLANE_OPS_SCHEMA>;
  readonly window: AnalyticsWindow;
  readonly schemas: typeof ANALYTICS_SCHEMAS;
}

/** Memoised per env object: the window is state; a fresh plane per call is a fresh budget. */
const PLANES = new WeakMap<AnalyticsEnv, AnalyticsPlane>();

export function analyticsPlane(env: AnalyticsEnv): AnalyticsPlane {
  const existing = PLANES.get(env);

  if (existing) return existing;
  const window = createAnalyticsWindow();

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

/** Call at each invocation seam (entries, turns, DO RPC gates), not in a constructor. */
export function openAnalyticsWindow(env: AnalyticsEnv): void {
  analyticsPlane(env).window.open();
}
