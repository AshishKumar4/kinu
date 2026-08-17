/**
 * The comparator's own tests — the half that makes a cross-run claim mean
 * something.
 *
 * Every case here is a number this project has already believed, or could:
 * a large effect over too few DIFFERING pairs to decide anything, two
 * inadmissible runs producing a tidy delta, ragged repeats crashing the exact
 * test, and repetitions of one task voting as though they were separate tasks.
 * Each assertion is written so it can go red for a real reason: the arithmetic of
 * the floor is pinned to the value the primitive produces, not to a shape.
 */
import { describe, test, expect } from 'bun:test';
import {
  compareRuns, formatComparison,
  type AttributableComparison, type EvalComparison, type ScorerComparison,
} from '../src/eval-compare.js';
import {
  EVAL_MODELS, FULL_TOOL_SURFACE, assessAdmissibility,
  type EvalArmState, type EvalObservation, type EvalRunRecord, type EvalScoreRow,
} from '../src/eval-run.js';
import { TASK_OUTCOME } from '../src/eval-outcome.js';

/** Fixed so every interval below is reproducible; small so the suite is fast. */
const OPTS = { seed: 1, iterations: 500 };

const SCORER = 'tool_outcomes';
const ABSENT = 'craft_reuse';

function score(name: string, eligible: number, passed: number): EvalScoreRow {
  return {
    name, asserts: `${name} fixture`, eligible, passed,
    rate: eligible === 0 ? null : passed / eligible, detail: 'fixture',
  };
}

/**
 * A trajectory that behaved: turns closed, tools called, and — since a run that
 * never checked whether the task was solved is no longer evidence — a measured
 * `task_outcome`. A caller that supplies its own outcome row keeps it, so a test
 * can still say "this task was solved" or "this one was not".
 */
function scored(
  taskId: string, repetition: number, scores: readonly EvalScoreRow[],
  cost: { turns?: number; toolCalls?: number; tokensIn?: number; tokensOut?: number; ms?: number } = {},
): EvalObservation {
  const withOutcome = scores.some((s) => s.name === TASK_OUTCOME)
    ? scores
    : [...scores, score(TASK_OUTCOME, 1, 1)];
  return {
    taskId, repetition, outcome: 'scored', scores: withOutcome,
    toolNames: ['run', 'file'],
    turns: cost.turns ?? 3, toolCalls: cost.toolCalls ?? 4,
    tokensIn: cost.tokensIn ?? 1000, tokensOut: cost.tokensOut ?? 200, ms: cost.ms ?? 5000,
  };
}

function unscored(
  taskId: string, repetition: number, outcome: 'inert' | 'errored' | 'skipped', reason: string,
): EvalObservation {
  return { taskId, repetition, outcome, reason };
}

/** Admissibility is computed by the real gate rather than declared, so a fixture
 *  cannot hand itself evidence it did not produce. */
function run(
  runId: string, observations: readonly EvalObservation[],
  overrides: { repeats?: number; modelId?: string; arm?: EvalArmState } = {},
): EvalRunRecord {
  const declaredTasks = [...new Set(observations.map((o) => o.taskId))];
  return {
    schema: 1, runId, createdAt: '2026-08-17T00:00:00.000Z',
    gitSha: 'a'.repeat(40), gitDirty: false,
    tier: 'flash', modelId: overrides.modelId ?? EVAL_MODELS.flash,
    repeats: overrides.repeats ?? 1, seed: 7,
    arm: overrides.arm ?? { evolution: true, settle: 'first', tools: FULL_TOOL_SURFACE },
    declaredTasks, executedTasks: declaredTasks, observations,
    admissibility: assessAdmissibility(declaredTasks, observations),
    spend: { calls: observations.length, tokensIn: 0, tokensOut: 0 },
    transcripts: `/bench-artifacts/${runId}`,
  };
}

/** One run, one repetition per task, where the scorer passed `passed[i]` of four
 *  eligible opportunities on task i. */
function scorerRun(runId: string, passedPerTask: readonly number[]): EvalRunRecord {
  return run(runId, passedPerTask.map((passed, i) =>
    scored(`task-${String(i)}`, 1, [score(SCORER, 4, passed)])));
}

/** The same, with `repeats` repetitions of every task — the shape that would
 *  pseudoreplicate if the comparator failed to collapse a task first. */
function repeatRun(
  runId: string, passedPerTask: readonly number[], repeats: number,
): EvalRunRecord {
  const observations = passedPerTask.flatMap((passed, i) =>
    Array.from({ length: repeats }, (_, r) =>
      scored(`task-${String(i)}`, r + 1, [score(SCORER, 4, passed)])));
  return run(runId, observations, { repeats });
}

function attributable(comparison: EvalComparison): AttributableComparison {
  if (!comparison.comparable) {
    throw new Error(`refused: ${comparison.refusals.map((r) => r.field).join(', ')}`);
  }
  return comparison;
}

function scorerOf(comparison: AttributableComparison, name = SCORER): ScorerComparison {
  const found = comparison.scorers.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no scorer named ${name} in the comparison`);
  return found;
}

describe('compareRuns — a clean improvement', () => {
  test('seven differing pairs of eight: positive effect, interval excluding zero', () => {
    const comparison = attributable(compareRuns(
      scorerRun('base', [1, 1, 1, 1, 1, 1, 1, 4]),
      scorerRun('cand', [4, 4, 4, 4, 4, 4, 4, 4]),
      OPTS,
    ));
    const s = scorerOf(comparison);

    expect(s.reach).toBe('both');
    expect(s.pairedTasks).toBe(8);
    expect(s.baselineRate).toBeCloseTo(0.25 * 7 / 8 + 1 / 8, 10);
    expect(s.candidateRate).toBe(1);
    expect(s.effect).toBeCloseTo(0.75 * 7 / 8, 10);
    expect(s.ci?.lo ?? 0).toBeGreaterThan(0);
    expect(s.wins).toBe(7);
    expect(s.losses).toBe(0);
    expect(s.ties).toBe(1);
    expect(s.differingPairs).toBe(7);
    // Seven all-favouring differing pairs: 2·0.5^7.
    expect(s.pValue).toBeCloseTo(2 / 128, 10);
    expect(s.canReachSignificance).toBe(true);
    expect(s.significant).toBe(true);
    expect(s.verdict).toContain('is significant');
    expect(s.verdict).not.toContain('UNDECIDABLE');
  });

  test('the effect is never stated without its interval and differing-pair count', () => {
    const comparison = attributable(compareRuns(
      scorerRun('base', [1, 1, 1, 1, 1, 1, 1, 4]),
      scorerRun('cand', [4, 4, 4, 4, 4, 4, 4, 4]),
      OPTS,
    ));
    const s = scorerOf(comparison);
    expect(s.verdict).toContain('CI ');
    expect(s.verdict).toContain('7 of 8 paired tasks differed');
  });
});

describe('compareRuns — decidability sits on the DIFFERING pairs', () => {
  test('two differing pairs are UNDECIDABLE even at a 40pp effect, floor p = 0.5', () => {
    const comparison = attributable(compareRuns(
      scorerRun('base', [0, 0, 4, 4, 4]),
      scorerRun('cand', [4, 4, 4, 4, 4]),
      OPTS,
    ));
    const s = scorerOf(comparison);

    expect(s.pairedTasks).toBe(5);
    expect(s.differingPairs).toBe(2);
    expect(s.effect).toBeCloseTo(0.4, 10);
    // 2^(1−2) — on the DIFFERING count, not on the five tasks.
    expect(s.floorPValue).toBeCloseTo(0.5, 10);
    expect(s.canReachSignificance).toBe(false);
    expect(s.significant).toBe(false);
    expect(s.verdict.startsWith('UNDECIDABLE')).toBe(true);
    expect(s.verdict).toContain('0.5000');
  });

  test('twenty tasks of which five differ: floor 0.0625, NOT the floor of twenty', () => {
    const baseline = scorerRun('base', [
      0, 0, 0, 0, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    ]);
    const candidate = scorerRun('cand', Array.from({ length: 20 }, () => 4));
    const s = scorerOf(attributable(compareRuns(baseline, candidate, OPTS)));

    expect(s.pairedTasks).toBe(20);
    expect(s.differingPairs).toBe(5);
    expect(s.floorPValue).toBeCloseTo(2 / 32, 10);
    expect(s.floorPValue).toBeGreaterThan(0.05);
    expect(s.canReachSignificance).toBe(false);
    expect(s.verdict.startsWith('UNDECIDABLE')).toBe(true);
  });

  test('six differing pairs reach the floor of 0.03125 and stop being undecidable', () => {
    const s = scorerOf(attributable(compareRuns(
      scorerRun('base', [0, 0, 0, 0, 0, 0]),
      scorerRun('cand', [4, 4, 4, 4, 4, 4]),
      OPTS,
    )));

    expect(s.differingPairs).toBe(6);
    expect(s.floorPValue).toBeCloseTo(2 / 64, 10);
    expect(s.floorPValue).toBeLessThanOrEqual(0.05);
    expect(s.canReachSignificance).toBe(true);
    expect(s.pValue).toBeCloseTo(2 / 64, 10);
    expect(s.significant).toBe(true);
    expect(s.verdict.startsWith('UNDECIDABLE')).toBe(false);
  });

  test('repetitions of one task vote once — six tasks × three repeats is six pairs', () => {
    const s = scorerOf(attributable(compareRuns(
      repeatRun('base', [0, 0, 0, 0, 0, 0], 3),
      repeatRun('cand', [4, 4, 4, 4, 4, 4], 3),
      OPTS,
    )));

    expect(s.pairedTasks).toBe(6);
    expect(s.differingPairs).toBe(6);
    // Pseudoreplicated, this would be 18 pairs and p = 2·0.5^18 ≈ 7.6e-6.
    expect(s.pValue).toBeCloseTo(2 / 64, 10);
  });

  test('the binary headline collapses repeats too', () => {
    const comparison = attributable(compareRuns(
      repeatRun('base', [0, 0, 0, 0, 0, 0], 3),
      repeatRun('cand', [4, 4, 4, 4, 4, 4], 3),
      OPTS,
    ));
    expect(comparison.headline.pairs).toBe(6);
    expect(comparison.headline.repeats).toBe(3);
    expect(comparison.headline.attemptsPerVariant).toBe(18);
  });
});

describe('compareRuns — a regression is not readable as an improvement', () => {
  test('candidate worse: negative effect, interval entirely below zero', () => {
    const s = scorerOf(attributable(compareRuns(
      scorerRun('base', [4, 4, 4, 4, 4, 4, 4, 4]),
      scorerRun('cand', [1, 1, 1, 1, 1, 1, 1, 4]),
      OPTS,
    )));

    expect(s.effect).toBeCloseTo(-0.75 * 7 / 8, 10);
    expect(s.ci?.hi ?? 0).toBeLessThan(0);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(7);
    expect(s.significant).toBe(true);
    expect(s.verdict).toContain('effect -');
  });
});

describe('compareRuns — refuses what it cannot attribute', () => {
  const observations = [0, 0, 0, 4, 4, 4].map((passed, i) =>
    scored(`task-${String(i)}`, 1, [score(SCORER, 4, passed)]));
  const baseline = run('base', observations);

  test('a different model is refused, and the reason names modelId', () => {
    const comparison = compareRuns(
      baseline, run('cand', observations, { modelId: EVAL_MODELS.pro }), OPTS,
    );
    expect(comparison.comparable).toBe(false);
    expect('headline' in comparison).toBe(false);
    if (comparison.comparable) throw new Error('expected a refusal');
    expect(comparison.refusals.map((r) => r.field)).toContain('modelId');
    expect(comparison.refusals[0].detail).toContain(EVAL_MODELS.pro);
  });

  test('a different evolution position is refused', () => {
    const arm: EvalArmState = { evolution: false, settle: 'first', tools: FULL_TOOL_SURFACE };
    const comparison = compareRuns(baseline, run('cand', observations, { arm }), OPTS);
    if (comparison.comparable) throw new Error('expected a refusal');
    expect(comparison.refusals.map((r) => r.field)).toContain('arm.evolution');
  });

  test('a different settle policy is refused', () => {
    const arm: EvalArmState = { evolution: true, settle: 'best', tools: FULL_TOOL_SURFACE };
    const comparison = compareRuns(baseline, run('cand', observations, { arm }), OPTS);
    if (comparison.comparable) throw new Error('expected a refusal');
    expect(comparison.refusals.map((r) => r.field)).toContain('arm.settle');
  });

  test('a narrower tool surface is refused, and the reason names the missing tools', () => {
    const tools = FULL_TOOL_SURFACE.slice(0, 3);
    const arm: EvalArmState = { evolution: true, settle: 'first', tools };
    const comparison = compareRuns(baseline, run('cand', observations, { arm }), OPTS);
    if (comparison.comparable) throw new Error('expected a refusal');
    const refusal = comparison.refusals.find((r) => r.field === 'arm.tools');
    expect(refusal).toBeDefined();
    expect(refusal?.detail).toContain(FULL_TOOL_SURFACE[FULL_TOOL_SURFACE.length - 1]);
  });

  test('a different repeat count is refused', () => {
    const comparison = compareRuns(
      baseline, repeatRun('cand', [0, 0, 0, 4, 4, 4], 3), OPTS,
    );
    if (comparison.comparable) throw new Error('expected a refusal');
    expect(comparison.refusals.map((r) => r.field)).toContain('repeats');
  });

  test('an inadmissible run is refused, not compared: zero graded turns', () => {
    const inert = [0, 1, 2, 3, 4, 5].map((i) =>
      scored(`task-${String(i)}`, 1, [score(SCORER, 4, 4)], { turns: 0, toolCalls: 0 }));
    const candidate = run('cand', inert);
    expect(candidate.admissibility.admissible).toBe(false);

    const comparison = compareRuns(baseline, candidate, OPTS);
    expect(comparison.comparable).toBe(false);
    if (comparison.comparable) throw new Error('expected a refusal');
    const refusal = comparison.refusals.find((r) => r.field === 'candidate.admissibility');
    expect(refusal?.detail).toContain('zero graded turns');
  });

  test('refusals are the whole report, and they come first', () => {
    const report = formatComparison(compareRuns(
      baseline, run('cand', observations, { modelId: EVAL_MODELS.pro }), OPTS,
    ));
    expect(report.split('\n')[1]).toContain('REFUSED');
    expect(report).toContain('modelId:');
    expect(report).not.toContain('pass@1');
  });
});

describe('compareRuns — an empty denominator is not a zero rate', () => {
  const withAbsent = (runId: string, passed: number) => run(runId, [0, 1, 2, 3].map((i) =>
    scored(`task-${String(i)}`, 1, [score(SCORER, 4, passed), score(ABSENT, 0, 0)])));

  test('zero denominator on both sides reports "never exercised", not 0.000', () => {
    const s = scorerOf(attributable(compareRuns(withAbsent('base', 2), withAbsent('cand', 3), OPTS)), ABSENT);

    expect(s.reach).toBe('neither');
    expect(s.pairedTasks).toBe(0);
    expect(s.effect).toBeNull();
    expect(s.ci).toBeNull();
    expect(s.pValue).toBeNull();
    expect(s.baselineRate).toBeNull();
    expect(s.candidateRate).toBeNull();
    expect(s.verdict).toContain('never exercised');
    // No quantity on the rate scale is printed, so no "+0.0pp" can be misread
    // as a measured absence of change.
    expect(s.verdict).not.toMatch(/[+-]\d+\.\dpp/);
  });

  test('exercised on one side only is a corpus-reach change, not a behaviour change', () => {
    const baseline = run('base', [0, 1, 2, 3].map((i) =>
      scored(`task-${String(i)}`, 1, [score(SCORER, 4, 2)])));
    const candidate = run('cand', [0, 1, 2, 3].map((i) =>
      scored(`task-${String(i)}`, 1, [score(SCORER, 4, 2), score(ABSENT, 2, 1)])));

    const s = scorerOf(attributable(compareRuns(baseline, candidate, OPTS)), ABSENT);

    expect(s.reach).toBe('candidate-only');
    expect(s.baselineEligible).toBe(0);
    expect(s.candidateEligible).toBe(8);
    expect(s.effect).toBeNull();
    expect(s.verdict).toContain('corpus reach changed');
    expect(s.verdict).toContain('not in behaviour');
  });
});

describe('compareRuns — ragged and ungradable observations', () => {
  const scoresFor = (passed: number) => [score(SCORER, 4, passed)];

  test('ragged repetitions drop by name and never crash the exact test', () => {
    const baseline = run('base', [
      scored('task-a', 1, scoresFor(1)), scored('task-a', 2, scoresFor(1)),
      scored('task-b', 1, scoresFor(1)), scored('task-b', 2, scoresFor(1)),
      scored('task-c', 1, scoresFor(1)), scored('task-c', 2, scoresFor(1)),
    ], { repeats: 2 });
    const candidate = run('cand', [
      scored('task-a', 1, scoresFor(4)), scored('task-a', 2, scoresFor(4)),
      scored('task-b', 1, scoresFor(4)),
      scored('task-c', 1, scoresFor(4)), unscored('task-c', 2, 'inert', 'no closed turn'),
    ], { repeats: 2 });

    const comparison = attributable(compareRuns(baseline, candidate, OPTS));

    expect(comparison.totalPairs).toBe(6);
    expect(comparison.eligiblePairs).toBe(4);
    expect(comparison.diagnostics.map((d) => [d.key, d.reason])).toEqual([
      ['task-b#2', 'missing-in-candidate'],
      ['task-c#2', 'candidate-not-scored'],
    ]);
    expect(comparison.diagnostics[1].detail).toContain('inert: no closed turn');

    // Only task-a paired both repetitions, so it is the only headline pair.
    expect(comparison.raggedTasks).toEqual([
      { taskId: 'task-b', pairedRepetitions: 1, repeats: 2 },
      { taskId: 'task-c', pairedRepetitions: 1, repeats: 2 },
    ]);
    expect(comparison.headline.pairs).toBe(1);
    expect(comparison.headline.repeats).toBe(2);

    // The scorer still uses every pair it has, collapsed per task: three tasks.
    const s = scorerOf(comparison);
    expect(s.pairedTasks).toBe(3);
    expect(s.effect).toBeCloseTo(0.75, 10);
    expect(s.differingPairs).toBe(3);
    expect(s.verdict.startsWith('UNDECIDABLE')).toBe(true);
  });

  test('inert and errored observations contribute to no numerator and no denominator', () => {
    const baseline = run('base', [
      scored('task-good', 1, scoresFor(4)),
      scored('task-bad', 1, scoresFor(0)),
      scored('task-filler', 1, scoresFor(4)),
    ]);
    const candidate = run('cand', [
      scored('task-good', 1, scoresFor(4)),
      unscored('task-bad', 1, 'errored', 'provider 500'),
      scored('task-filler', 1, scoresFor(4)),
    ]);

    const comparison = attributable(compareRuns(baseline, candidate, OPTS));
    const s = scorerOf(comparison);

    // task-bad's baseline 0/4 is the only failing row in either run; if the
    // errored candidate did not remove it, the baseline rate would be 0.667.
    expect(s.pairedTasks).toBe(2);
    expect(s.baselineEligible).toBe(8);
    expect(s.candidateEligible).toBe(8);
    expect(s.baselineRate).toBe(1);
    expect(s.candidateRate).toBe(1);
    expect(s.effect).toBe(0);
    expect(comparison.diagnostics).toEqual([{
      key: 'task-bad#1', reason: 'candidate-not-scored',
      detail: 'the candidate observation produced no scores (errored: provider 500)',
    }]);
    expect(comparison.headline.pairs).toBe(2);
  });

  test('a task neither run paired is still named as a headline exclusion', () => {
    const baseline = run('base', [
      scored('task-a', 1, scoresFor(4)), scored('task-skip', 1, scoresFor(4)),
    ]);
    const candidate = run('cand', [
      scored('task-a', 1, scoresFor(4)), unscored('task-skip', 1, 'skipped', 'budget'),
    ]);
    const comparison = attributable(compareRuns(baseline, candidate, OPTS));
    expect(comparison.raggedTasks).toEqual([
      { taskId: 'task-skip', pairedRepetitions: 0, repeats: 1 },
    ]);
  });
});

describe('compareRuns — the binary headline is the OUTCOME', () => {
  /**
   * These two cases used to vary `toolCalls: 0` to move the headline, because
   * under `turns > 0 && toolCalls > 0` that was the only thing that COULD move
   * it — an admissible trajectory passed by construction. They now vary whether
   * the task was solved, which is the thing the headline is supposed to be about.
   */
  const solvedRun = (id: string, solvedCount: number) =>
    run(id, Array.from({ length: 8 }, (_, i) =>
      scored(`task-${String(i)}`, 1, [
        score(SCORER, 4, 4),
        score(TASK_OUTCOME, 4, i < solvedCount ? 4 : 0),
      ])));

  test('a task the agent did not solve is not a success', () => {
    const baseline = solvedRun('base', 8);
    const candidate = solvedRun('cand', 2);

    const { headline } = attributable(compareRuns(baseline, candidate, OPTS));

    expect(headline.pairs).toBe(8);
    expect(headline.passAtOneA).toBe(1);
    expect(headline.passAtOneB).toBeCloseTo(0.25, 10);
    expect(headline.onlyA).toBe(6);
    expect(headline.onlyB).toBe(0);
    expect(headline.discordant).toBe(6);
    expect(headline.effect).toBeCloseTo(-0.75, 10);
    expect(headline.pValue).toBeCloseTo(2 / 64, 10);
    expect(headline.canReachSignificance).toBe(true);
    expect(headline.significant).toBe(true);
  });

  test('activity alone no longer moves the headline — a busy run that solved nothing scores 0', () => {
    // The retired predicate's exact defect, pinned so it cannot come back: both
    // runs closed turns and called tools, so the OLD headline scored them 1.000
    // against 1.000. Under the outcome they are 1.000 against 0.000.
    const baseline = solvedRun('base', 8);
    const candidate = solvedRun('cand', 0);
    const { headline } = attributable(compareRuns(baseline, candidate, OPTS));
    expect(headline.passAtOneA).toBe(1);
    expect(headline.passAtOneB).toBe(0);
    expect(headline.discordant).toBe(8);
  });

  test('an attempt nothing verified is DROPPED and named, never counted as a failure', () => {
    // A missing verifier is a gap in the corpus. Scoring it as a loss would turn
    // that gap into a fact about the agent.
    const baseline = solvedRun('base', 8);
    const candidate = run('cand', Array.from({ length: 8 }, (_, i) =>
      i === 0
        ? scored('task-0', 1, [score(SCORER, 4, 4), score(TASK_OUTCOME, 0, 0)])
        : scored(`task-${String(i)}`, 1, [score(SCORER, 4, 4), score(TASK_OUTCOME, 4, 4)])));

    const comparison = attributable(compareRuns(baseline, candidate, OPTS));
    const dropped = comparison.diagnostics.find((d) => d.key === 'task-0#1');
    expect(dropped?.reason).toBe('candidate-unverified');
    expect(dropped?.detail).toContain('never checked');
    // Excluded from the headline entirely rather than scored 0.
    expect(comparison.headline.pairs).toBe(7);
    expect(comparison.headline.passAtOneB).toBe(1);
  });

  test('the report carries the predicate, the interval and the differing count', () => {
    const report = formatComparison(compareRuns(solvedRun('base', 8), solvedRun('cand', 2), OPTS));

    expect(report).toContain(`success = ${TASK_OUTCOME} rate === 1`);
    expect(report).not.toContain('turns > 0 && toolCalls > 0');
    expect(report).toContain('6 of 8 tasks differed');
    expect(report).toContain('pass@1 1.000 → 0.250');
    expect(report).toContain('covariates (mechanism telemetry');
    expect(report).toContain('cost, paired per task');
  });
});

describe('compareRuns — paired cost and latency', () => {
  test('"did it get cheaper" is answerable with an interval', () => {
    const baseline = run('base', Array.from({ length: 8 }, (_, i) =>
      scored(`task-${String(i)}`, 1, [score(SCORER, 4, 2)], { tokensIn: 1000, tokensOut: 400, ms: 9000 })));
    const candidate = run('cand', Array.from({ length: 8 }, (_, i) =>
      scored(`task-${String(i)}`, 1, [score(SCORER, 4, 2)], { tokensIn: 600, tokensOut: 300, ms: 4000 })));

    const { cost } = attributable(compareRuns(baseline, candidate, OPTS));

    expect(cost.tokensIn.tasks).toBe(8);
    expect(cost.tokensIn.baselineMean).toBe(1000);
    expect(cost.tokensIn.candidateMean).toBe(600);
    expect(cost.tokensIn.delta).toBeCloseTo(-400, 6);
    expect(cost.tokensIn.ci.hi).toBeLessThan(0);
    expect(cost.tokensOut.delta).toBeCloseTo(-100, 6);
    expect(cost.ms.delta).toBeCloseTo(-5000, 6);
    expect(cost.ms.ci.hi).toBeLessThan(0);
  });

  test('cost averages a task\'s repetitions before differencing it', () => {
    const baseline = run('base', ['task-a', 'task-b'].flatMap((taskId) => [
      scored(taskId, 1, [score(SCORER, 4, 2)], { ms: 1000 }),
      scored(taskId, 2, [score(SCORER, 4, 2)], { ms: 3000 }),
    ]), { repeats: 2 });
    const candidate = run('cand', ['task-a', 'task-b'].flatMap((taskId) => [
      scored(taskId, 1, [score(SCORER, 4, 2)], { ms: 1000 }),
      scored(taskId, 2, [score(SCORER, 4, 2)], { ms: 1000 }),
    ]), { repeats: 2 });

    const { cost } = attributable(compareRuns(baseline, candidate, OPTS));
    expect(cost.ms.tasks).toBe(2);
    expect(cost.ms.baselineMean).toBe(2000);
    expect(cost.ms.delta).toBeCloseTo(-1000, 6);
  });
});
