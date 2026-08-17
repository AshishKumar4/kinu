// The bridge from somebody else's retained trials to this repo's statistics —
// and the gate that decides whether those trials can carry a claim at all.
//
// Untested until now, which is how two Terminal-Bench jobs configured
// `evolve=false` in BOTH arms became a circulated sentence about self-evolution:
// nothing in the path from result.json to the printed effect ever asked what the
// arms actually did. These tests are written against that failure, not against
// the happy path.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admissibility, armSpend, flipAccounting, pairArms, readHarborJob,
} from './bench-external.js';
import type { Admissibility, AdmissibilityCondition } from './bench-external.js';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface TrialSpec {
  task: string;
  reward: number;
  evolve: boolean;
  /** Filtered evolution events the trial emitted. */
  evolutionEvents?: number;
  /** Whole-activity-channel events, which are not evidence about evolution. */
  activityEvents?: number;
  /** `undefined` leaves the grading probe unreported — not zero. */
  executionGraded?: number;
  turnsCompleted?: number;
  promptTokens?: number;
  outputTokens?: number;
  checksum?: string;
  /** Emit a trial with no usage at all — what a killed turn leaves behind. */
  noUsage?: boolean;
}

/** A Harbor job directory holding one `result.json` per trial, in the shape the
 *  adapter actually writes — only the fields the reader parses. */
function job(name: string, trials: readonly TrialSpec[]): string {
  const root = mkdtempSync(join(tmpdir(), 'bench-external-'));
  scratch.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const spec of trials) {
    const trialDir = join(dir, `${spec.task}__x`);
    mkdirSync(trialDir);
    const event = (name: string, count: number) =>
      Array.from({ length: count }, () => ({ event: name, message: name }));
    // Shaped exactly as bench/harbor/proteus_agent.py writes it. `turn_grading`
    // is absent, not zeroed, when the probe reported nothing — which is the
    // distinction half these tests exist to hold.
    const metadata = {
      evolve: spec.evolve,
      tool_calls: 5,
      evolution_events: event('reflection', spec.evolutionEvents ?? 0),
      activity_events: event('bg_job_started', spec.activityEvents ?? spec.evolutionEvents ?? 0),
      turns_completed: spec.turnsCompleted ?? 1,
      turn_grading: spec.executionGraded === undefined ? undefined : {
        user_graded: 0, execution_graded: spec.executionGraded, abandoned: 0,
      },
    };
    writeFileSync(join(trialDir, 'result.json'), JSON.stringify({
      task_name: `terminal-bench/${spec.task}`,
      task_checksum: spec.checksum ?? `sum-${spec.task}`,
      config: { agent: { model_name: 'flash', kwargs: { evolve: spec.evolve } } },
      agent_result: spec.noUsage ? { metadata } : {
        n_input_tokens: spec.promptTokens ?? 100_000,
        n_output_tokens: spec.outputTokens ?? 1_000,
        n_cache_tokens: 0,
        metadata,
      },
      verifier_result: { rewards: { reward: spec.reward } },
      exception_info: null,
    }));
  }
  // Job-level bookkeeping sits beside the trials and must not read as a trial.
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ job: name }));
  writeFileSync(join(dir, 'job.log'), 'started\n');
  return dir;
}

const FOUR = ['alpha', 'beta', 'gamma', 'delta'] as const;

function arms(opts: {
  aEvolve: boolean; bEvolve: boolean;
  bEvolutionEvents?: number; bExecutionGraded?: number;
  aEvolutionEvents?: number; bOutputTokens?: number;
  bChecksumShift?: boolean;
}) {
  const a = readHarborJob(job('arm-a', FOUR.map((task, i) => ({
    task, reward: i < 2 ? 1 : 0, evolve: opts.aEvolve,
    evolutionEvents: opts.aEvolutionEvents ?? 0, executionGraded: 1,
  }))));
  const b = readHarborJob(job('arm-b', FOUR.map((task, i) => ({
    task, reward: i < 3 ? 1 : 0, evolve: opts.bEvolve,
    evolutionEvents: opts.bEvolutionEvents ?? 0,
    executionGraded: opts.bExecutionGraded,
    outputTokens: opts.bOutputTokens,
    checksum: opts.bChecksumShift && task === 'alpha' ? 'moved' : undefined,
  }))));
  return { a, b, paired: pairArms(a, b).paired };
}

function condition(verdict: Admissibility, name: string): AdmissibilityCondition {
  const found = verdict.conditions.find((c) => c.name === name);
  if (!found) throw new Error(`no condition named "${name}"`);
  return found;
}

describe('readHarborJob', () => {
  test('reads the mechanism state the trial recorded, not the flag it was given', () => {
    const arm = readHarborJob(job('arm', [
      { task: 'alpha', reward: 1, evolve: true, evolutionEvents: 3, activityEvents: 9, executionGraded: 2, turnsCompleted: 2 },
    ]));
    expect(arm.trials).toHaveLength(1);
    const [trial] = arm.trials;
    expect(trial?.evolve).toBe(true);
    expect(trial?.evolutionEvents).toBe(3);
    expect(trial?.activityEvents).toBe(9);
    expect(trial?.executionGradedTurns).toBe(2);
    expect(trial?.turnsCompleted).toBe(2);
  });

  test('an unreported grading probe is null, never zero', () => {
    // The distinction the arm depends on: a probe that produced no readable
    // answer and an arm that graded nothing look identical if either becomes 0,
    // and only one of them is a fact about the arm.
    const arm = readHarborJob(job('arm', [{ task: 'alpha', reward: 0, evolve: true }]));
    expect(arm.trials[0]?.executionGradedTurns).toBeNull();
    expect(armSpend(arm).executionGradedTurns).toBeNull();
    expect(armSpend(arm).gradingUnreported).toBe(1);
  });

  test('job-level bookkeeping is not counted as a trial', () => {
    const arm = readHarborJob(job('arm', [
      { task: 'alpha', reward: 1, evolve: false, executionGraded: 1 },
      { task: 'beta', reward: 0, evolve: false, executionGraded: 1 },
    ]));
    expect(arm.trials.map((t) => t.taskId)).toEqual(['alpha', 'beta']);
  });
});

describe('armSpend', () => {
  test('counts the trials on which the mechanism was observed to act', () => {
    const arm = readHarborJob(job('arm', [
      { task: 'alpha', reward: 1, evolve: true, evolutionEvents: 2, executionGraded: 1 },
      { task: 'beta', reward: 0, evolve: true, evolutionEvents: 0, executionGraded: 1 },
      { task: 'gamma', reward: 0, evolve: true, evolutionEvents: 5, executionGraded: 3 },
    ]));
    const spend = armSpend(arm);
    expect(spend.trialsWithEvolution).toBe(2);
    expect(spend.totalEvolutionEvents).toBe(7);
    expect(spend.executionGradedTurns).toBe(5);
  });
});

describe('admissibility — asked before any effect is reported', () => {
  test('a genuine contrast whose mechanism acted and graded is admissible', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 2, bExecutionGraded: 2,
    });
    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(true);
    expect(verdict.conditions.every((c) => c.met)).toBe(true);
  });

  test('two arms that both ran evolve=false are a replication and not a contrast', () => {
    // The literal shape of TB2.0 and TB2.1: both jobs configured evolve=false,
    // read afterwards as a comparison of evolution.
    const { a, b, paired } = arms({ aEvolve: false, bEvolve: false, bExecutionGraded: 1 });
    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'the two arms differ in that state').met).toBe(false);
    expect(condition(verdict, 'the two arms differ in that state').detail)
      .toContain('replication, not a contrast');
  });

  test('a candidate configured to evolve that never evolved fails on the observation', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 0, bExecutionGraded: 2,
    });
    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'the candidate mechanism was OBSERVED to act').met).toBe(false);
    expect(condition(verdict, 'the candidate mechanism was OBSERVED to act').detail)
      .toContain('0/4');
  });

  test('a candidate whose turns were never graded fails — the C14 shape', () => {
    // Evolution fires on every trial and every turn comes back ungraded. This is
    // the CL-Bench run that reported mean_gain -0.2 over 14 fired events and 14
    // ungraded turns, and it must not produce an effect.
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 4, bExecutionGraded: 0,
    });
    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'the candidate turns were GRADED').met).toBe(false);
  });

  test('an unreadable grading probe fails loudly instead of reading as ungraded', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 4, bExecutionGraded: undefined,
    });
    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    const graded = condition(verdict, 'the candidate turns were GRADED');
    expect(graded.met).toBe(false);
    expect(graded.detail).toContain('unreported');
    expect(graded.detail).toContain('4/4');
  });

  test('a baseline that evolved is not a baseline', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, aEvolutionEvents: 3,
      bEvolutionEvents: 4, bExecutionGraded: 2,
    });
    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'the baseline mechanism stayed off').met).toBe(false);
  });

  test('arms that scored different task content fail on the checksum', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 4, bExecutionGraded: 2,
      bChecksumShift: true,
    });
    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'both arms scored the identical task').detail).toContain('alpha');
  });

  test('an arm that spent twice as much is measuring provisioning', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 4, bExecutionGraded: 2,
      bOutputTokens: 200_000,
    });
    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'the arms spent comparably').detail).toContain('B/A');
  });

  test('an honest evolve=false replication is held to the mirror-image bar', () => {
    // Neither arm was supposed to evolve, so "the mechanism acted" would be the
    // wrong question: what has to hold is that neither arm evolved. The pair is
    // still inadmissible as a CONTRAST, and the condition that fails says which.
    const { a, b, paired } = arms({ aEvolve: false, bEvolve: false, bExecutionGraded: 1 });
    const verdict = admissibility(a, b, paired);
    expect(condition(verdict, 'the candidate mechanism was OBSERVED to act').met).toBe(true);
    expect(condition(verdict, 'the candidate mechanism was OBSERVED to act').detail)
      .toContain('needs none');
    expect(verdict.conditions.filter((c) => !c.met).map((c) => c.name))
      .toEqual(['the two arms differ in that state']);
  });
});

describe('flipAccounting', () => {
  test('reports both denominators, each named by what it divides by', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 2, bExecutionGraded: 2,
    });
    expect(armSpend(a).trials).toBe(4);
    expect(armSpend(b).trials).toBe(4);
    const flips = flipAccounting(paired);
    expect(flips.flipped).toEqual(['gamma']);
    expect(flips.overAllShared).toEqual({ flips: 1, of: 4, rate: 0.25 });
    expect(flips.overSameChecksum).toEqual({ flips: 1, of: 4, rate: 0.25 });
  });
});

describe('spend coverage', () => {
  test('a trial that reported no usage makes the arm total a stated lower bound', () => {
    // A turn the agent timeout killed emits no turn_end, so it carries no usage
    // — and it is the most expensive trial in the arm. Summing it as 0 and
    // printing the sum as the spend understates exactly the longest trials.
    const arm = readHarborJob(job('arm', [
      { task: 'alpha', reward: 1, evolve: true, executionGraded: 1, promptTokens: 100, outputTokens: 10 },
      { task: 'beta', reward: 0, evolve: true, executionGraded: 1, noUsage: true },
    ]));
    const spend = armSpend(arm);
    expect(spend.spendUnreported).toBe(1);
    // The arm's `usage` still carries what WAS measured...
    expect(spend.usage.input).toBe(100);
    expect(spend.usage.output).toBe(10);
    // ...but `billableTokens` is null, not 110. It is the denominator of the
    // equal-spend ratio, and a ratio against a lower bound is not a ratio: 110
    // would make this arm look cheaper than the arm it is equalized against,
    // which is the one direction that claim cannot afford to be wrong in.
    expect(spend.billableTokens).toBeNull();
  });
});
