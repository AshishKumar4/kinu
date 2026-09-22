/** Aggregates over provider-reported step numbers only; the local context estimate is not averaged. */

import type { StepCost } from './types';
import { addUsage, usageReported, type Usage } from '../usage';

/** ≈ nine-step effective window: shows a cache break within a turn without one cold step reading
 *  as a regression. */
export const CACHE_HIT_EMA_ALPHA = 0.2;

/** `cacheRead` is a subset of `input` (ai v6). Null unless both were reported and `input` > 0. */
function cacheHitRate(usage: Usage): number | null {
  const { input, cacheRead } = usage;

  if (input === undefined || cacheRead === undefined || input <= 0) return null;

  return cacheRead / input;
}

export interface CacheHitStats {
  readonly samples: number;
  readonly last: number | null;
  readonly mean: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly ema: number | null;
  readonly emaAlpha: number;
  /** Counted only here: a warm's ~100% hit rate would inflate the turns' own distribution
   *  (providers/cache-warming.ts). */
  readonly warms: number;
}

export interface StepTelemetry {
  readonly steps: number;
  readonly windowLimit: number;
  /** A field no step reported is absent, not zero. */
  readonly tokens: Usage;
  readonly cacheHit: CacheHitStats;
  readonly usd: number;
  readonly pricedSteps: number;
  /** Not in `usd` and not estimated. */
  readonly unpricedSteps: number;
  /** Not in `tokens`: the totals under-count. */
  readonly stepsWithoutUsage: number;
}

function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);

  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

/** Samples oldest first. `warms` are rows so they can only move `cacheHit.warms`. */
export function summarizeSteps(
  samples: readonly StepCost[],
  opts: { windowLimit: number; emaAlpha?: number; warms?: readonly StepCost[] },
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
      p99: percentile(sorted, 0.99),
      ema,
      emaAlpha: alpha,
      warms: opts.warms?.length ?? 0,
    },
    usd,
    pricedSteps,
    unpricedSteps,
    stepsWithoutUsage,
  };
}
