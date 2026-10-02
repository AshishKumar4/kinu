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
  copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
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
  ordinal: v.number(),
  manifestHash: v.string(),
  corpus: v.object({ nTasks: v.number() }),
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
  /** `undefined` leaves the rating probe unreported — not zero. */
  ratedTurns?: number;
  byThumbs?: number;
  turnsReviewed?: number;
  /** Historical metadata carries execution grades, not human ratings. */
  legacyGrading?: number;
  turnsCompleted?: number;
  promptTokens?: number;
  outputTokens?: number;
  checksum?: string;
  /** Emit a trial with no usage at all — what a killed turn leaves behind. */
  noUsage?: boolean;
  noAgentResult?: boolean;
  noVerifierResult?: boolean;
  partialUsage?: boolean;
}

/** A Harbor job directory holding one `result.json` per trial, in the shape the
 *  adapter actually writes — only the fields the reader parses. */
function job(name: string, trials: readonly TrialSpec[]): string {
  const root = scratchDir('bench-external');
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });

  for (const [index, spec] of trials.entries()) {
    const trialDir = join(dir, `${spec.task}__${index}`);
    mkdirSync(trialDir);

    const event = (kind: string, count: number) =>
      Array.from({ length: count }, () => ({ event: kind, message: kind }));

    const turnRatings = spec.ratedTurns === undefined ? null : {
      rated: spec.ratedTurns,
      by_thumbs: spec.byThumbs ?? 0,
      turns: spec.turnsReviewed ?? Math.max(spec.ratedTurns, spec.turnsCompleted ?? 1),
    };

    // Shaped as bench/harbor/kinu_agent.py writes it: an unreadable rating probe
    // is null, not zeroed. Historical results omit turn_ratings entirely.
    const metadata = {
      evolve: spec.evolve,
      usage_complete: !spec.noUsage && !spec.partialUsage,
      tool_calls: 5,
      evolution_events: event('reflection', spec.evolutionEvents ?? 0),
      activity_events: event('bg_job_started', spec.activityEvents ?? spec.evolutionEvents ?? 0),
      turns_completed: spec.turnsCompleted ?? 1,
      turn_ratings: spec.legacyGrading === undefined ? turnRatings : undefined,
      turn_grading: spec.legacyGrading === undefined ? undefined : {
        user_graded: 0, execution_graded: spec.legacyGrading, abandoned: 0,
      },
    };

    // A trial with no usage at all carries the metadata and nothing else.
    const tokens = spec.noUsage ? {} : {
      n_input_tokens: spec.promptTokens ?? 100_000,
      n_output_tokens: spec.outputTokens ?? 1_000,
      n_cache_tokens: 0,
    };

    writeFileSync(join(trialDir, 'result.json'), JSON.stringify({
      task_name: `terminal-bench/${spec.task}`,
      task_checksum: spec.checksum ?? `sum-${spec.task}`,
      config: { agent: { model_name: 'flash', kwargs: { evolve: spec.evolve } } },
      agent_result: spec.noAgentResult ? null : { ...tokens, metadata },
      verifier_result: spec.noVerifierResult ? null : { rewards: { reward: spec.reward } },
      exception_info: null,
    }));
  }

  // Job-level bookkeeping sits beside the trials and must not read as a trial.
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ n_total_trials: trials.length }));
  writeFileSync(join(dir, 'job.log'), 'started\n');

  return dir;
}

const FOUR = ['alpha', 'beta', 'gamma', 'delta'] as const;

function arms(opts: {
  aEvolve: boolean; bEvolve: boolean;
  bEvolutionEvents?: number; bRatedTurns?: number;
  aEvolutionEvents?: number; bOutputTokens?: number;
  bChecksumShift?: boolean;
}) {
  const a = readHarborJob(job('arm-a', FOUR.map((task, i) => ({
    task, reward: i < 2 ? 1 : 0, evolve: opts.aEvolve,
    evolutionEvents: opts.aEvolutionEvents ?? 0, ratedTurns: 1,
  }))));

  const b = readHarborJob(job('arm-b', FOUR.map((task, i) => ({
    task, reward: i < 3 ? 1 : 0, evolve: opts.bEvolve,
    evolutionEvents: opts.bEvolutionEvents ?? 0,
    ratedTurns: opts.bRatedTurns,
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
      { task: 'alpha', reward: 1, evolve: true, evolutionEvents: 3, activityEvents: 9, ratedTurns: 2, byThumbs: 1, turnsReviewed: 3, turnsCompleted: 2 },
    ]));

    expect(arm.trials).toHaveLength(1);
    const [trial] = arm.trials;
    expect(trial?.evolve).toBe(true);
    expect(trial?.evolutionEvents).toBe(3);
    expect(trial?.activityEvents).toBe(9);
    expect(trial?.ratedTurns).toBe(2);
    expect(trial?.turnsCompleted).toBe(2);
  });

  test('an unreported rating probe is null, never zero', () => {
    // The distinction the arm depends on: a probe that produced no readable
    // answer differs from a headless turn nobody rated. Tool exits do not rate
    // turns, so a reported zero is a valid finding, not a broken mechanism.
    const arm = readHarborJob(job('arm', [{ task: 'alpha', reward: 0, evolve: true }]));
    expect(arm.trials[0]?.ratedTurns).toBeNull();
    expect(armSpend(arm).ratedTurns).toBeNull();
    expect(armSpend(arm).ratingUnreported).toBe(1);
  });

  test('zero ratings are reported evidence, not a missing probe', () => {
    const arm = readHarborJob(job('headless', [
      { task: 'alpha', reward: 1, evolve: true, ratedTurns: 0, turnsReviewed: 1 },
    ]));

    expect(arm.trials[0]?.ratedTurns).toBe(0);
    expect(armSpend(arm).ratedTurns).toBe(0);
    expect(armSpend(arm).ratingUnreported).toBe(0);
  });

  test('old execution grades still parse but are not human ratings', () => {
    const arm = readHarborJob(job('historical', [
      { task: 'alpha', reward: 1, evolve: true, legacyGrading: 2 },
    ]));

    expect(arm.trials[0]?.reward).toBe(1);
    expect(arm.trials[0]?.ratedTurns).toBeNull();
    expect(armSpend(arm).ratedTurns).toBeNull();
    expect(armSpend(arm).ratingUnreported).toBe(1);
  });

  test('job-level bookkeeping is not counted as a trial', () => {
    const arm = readHarborJob(job('arm', [
      { task: 'alpha', reward: 1, evolve: false, ratedTurns: 1 },
      { task: 'beta', reward: 0, evolve: false, ratedTurns: 1 },
    ]));

    expect(arm.trials.map((t) => t.taskId)).toEqual(['alpha', 'beta']);
  });
});

describe('armSpend', () => {
  test('counts the trials on which the mechanism was observed to act', () => {
    const arm = readHarborJob(job('arm', [
      { task: 'alpha', reward: 1, evolve: true, evolutionEvents: 2, ratedTurns: 1 },
      { task: 'beta', reward: 0, evolve: true, evolutionEvents: 0, ratedTurns: 1 },
      { task: 'gamma', reward: 0, evolve: true, evolutionEvents: 5, ratedTurns: 3 },
    ]));

    const spend = armSpend(arm);
    expect(spend.trialsWithEvolution).toBe(2);
    expect(spend.totalEvolutionEvents).toBe(7);
    expect(spend.ratedTurns).toBe(5);
    expect(spend.ratingUnreported).toBe(0);
  });

  test('sums measured ratings and keeps missing probe coverage separate', () => {
    const arm = readHarborJob(job('partial-ratings', [
      { task: 'alpha', reward: 1, evolve: true, ratedTurns: 2 },
      { task: 'beta', reward: 0, evolve: true, ratedTurns: 0 },
      { task: 'gamma', reward: 0, evolve: true },
    ]));

    const spend = armSpend(arm);
    expect(spend.ratedTurns).toBe(2);
    expect(spend.ratingUnreported).toBe(1);
  });
});

describe('admissibility — asked before any effect is reported', () => {
  test('a genuine contrast with an observed mechanism and reported ratings is admissible', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 2, bRatedTurns: 2,
    });

    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(true);
    expect(verdict.conditions.every((c) => c.met)).toBe(true);
  });

  test('two arms that both ran evolve=false are a replication and not a contrast', () => {
    // The literal shape of TB2.0 and TB2.1: both jobs configured evolve=false,
    // read afterwards as a comparison of evolution.
    const { a, b, paired } = arms({ aEvolve: false, bEvolve: false, bRatedTurns: 1 });
    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'the two arms differ in that state').met).toBe(false);
    expect(condition(verdict, 'the two arms differ in that state').detail)
      .toContain('replication, not a contrast');
  });

  test('a candidate configured to evolve that never evolved fails on the observation', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 0, bRatedTurns: 2,
    });

    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'the candidate mechanism was OBSERVED to act').met).toBe(false);
    expect(condition(verdict, 'the candidate mechanism was OBSERVED to act').detail)
      .toContain('0/4');
  });

  test('a headless candidate with measured zero ratings is admissible', () => {
    // Ratings need a person's reply. With no reactive user, a readable zero is
    // the expected finding and must not make an otherwise valid contrast fail.
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 4, bRatedTurns: 0,
    });

    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(true);
    const ratings = condition(verdict, 'the candidate turn ratings were reported');
    expect(ratings.met).toBe(true);
    expect(ratings.detail).toContain('0 rated turn(s)');
    expect(ratings.detail).toContain('not a failure');
  });

  test('an unreadable rating probe fails loudly instead of reading as unrated', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 4, bRatedTurns: undefined,
    });

    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    const ratings = condition(verdict, 'the candidate turn ratings were reported');
    expect(ratings.met).toBe(false);
    expect(ratings.detail).toContain('unreported');
    expect(ratings.detail).toContain('4/4');
  });

  test('a baseline that evolved is not a baseline', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, aEvolutionEvents: 3,
      bEvolutionEvents: 4, bRatedTurns: 2,
    });

    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'the baseline mechanism stayed off').met).toBe(false);
  });

  test('arms that scored different task content fail on the checksum', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 4, bRatedTurns: 2,
      bChecksumShift: true,
    });

    const verdict = admissibility(a, b, paired);
    expect(verdict.admissible).toBe(false);
    expect(condition(verdict, 'both arms scored the identical task').detail).toContain('alpha');
  });

  test('an arm that spent twice as much is measuring provisioning', () => {
    const { a, b, paired } = arms({
      aEvolve: false, bEvolve: true, bEvolutionEvents: 4, bRatedTurns: 2,
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
    const { a, b, paired } = arms({ aEvolve: false, bEvolve: false, bRatedTurns: 1 });
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
      aEvolve: false, bEvolve: true, bEvolutionEvents: 2, bRatedTurns: 2,
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
      { task: 'alpha', reward: 1, evolve: true, ratedTurns: 1, promptTokens: 100, outputTokens: 10 },
      { task: 'beta', reward: 0, evolve: true, ratedTurns: 1, noUsage: true },
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

describe('repeated-trial denominators', () => {
  test('keeps every reward and refuses unequal repetitions', () => {
    const a = readHarborJob(job('a', [
      { task: 'repeat', reward: 0, evolve: false },
      { task: 'repeat', reward: 1, evolve: false },
    ]));

    const b = readHarborJob(job('b', [
      { task: 'repeat', reward: 1, evolve: true },
      { task: 'repeat', reward: 1, evolve: true },
    ]));

    const row = pairArms(a, b).paired[0];
    expect(row?.aRewards).toEqual([0, 1]);
    expect(row?.bRewards).toEqual([1, 1]);
    expect(row?.a).toBe(0.5);
    expect(row?.b).toBe(1);
    expect(() => pairArms(a, { ...b, trials: b.trials.slice(1) })).toThrow('unequal repetitions');
  });

  test('an unfinished configured trial cannot disappear from the denominator', () => {
    const path = job('partial', [{ task: 'done', reward: 1, evolve: false }]);
    const pending = join(path, 'pending__x');
    mkdirSync(pending);
    writeFileSync(join(pending, 'config.json'), JSON.stringify({ task: { path: '/tasks/pending' }, agent: { model_name: 'flash' } }));
    writeFileSync(join(path, 'result.json'), JSON.stringify({ n_total_trials: 3 }));
    const arm = readHarborJob(path);
    const summary = armSpend(arm);
    expect(summary.trials).toBe(3);
    expect(summary.verifiedSuccesses).toBe(1);
    expect(summary.unscoredTrials).toBe(2);
    expect(summary.spendUnreported).toBe(2);
    expect(summary.ratingUnreported).toBe(3);
    expect(arm.trials.find((trial) => trial.taskId === 'pending')?.ratedTurns).toBeNull();
    expect(arm.trials.find((trial) => trial.taskId === 'pending')?.reward).toBeNull();
    expect(summary.billableTokens).toBeNull();
  });
  test('partial metering keeps the verifier success but refuses an equal-spend claim', () => {
    const arm = readHarborJob(job('partial-spend', [{ task: 'solved', reward: 1, evolve: true, partialUsage: true }]));
    const summary = armSpend(arm);
    expect(summary.verifiedSuccesses).toBe(1);
    expect(summary.trials).toBe(1);
    expect(summary.usage.input).toBe(100000);
    expect(summary.spendUnreported).toBe(1);
    expect(summary.billableTokens).toBeNull();
  });
  test('contradictory cached input cannot become a cheap complete trial', () => {
    const arm = readHarborJob(job('bad-cache-usage', [{ task: 'solved', reward: 1, evolve: false }]));
    const trial = arm.trials[0];

    if (!trial) throw new Error('missing trial fixture');
    trial.usage = { input: 0, output: 0, cacheRead: 40192 };
    const summary = armSpend(arm);
    expect(summary.verifiedSuccesses).toBe(1);
    expect(summary.usage).toEqual(trial.usage);
    expect(summary.billableTokens).toBeNull();
    expect(summary.spendUnreported).toBe(1);
  });
  test('official success and failure survive absent internal telemetry', () => {
    const arm = readHarborJob(job('no-trace', [
      { task: 'solved', reward: 1, evolve: true, noAgentResult: true },
      { task: 'failed', reward: 0, evolve: true, noAgentResult: true },
      { task: 'ungraded', reward: 1, evolve: true, noAgentResult: true, noVerifierResult: true },
    ]));

    const summary = armSpend(arm);
    expect(summary.verifiedSuccesses).toBe(1);
    expect(summary.verifierFailures).toBe(1);
    expect(summary.unscoredTrials).toBe(1);
    expect(summary.trials).toBe(3);
    expect(summary.ratingUnreported).toBe(3);
    expect(arm.trials.find((trial) => trial.taskId === 'solved')?.passed).toBe(true);
    expect(arm.trials.find((trial) => trial.taskId === 'failed')?.passed).toBe(false);
    expect(arm.trials.find((trial) => trial.taskId === 'ungraded')?.passed).toBeNull();
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

  // The real sampler needs task-directory names and task.toml presence, not
  // the optional 60 MB corpus. This pinned population is selection-only; the
  // expected draw comes from the original seal, never the sampler under test.
  test('the seeded sample reproduces the pre-registered task list', () => {
    const population = v.parse(v.object({
      provenance: v.object({ expectedSampleOrdinal: v.number() }),
      sourceCorpus: v.object({ content_hash: v.string() }),
      taskIds: v.array(v.string()),
    }), JSON.parse(readFileSync(join(REPO_ROOT, 'bench/corpus/terminal-bench-2.1-population.json'), 'utf8')));

    const registered = readFileSync(join(REPO_ROOT, 'bench/corpus/seal-ledger.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => v.safeParse(TbenchPrereg, JSON.parse(line)))
      .find((parsed) => parsed.success && parsed.output.ordinal === population.provenance.expectedSampleOrdinal);

    if (!registered?.success) throw new Error('the pinned Terminal-Bench pre-registration is missing');
    const { seed, size, tasks } = registered.output.sample;
    expect(population.sourceCorpus.content_hash).toBe(registered.output.manifestHash);
    expect(population.taskIds).toHaveLength(registered.output.corpus.nTasks);
    expect(new Set(population.taskIds).size).toBe(population.taskIds.length);
    const corpus = scratchDir('tbench-selection-population');

    for (const taskId of population.taskIds) {
      const task = join(corpus, taskId);
      mkdirSync(task);
      writeFileSync(join(task, 'task.toml'), '# Selection-only population marker; not a runnable task.\n');
    }

    const drawn = spawnSync('python3', ['-m', 'bench.harbor.corpus', 'sample', corpus,
      '--size', String(size), '--seed', String(seed)],
    { cwd: REPO_ROOT, env: { ...process.env, PYTHONPATH: REPO_ROOT }, encoding: 'utf8' });

    expect(drawn.status, drawn.stderr).toBe(0);

    expect(v.parse(DrawnSample, JSON.parse(drawn.stdout)).tasks).toEqual(tasks);
  });
});
