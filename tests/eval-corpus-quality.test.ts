/**
 * The corpus-quality properties, proven RED against the corpus that shipped.
 *
 * `tests/evals/behaviour.eval.ts` asserts these on a live run, which costs money
 * and needs a credential. This asserts the same two predicates against the two
 * run records already on disk — `flash-a.json` and `flash-b.json`, the real
 * recorded observations of the real six-task corpus — so the claim "these
 * properties fail on the current corpus" is a measurement rather than a
 * prediction, and it re-checks itself on every `bun test` for free.
 *
 * Both records are the SAME arm (evolution on, settle none, all 8 tools) run
 * twice, which is what makes their difference this corpus's own noise rather than
 * an effect.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { minimumPairsForSignificance } from '../packages/core/src/index';
import {
  TASK_OUTCOME, compareRuns, readRunRecord,
  type EvalObservation, type EvalRunRecord,
} from '@proteus/test-utils';

const RUNS = join(import.meta.dirname, 'eval/runs');
const flashA = readRunRecord(join(RUNS, 'flash-a.json'));
const flashB = readRunRecord(join(RUNS, 'flash-b.json'));

function scoredOf(record: EvalRunRecord) {
  return record.observations
    .filter((o): o is Extract<EvalObservation, { outcome: 'scored' }> => o.outcome === 'scored');
}

/** The same predicate `behaviour.eval.ts` asserts live. */
function outcomeRates(record: EvalRunRecord): number[] {
  return scoredOf(record)
    .flatMap((o) => o.scores.filter((s) => s.name === TASK_OUTCOME))
    .filter((s) => s.eligible > 0)
    .map((s) => s.passed / s.eligible);
}

describe('the shipped six-task corpus fails the corpus-quality properties', () => {
  test('it declares NO ground truth — every recorded attempt is unverified', () => {
    // The property `behaviour.eval.ts` checks first. It fails here, and this is
    // the whole finding: pass@1 read 1.000 -> 1.000 over these two runs while
    // nothing had ever checked whether a single task was actually solved.
    for (const record of [flashA, flashB]) {
      expect(outcomeRates(record)).toEqual([]);
      expect(record.admissibility.outcomesScored ?? 0).toBe(0);
    }
  });

  test('so neither run is admissible evidence about task performance any more', () => {
    // Both records were written when "did the agent do anything" was the bar, so
    // both STORED `admissible: true`. The stored verdict is what the new gate
    // overturns.
    for (const record of [flashA, flashB]) {
      expect(record.admissibility.admissible).toBe(true);
      expect(outcomeRates(record)).toEqual([]);
    }

    const comparison = compareRuns(flashA, flashB);
    expect(comparison.comparable).toBe(true);
    if (!comparison.comparable) return;

    // Nothing survives to compare: every one of the 12 scored pairs is dropped as
    // unverified, and `tool-001` was already dropped as inert in both runs.
    expect(comparison.headline.pairs).toBe(0);
    const byReason = new Map<string, number>();
    for (const d of comparison.diagnostics) {
      byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
    }
    expect(byReason.get('baseline-unverified')).toBe(12);
    expect(byReason.get('baseline-not-scored')).toBe(1);
    expect(comparison.eligiblePairs).toBe(0);
  });
  test('the old activity headline could not vary: psi is exactly 0 over 6 tasks', () => {
    // Measured, not asserted from memory. Both runs are the same arm, so this is
    // the corpus's own run-to-run noise, and it is zero because the metric was
    // `turns > 0 && toolCalls > 0` — satisfied by construction.
    const activityRates = [flashA, flashB].map((r) =>
      scoredOf(r).map((o) => (o.turns > 0 && o.toolCalls > 0 ? 1 : 0)));
    expect(activityRates[0]?.every((v) => v === 1)).toBe(true);
    expect(activityRates[1]?.every((v) => v === 1)).toBe(true);
  });

  test('six tasks is exactly the floor, so a single non-differing task sinks it', () => {
    const floor = minimumPairsForSignificance();
    expect(floor).toBe(6);
    expect(flashA.declaredTasks.length).toBe(7);
    // Six workspace tasks plus `tool-001`, which went inert in both runs and so
    // paired zero times — leaving exactly 6 tasks, of which 0 differed.
    expect(scoredOf(flashA).length).toBe(12);
  });
});

describe('the properties PASS on a corpus that declares ground truth and has headroom', () => {
  // The green case, so the assertions above are known to be capable of passing
  // rather than merely capable of failing.
  const withOutcome = (taskId: string, reached: number, total: number): EvalObservation => ({
    taskId, repetition: 0, outcome: 'scored',
    scores: [{
      name: TASK_OUTCOME, asserts: 'solved', eligible: total, passed: reached,
      rate: reached / total, detail: 'fixture ground truth',
    }],
    turns: 2, toolCalls: 5, toolNames: ['run', 'file'], tokensIn: 10, tokensOut: 1, ms: 1,
  });

  test('a spread of outcomes has both a success and a shortfall', () => {
    const rates = [
      withOutcome('a', 4, 4), withOutcome('b', 2, 4), withOutcome('c', 0, 4),
    ].flatMap((o) => o.outcome === 'scored' ? o.scores : [])
      .map((s) => s.passed / s.eligible);

    expect(rates.some((r) => r > 0)).toBe(true);
    expect(rates.some((r) => r < 1)).toBe(true);
  });

  test('a swept corpus is caught as saturated', () => {
    const rates = [withOutcome('a', 4, 4), withOutcome('b', 4, 4)]
      .flatMap((o) => o.outcome === 'scored' ? o.scores : [])
      .map((s) => s.passed / s.eligible);
    expect(rates.some((r) => r < 1)).toBe(false);
  });
});
