// The bridge from somebody else's retained trials to this repo's statistics —
// and the gate that decides whether those trials can carry a claim at all.
//
// Untested until now, which is how two Terminal-Bench jobs configured
// `evolve=false` in BOTH arms became a circulated sentence about self-evolution:
// nothing in the path from result.json to the printed effect ever asked what the
// arms actually did. These tests are written against that failure, not against
// the happy path.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { git, initRepo, scratchDir } from '@kinu.run/test-utils';
import {
  admissibility, armSpend, flipAccounting, pairArms, readHarborJob,
} from './bench-external';
import type { Admissibility, AdmissibilityCondition } from './bench-external';

const REPO_ROOT = join(import.meta.dir, '..');

/** The pre-registration this family's corpus check reads, and only the fields it
 *  reads. A `looseObject` because a ledger row carries a design's whole record and
 *  this test has no business asserting the rest of it. */
const TbenchPrereg = v.looseObject({
  family: v.literal('external:terminal-bench'),
  kind: v.literal('preregistration'),
  sample: v.object({
    seed: v.number(), size: v.number(), tasks: v.array(v.string()),
  }),
});

/** What `bench.harbor.corpus sample` prints. Parsed rather than asserted: the
 *  sampler is another process, so its stdout is a boundary. */
const DrawnSample = v.object({ tasks: v.array(v.string()) });

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
  const root = scratchDir('bench-external');
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const spec of trials) {
    const trialDir = join(dir, `${spec.task}__x`);
    mkdirSync(trialDir);
    const event = (name: string, count: number) =>
      Array.from({ length: count }, () => ({ event: name, message: name }));
    // Shaped exactly as bench/harbor/kinu_agent.py writes it. `turn_grading`
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

/**
 * The Terminal-Bench arm's own pre-flight, which is the half of this family that
 * runs before any trial and therefore before any bill.
 *
 * Both tests are credential-free and neither starts harbor. They exist because
 * the arm was unrunnable for a reason no test could see: `CORPUS` was an absolute
 * path naming the operator's checkout directory, and the rename to Kinu rewrote
 * that directory inside it. From that commit the arm resolved a corpus that had
 * never existed, and the sampler's `FileNotFoundError` went into a pipe and came
 * back out as "the sample returned 0 tasks" — a count where the cause should have
 * been.
 */
describe('the Terminal-Bench arm before it spends anything', () => {
  const ARM = join(REPO_ROOT, 'scripts/tbench-arm.sh');

  /** The arm's environment, minus everything it refuses to inherit. Built by
   *  subtraction so the trap list and this fixture cannot drift: whatever the
   *  script names, an absent variable satisfies. */
  function armEnv(home: string) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('KINU_') && key !== 'TBENCH_CORPUS') {
        env[key] = value;
      }
    }
    return { ...env, HOME: home };
  }

  test('the corpus it looks for is inside the tree it runs from', () => {
    // A throwaway repository holding nothing but the script, so the resolved
    // path is attributable: whatever the arm names, it derived from THIS tree.
    // The old absolute literal would have named a directory somewhere else
    // entirely, which is exactly the regression this asserts against.
    const tree = realpathSync(scratchDir('tbench-arm'));
    initRepo(tree);
    git(tree, 'commit', '--allow-empty', '-qm', 'root');
    mkdirSync(join(tree, 'scripts'), { recursive: true });
    copyFileSync(ARM, join(tree, 'scripts/tbench-arm.sh'));
    const home = join(tree, 'home');
    mkdirSync(home, { recursive: true });

    const run = spawnSync('bash', [join(tree, 'scripts/tbench-arm.sh'),
      'false', '20260817', '40', '@cf/deepseek-ai/deepseek-v4-flash-0731', '2'],
    { env: armEnv(home), encoding: 'utf8' });

    expect(run.status).toBe(2);
    const named = /^REFUSING: no Terminal-Bench corpus at (.+)\.$/m.exec(run.stderr);
    expect(named, `the arm refused without naming a corpus: ${run.stderr}`).not.toBeNull();
    expect(named?.[1]).toBe(join(tree, 'terminal-bench-2.1'));
    // And it refused HERE rather than at the credential, which is what makes this
    // refusal provable by anyone: a check reachable only with a token is a check
    // nobody exercises.
    expect(run.stderr).not.toContain('eval-service credential');
  });

  /**
   * The corpus on disk is the corpus the design was registered against.
   *
   * Nothing else asserts this, and it is the assumption every number from
   * ordinals 6 to 8 rests on. Both sides are DERIVED — the expected list from the
   * pre-registration, the actual from the one sampler in `bench/harbor/corpus.py`
   * — so a corpus that was re-fetched, edited or swapped shows up as a
   * disagreement instead of as a quiet difference in what got measured.
   *
   * Skipped without a corpus, which is the ordinary state of a worktree: the
   * 89 task directories are 60 MB and gitignored. `TBENCH_CORPUS` points at a
   * shared copy, and it is the same variable the arm reads.
   */
  const corpus = process.env.TBENCH_CORPUS ?? join(REPO_ROOT, 'terminal-bench-2.1');
  const withCorpus = test.skipIf(!existsSync(corpus));

  withCorpus('the seeded sample reproduces the pre-registered task list', () => {
    const registered = readFileSync(join(REPO_ROOT, 'tests/bench/seal-ledger.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => v.safeParse(TbenchPrereg, JSON.parse(line)))
      .find((parsed) => parsed.success);
    expect(registered, 'no Terminal-Bench pre-registration carries a sample').toBeDefined();
    const { seed, size, tasks } = registered!.output!.sample;

    const drawn = spawnSync('python3', ['-m', 'bench.harbor.corpus', 'sample', corpus,
      '--size', String(size), '--seed', String(seed)],
    { cwd: REPO_ROOT, env: { ...process.env, PYTHONPATH: REPO_ROOT }, encoding: 'utf8' });
    expect(drawn.status, drawn.stderr).toBe(0);

    expect(v.parse(DrawnSample, JSON.parse(drawn.stdout)).tasks).toEqual(tasks);
  });
});
