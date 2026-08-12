/**
 * Step telemetry — the aggregates over a bounded sample of finished steps.
 *
 * Every input here is a provider-reported number. Nothing in this file
 * estimates: it counts, divides and sorts what the API already said. The one
 * locally-computed thing a step carries (the context breakdown) is deliberately
 * NOT aggregated — averaging an estimate makes it look sturdier than it is.
 *
 * The retained sample IS the run-event log. `step_finish` rows are durable and
 * indexed by type, so a percentile can be taken over the last N of them without
 * a second store, a ring buffer, or a background roll-up. N is passed in and
 * reported back on the result, because a p95 whose window you cannot see is a
 * number you cannot check.
 */

import type { StepUsage } from './types.js';

/** How much of the newest sample one EMA step absorbs. 0.2 ≈ a nine-step
 *  effective window: fast enough to show a cache break within a turn, slow
 *  enough that one cold step does not read as a regression. */
export const CACHE_HIT_EMA_ALPHA = 0.2;

/**
 * The ONE cache-hit definition: cached input over total input.
 *
 * `cached` is a SUBSET of `input` — ai v6 reports the cache-inclusive total —
 * so this is a share of the prompt that was read from cache, never a ratio
 * over a different base. Null when the step reported no input tokens at all:
 * a step with nothing to cache has no hit rate, and 0% would read as a miss.
 */
export function cacheHitRate(usage: { input: number; cached: number }): number | null {
  if (usage.input <= 0) return null;
  return usage.cached / usage.input;
}

/** Distribution of cache hit rate over the sample. Every field is null when
 *  no step in the window reported input tokens. */
export interface CacheHitStats {
  /** Steps that contributed a rate (steps with no input tokens are excluded). */
  readonly samples: number;
  readonly last: number | null;
  readonly mean: number | null;
  /** Nearest-rank 95th percentile — the good tail, since higher is better. */
  readonly p95: number | null;
  readonly ema: number | null;
  readonly emaAlpha: number;
}

/** Everything the sample says, and what it could not say. */
export interface StepTelemetry {
  /** Steps in the window. */
  readonly steps: number;
  /** The window actually read back, so a reader can see the bound. */
  readonly windowLimit: number;
  readonly tokens: { input: number; cached: number; output: number; reasoning: number };
  readonly cacheHit: CacheHitStats;
  /** Summed USD of the steps that carried a catalog price. */
  readonly usd: number;
  /** Steps priced from the models.dev catalog. */
  readonly pricedSteps: number;
  /** Steps whose model had no catalog rate. Their cost is NOT in `usd` and is
   *  NOT estimated — an unpriced step is reported as unpriced. */
  readonly unpricedSteps: number;
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

/** Aggregate a time-ordered (oldest first) sample of finished steps. */
export function summarizeSteps(
  samples: readonly StepUsage[],
  opts: { windowLimit: number; emaAlpha?: number },
): StepTelemetry {
  const alpha = opts.emaAlpha ?? CACHE_HIT_EMA_ALPHA;
  const tokens = { input: 0, cached: 0, output: 0, reasoning: 0 };
  const rates: number[] = [];
  let ema: number | null = null;
  let usd = 0;
  let pricedSteps = 0;
  let unpricedSteps = 0;

  for (const step of samples) {
    tokens.input += step.input;
    tokens.cached += step.cached;
    tokens.output += step.output;
    tokens.reasoning += step.reasoning;
    if (step.usd === undefined) unpricedSteps++;
    else {
      usd += step.usd;
      pricedSteps++;
    }
    const rate = cacheHitRate(step);
    if (rate === null) continue;
    rates.push(rate);
    ema = ema === null ? rate : alpha * rate + (1 - alpha) * ema;
  }

  const sorted = [...rates].sort((a, b) => a - b);
  return {
    steps: samples.length,
    windowLimit: opts.windowLimit,
    tokens,
    cacheHit: {
      samples: rates.length,
      last: rates.length > 0 ? (rates[rates.length - 1] ?? null) : null,
      mean: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      p95: percentile(sorted, 0.95),
      ema,
      emaAlpha: alpha,
    },
    usd,
    pricedSteps,
    unpricedSteps,
  };
}
