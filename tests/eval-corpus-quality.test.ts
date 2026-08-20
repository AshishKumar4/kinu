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
 *
 * THE TWO BASELINES ARE RETIRED, NOT UPGRADED, and the second describe below is
 * why. An upgrade means deriving the `task_outcome` row they lack. Nothing they
 * carry supports one: none of the seven task ids either declares is in the
 * hard-task corpus, so no verifier exists to run; no score row carries a
 * `measured` payload, so no final-state number survives either; and neither
 * record names a transcripts directory, because the tier deleted its stores in
 * teardown at the time. So both were republished under today's admissibility
 * policy instead, which is a recomputation over their own observations and
 * invents nothing. `admissible: false` is what retires them: `compareRuns`
 * refuses a run that measured nothing, so the comparator itself now declines
 * them as baselines rather than pairing 13 attempts and dropping all 13.
 *
 * The third describe holds the writer's side of the same defect. 81 of the
 * corpus's first 89 records were runs that attempted nothing and wrote a record
 * anyway.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { minimumPairsForSignificance } from '../packages/core/src/index';
import {
  EVAL_MODELS, FULL_TOOL_SURFACE, TASK_OUTCOME,
  assessAdmissibility, compareRuns, hardTaskCases, publishRunRecord, readRunRecord, scratchDir,
  type EvalObservation, type EvalRunRecord,
} from '@kinu/test-utils';

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

/** One scored attempt carrying the ground-truth row the two baselines lack —
 *  the fixture both the green corpus case and the writer's guard are built on. */
function withOutcome(taskId: string, reached: number, total: number): EvalObservation {
  return {
    taskId, repetition: 0, outcome: 'scored',
    scores: [{
      name: TASK_OUTCOME, asserts: 'solved', eligible: total, passed: reached,
      rate: reached / total, detail: 'fixture ground truth',
    }],
    turns: 2, toolCalls: 5, toolNames: ['run', 'file'], tokensIn: 10, tokensOut: 1, ms: 1,
  };
}

describe('the shipped six-task corpus fails the corpus-quality properties', () => {
  test('it declares NO ground truth — every recorded attempt is unverified', () => {
    // The property `behaviour.eval.ts` checks first. It fails here, and this is
    // the whole finding: pass@1 read 1.000 -> 1.000 over these two runs while
    // nothing had ever checked whether a single task was actually solved.
    for (const record of [flashA, flashB]) {
      expect(outcomeRates(record)).toEqual([]);
      expect(record.admissibility.outcomesScored).toBe(0);
    }
  });

  test('and no verifier exists for a single task either run declares', () => {
    // The evidence the retirement decision rests on, and the direction that
    // re-opens it. `hardTaskCases()` is the corpus that declares ground truth;
    // the day one of these seven ids appears in it, an honest upgrade becomes
    // possible and this goes red asking for one.
    const withGroundTruth = new Set(hardTaskCases().map((c) => c.id));
    for (const record of [flashA, flashB]) {
      const verifiable = record.declaredTasks.filter((id) => withGroundTruth.has(id));
      expect(verifiable).toEqual([]);
    }
  });

  test('so both are retired as baselines — the comparator refuses them by name', () => {
    // Both records were written when "did the agent do anything" was the bar, so
    // both STORED `admissible: true` while today's policy says otherwise. They
    // were republished under today's policy, which is a recomputation over their
    // own observations: the stored verdict and the recomputed one now agree, and
    // this is the assertion that goes red if either drifts again.
    for (const record of [flashA, flashB]) {
      expect(record.admissibility)
        .toEqual(assessAdmissibility(record.declaredTasks, record.observations));
      expect(record.admissibility.admissible).toBe(false);
      expect(record.admissibility.failures.join(' '))
        .toContain('no observation carried a task_outcome row');
      expect(outcomeRates(record)).toEqual([]);
    }

    // The refusal now comes BEFORE the pairing, so the comparator reaches no
    // pair at all. It used to pair 13 and drop every one — 12 as
    // `baseline-unverified` and `tool-001` as `baseline-not-scored`. Those same
    // 12 and 1 are asserted below, read off the records rather than off a
    // comparison that no longer runs.
    const comparison = compareRuns(flashA, flashB);
    expect(comparison.comparable).toBe(false);
    if (comparison.comparable) throw new Error('expected a refusal, not a comparison');
    expect(comparison.refusals.map((r) => r.field))
      .toEqual(['baseline.admissibility', 'candidate.admissibility']);

    for (const record of [flashA, flashB]) {
      const unverified = scoredOf(record)
        .filter((o) => !o.scores.some((s) => s.name === TASK_OUTCOME));
      expect(unverified.length).toBe(12);
      expect(record.admissibility.inert).toBe(1);
    }
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

describe('a run that attempted nothing writes no record at all', () => {
  // The writer's side of the same defect. `skipIf(!TARGET)` skips every case
  // without a credential, and each arm's `afterAll` used to write the record
  // regardless: 81 of the corpus's first 89 records reported 0 observations over
  // 1 to 17 declared tasks, and the largest group the triage instrument found
  // was that one fact repeated 45 times. `publishRunRecord` is now the only path
  // that writes a record, so the guard covers every family that has one and
  // every family that gets one.
  const inputs = (transcripts: string, observations: readonly EvalObservation[]) => ({
    family: 'behaviour', tier: 'flash' as const, modelId: EVAL_MODELS.flash,
    repeats: 1, seed: 1,
    arm: { evolution: true, settle: 'none', tools: FULL_TOOL_SURFACE },
    declaredTasks: ['ws-inventory'], observations,
    spend: { calls: 0, callsWithoutUsage: 0, usage: {}, episodesUnmeasured: 0 },
    transcripts, repoRoot: join(import.meta.dirname, '..'),
  });

  /** The destination named explicitly, so an exported `PROTEUS_EVAL_RECORD` in
   *  the shell running the suite cannot decide where this writes. */
  function publishTo(dir: string, observations: readonly EvalObservation[]) {
    const out = join(dir, 'run-record.json');
    const before = process.env.PROTEUS_EVAL_RECORD;
    process.env.PROTEUS_EVAL_RECORD = out;
    try {
      return { out, record: publishRunRecord(inputs(dir, observations)) };
    } finally {
      if (before === undefined) delete process.env.PROTEUS_EVAL_RECORD;
      else process.env.PROTEUS_EVAL_RECORD = before;
    }
  }

  test('zero observations: nothing is written and nothing is returned', () => {
    const dir = scratchDir('eval-publish-none');
    const { out, record } = publishTo(dir, []);
    expect(record).toBeNull();
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('one observation: the record is written, so the guard is what decides', () => {
    // The green direction. Without it the test above would also pass against a
    // writer that had simply stopped working.
    const dir = scratchDir('eval-publish-one');
    const { out, record } = publishTo(dir, [withOutcome('ws-inventory', 4, 4)]);
    expect(record).not.toBeNull();
    expect(existsSync(out)).toBe(true);
    expect(readRunRecord(out).observations.length).toBe(1);
  });
});
