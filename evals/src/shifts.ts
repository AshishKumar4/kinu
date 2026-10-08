import type { Assertion } from './results';

/**
 * What a change can move in a trial besides its pass: each measure read off the trial's own record, compared across two
 * builds by the spread of their trials rather than a mean alone, with the chance that two equally good builds would differ
 * this much. A measure moves only beyond that noise; a tool-description change that misleads the model shows here, in
 * calls refused as bad input or made to invented tools, before it costs a pass.
 */
const MEASURES = {
  wallTimeMs: (trial: Assertion) => trial.duration,
  modelSteps: (trial: Assertion) => trial.meta.harness.run.output.metrics.modelTurns,
  toolCalls: (trial: Assertion) => trial.meta.harness.run.output.metrics.toolCalls,
  toolErrors: (trial: Assertion) => trial.meta.harness.run.output.metrics.toolErrors,
  badInputCalls: (trial: Assertion) => trial.meta.harness.run.output.metrics.badInputCalls,
  unknownToolCalls: (trial: Assertion) => trial.meta.harness.run.output.metrics.unknownToolCalls,
  inputTokens: (trial: Assertion) => trial.meta.harness.run.usage.inputTokens,
  outputTokens: (trial: Assertion) => trial.meta.harness.run.usage.outputTokens,
  costUsd: (trial: Assertion) => trial.meta.harness.run.usage.metadata.costUsd,
} satisfies Record<string, (trial: Assertion) => number | undefined>;

export type Measure = keyof typeof MEASURES;

function isMeasure(name: string): name is Measure {
  return Object.hasOwn(MEASURES, name);
}

/** Every measure, in the order the report lists them. */
export const MEASURE_NAMES: readonly Measure[] = Object.keys(MEASURES).filter(isMeasure);

/** A measure across one side's trials: its median and quartiles. */
export type Spread = { readonly median: number; readonly q1: number; readonly q3: number };

/** One measure on both sides, the two-sided chance of a difference at least this large between equally good builds, and
 *  whether the candidate's trials averaged more. */
export type Shift = { readonly measure: Measure; readonly baseline: Spread; readonly candidate: Spread; readonly pValue: number; readonly rose: boolean };

/** The value at `fraction` of the way through sorted `values`, interpolated between neighbours. */
function quantile(sorted: readonly number[], fraction: number): number {
  const at = (sorted.length - 1) * fraction;
  const below = sorted[Math.floor(at)], above = sorted[Math.ceil(at)];

  return below + (above - below) * (at - Math.floor(at));
}

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((left, right) => left - right);

  return { median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75) };
}

/**
 * Two-sided Mann–Whitney test, exact: every way of splitting the pooled trials into two groups of these sizes is equally
 * likely were the builds equally good, and the answer is the share of splits whose first group's rank sum lies at least as
 * far from its expectation as the observed one. Tied values share their mean rank (doubled here, so ranks stay whole).
 */
export function mannWhitney(baseline: readonly number[], candidate: readonly number[]): number {
  if (baseline.length === 0 || candidate.length === 0) return 1;

  const pooled = [...baseline.map((value) => ({ value, first: true })), ...candidate.map((value) => ({ value, first: false }))]
    .sort((left, right) => left.value - right.value);

  const ranks: number[] = [];

  for (let start = 0; start < pooled.length;) {
    let end = start;

    while (end < pooled.length && pooled[end].value === pooled[start].value) end += 1;

    for (let at = start; at < end; at += 1) ranks.push(start + end + 1);
    start = end;
  }

  const size = baseline.length;
  const total = ranks.reduce((sum, rank) => sum + rank, 0);
  const observed = pooled.reduce((sum, trial, at) => sum + (trial.first ? ranks[at] : 0), 0);
  const expected = (total * size) / pooled.length;
  // splits[k][s]: how many groups of k of the ranks seen so far sum to s.
  const splits = Array.from({ length: size + 1 }, () => Array.from({ length: total + 1 }, () => 0));

  splits[0][0] = 1;

  for (const [seen, rank] of ranks.entries()) {
    for (let taken = Math.min(size, seen + 1); taken >= 1; taken -= 1) {
      const row = splits[taken], fewer = splits[taken - 1];

      for (let sum = total; sum >= rank; sum -= 1) row[sum] += fewer[sum - rank];
    }
  }

  const ways = splits[size];
  const all = ways.reduce((sum, count) => sum + count, 0);
  // The tolerance keeps splits exactly as far as the observed one despite floating-point noise.
  const far = ways.reduce((sum, count, at) => (Math.abs(at - expected) >= Math.abs(observed - expected) - 1e-9 ? sum + count : sum), 0);

  return Math.min(1, far / all);
}

/** Every measure both sides recorded for every trial, compared; one a trial lacks is left out rather than read as zero. */
export function shifts(baseline: readonly Assertion[], candidate: readonly Assertion[]): Shift[] {
  const known = (values: readonly (number | undefined)[]): values is number[] => values.every((value) => value !== undefined);
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

  return MEASURE_NAMES.flatMap((measure) => {
    const before = baseline.map(MEASURES[measure]), after = candidate.map(MEASURES[measure]);

    return known(before) && known(after)
      ? [{ measure, baseline: spread(before), candidate: spread(after), pValue: mannWhitney(before, after), rose: mean(after) > mean(before) }]
      : [];
  });
}
