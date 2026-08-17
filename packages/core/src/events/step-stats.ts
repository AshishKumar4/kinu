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

import type { StepCost } from './types.js';
import { addUsage, usageReported, type Usage } from '../usage.js';

/** How much of the newest sample one EMA step absorbs. 0.2 ≈ a nine-step
 *  effective window: fast enough to show a cache break within a turn, slow
 *  enough that one cold step does not read as a regression. */
export const CACHE_HIT_EMA_ALPHA = 0.2;

/**
 * The ONE cache-hit definition: cache-read input over total input.
 *
 * `cacheRead` is a SUBSET of `input` — ai v6 reports the cache-inclusive total —
 * so this is a share of the prompt that was read from cache, never a ratio over
 * a different base.
 *
 * Null unless BOTH numbers were actually reported. A provider that says nothing
 * about caching has no hit rate to report, and rendering that as 0% would claim
 * a total cache miss on evidence that does not exist — which is the whole reason
 * `Usage` distinguishes absent from zero. Null also when `input` is 0: a step
 * with nothing to cache has no rate either.
 */
export function cacheHitRate(usage: Usage): number | null {
  const { input, cacheRead } = usage;
  if (input === undefined || cacheRead === undefined || input <= 0) return null;
  return cacheRead / input;
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
  /** The window's totals, accumulated field by field. A field no step in the
   *  window reported is ABSENT here rather than summed to zero. */
  readonly tokens: Usage;
  readonly cacheHit: CacheHitStats;
  /** Summed USD of the steps that carried a catalog price. */
  readonly usd: number;
  /** Steps priced from the models.dev catalog. */
  readonly pricedSteps: number;
  /** Steps whose model had no catalog rate. Their cost is NOT in `usd` and is
   *  NOT estimated — an unpriced step is reported as unpriced. */
  readonly unpricedSteps: number;
  /** Steps whose provider reported no usage at all. `tokens` does not include
   *  them, so this is the denominator a reader needs to know the totals
   *  under-count rather than that the steps were free. */
  readonly stepsWithoutUsage: number;
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

/** Aggregate a time-ordered (oldest first) sample of finished steps. */
export function summarizeSteps(
  samples: readonly StepCost[],
  opts: { windowLimit: number; emaAlpha?: number },
): StepTelemetry {
  const alpha = opts.emaAlpha ?? CACHE_HIT_EMA_ALPHA;
  let tokens: Usage = {};
  const rates: number[] = [];
  let ema: number | null = null;
  let usd = 0;
  let pricedSteps = 0;
  let unpricedSteps = 0;
  let stepsWithoutUsage = 0;

  for (const step of samples) {
    const usage = step.usage ?? {};
    if (usageReported(usage)) tokens = addUsage(tokens, usage);
    else stepsWithoutUsage++;
    if (step.usd === undefined) unpricedSteps++;
    else {
      usd += step.usd;
      pricedSteps++;
    }
    const rate = cacheHitRate(usage);
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
    stepsWithoutUsage,
  };
}
