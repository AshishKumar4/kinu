#!/usr/bin/env bun
// Opt-in evaluations: native armada CLI map tasks and its artifact extractor; light post-steps read those outputs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { MUSE_CALLS_AT_ONCE, evalMatrix, type EvalMatrix } from '../evals/src/config';
import { claimLabel, type SlotClaim } from '../evals/src/slot';
import { collectEvalTasks } from '../evals/src/eval';
import type { EvalTask } from '../evals/src/task';
import { ARMS, deployedBuild } from '../evals/src/target';
import { evalTargetVerdict, evalWebIdentityEnv } from '../packages/test-utils/src/eval-identity';
import { deploymentOf } from './infra-manifest';
import { gitIn } from '../packages/test-utils/src/git-env';
import { MapResultSchema, type EvalRun, type MapResult, type TrialItem } from './evals-artifacts';
import { drainArmadaProgress } from './armada-progress';
import { KINU_ARMADA, kinuArmada, leaseBlock, outranked } from './evals-lease';
import { NETWORK_SCOPE, processEvals } from './evals-post';
import { isEvalTask, trackedFiles } from './sources';
import { REPO_ROOT as ROOT } from './repo-root';


/** Keep each cell's whole matrix for trialSlot: selection does not renumber its account. */
export function evalItems(taskFiles: readonly string[], matrix: EvalMatrix, origins: readonly { leg: 'candidate' | 'baseline'; origin: string }[], pass: boolean): TrialItem[] {
  const models = [...matrix.models];
  const arms = [...matrix.arms];

  return taskFiles.flatMap((file) => {
    const task = file.slice('evals/tasks/'.length).replace(/\.eval\.ts$/u, '');

    return models.flatMap((model) => arms.flatMap((arm) =>
      Array.from({ length: matrix.trials }, (_, index) => origins.map(({ leg, origin }) => ({
        leg, origin, task, model, arm, trial: index + 1, trials: matrix.trials, models, arms, pass, firstSlot: matrix.firstSlot,
      }))).flat()));
  });
}

/** A trial as armada queues it: what each of its runs spends of the shared Muse budget (`cost`, its task's recorded
 *  model-call peak), and its place in the one queue (`weight`, the same: the widest trials start while the budget is
 *  whole, and narrower ones fill what they leave). A cell's two legs are adjacent and weigh alike, so they start
 *  together and meet the provider at the same hour. */
export type QueuedTrial = TrialItem & { readonly cost: number; readonly weight: number };

/** Every trial in one work-conserving queue under one ceiling, both legs together: a trial starts whenever its cost
 *  fits what the running trials leave of `MUSE_CALLS_AT_ONCE` (armada's `budget`), so no share of it waits idle on a
 *  queue that drained. Replayed on the 51 trials 66938aa25 finished: 4,854 s against 10,268 s for the four fixed
 *  width pools it replaces. */
export function evalQueue(items: readonly TrialItem[], tasks: readonly EvalTask[]): QueuedTrial[] {
  const peaks = new Map(tasks.map((task) => [task.id, task.modelCallPeak]));

  return items.map((item) => {
    const peak = peaks.get(item.task);

    if (peak === undefined || peak.source.trim() === '' || !Number.isSafeInteger(peak.calls) || peak.calls < 1 || peak.calls > MUSE_CALLS_AT_ONCE) {
      throw new Error(`${item.task} names no measured model-call peak from 1 to ${String(MUSE_CALLS_AT_ONCE)} with a source`);
    }

    return { ...item, cost: peak.calls, weight: peak.calls };
  });
}

/** Only armada's supported CLI: one map of `trials` items under the shared budget, as many containers as the budget
 *  can run trials at once, no elapsed limit on the job or a trial (each ends on its own; the job ends once this
 *  command stops following it), the commit's checkout and per-task artifact extraction. */
export function evalMapArgv({ sha, out, identities, trials, claim }: {
  readonly sha: string; readonly out: string; readonly identities: readonly string[]; readonly trials: number; readonly claim: SlotClaim;
}): string[] {
  return [join(ROOT, 'node_modules', '.bin', 'armada'), 'map',
    `--connection=${KINU_ARMADA}`, `--commit=${sha}`,
    '--items=-', `--pool=${String(Math.min(trials, MUSE_CALLS_AT_ONCE))}`, `--budget=${String(MUSE_CALLS_AT_ONCE)}`,
    '--deadline=none', '--timeout=none',
    `--artifacts=${join(out, 'trials')}`, `--secrets=${identities.join(',')}`, '--json',
    `--label=${claimLabel(sha, claim)}`, '--', 'bun', 'evals/scripts/trial.ts'];
}

/** The explicitly selected matrix, from the one tracked task enumeration; unknown or repeated tasks never run. */
export function evalTaskFiles(allTasks: readonly string[], requested: string | undefined): string[] {
  const selected = requested === undefined
    ? allTasks.map((file) => file.slice('evals/tasks/'.length).replace(/\.eval\.ts$/u, '')) : requested.split(',');

  const files = selected.map((task) => `evals/tasks/${task}.eval.ts`);

  if (files.length === 0 || files.some((file) => !allTasks.includes(file)) || new Set(files).size !== files.length) {
    throw new Error(`--tasks must name distinct tasks from ${allTasks.join(', ')}`);
  }

  return files;
}

/** Decode the native JSON-lines contract while draining progress concurrently, without a pipe deadlock; `started` hears
 *  the job's id as soon as armada names it, before any trial ends. */
async function mapTrials(argv: string[], items: readonly QueuedTrial[], started: (job: string) => void) {
  const env = { ...process.env };

  delete env['ARMADA_URL'];
  delete env['ARMADA_TOKEN'];

  const child = Bun.spawn(argv, { cwd: ROOT, env, stdin: new Blob([JSON.stringify(items)]), stdout: 'pipe', stderr: 'pipe' });

  const outcomes: MapResult[] = [];
  const began = Date.now();
  let pending = '';
  const decode = new TextDecoder();

  const interrupt = (): void => { child.kill('SIGINT'); };

  const terminate = (): void => { child.kill('SIGTERM'); };

  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);

  let progress: Awaited<ReturnType<typeof drainArmadaProgress>>;

  try {
    [progress] = await Promise.all([
      drainArmadaProgress(child.stderr, started),
      (async () => {
        for await (const bytes of child.stdout) {
          pending += decode.decode(bytes, { stream: true });
          let end = pending.indexOf('\n');

          while (end !== -1) {
            const line = pending.slice(0, end).trim();

            pending = pending.slice(end + 1);

            if (line !== '') {
              const outcome = v.parse(MapResultSchema, JSON.parse(line));
              const item = items[outcome.index];

              if (item === undefined || outcomes.some((held) => held.index === outcome.index)) throw new Error(`unexpected armada task index ${String(outcome.index)}`);
              outcomes.push(outcome);
              console.log(`${item.leg} ${item.task} trial ${String(item.trial)}: ${outcome.kind}, ${outcome.seconds.toFixed(1)}s, `
                + `${String(outcomes.length)} of ${String(items.length)} in ${((Date.now() - began) / 1000).toFixed(0)}s`);
            }

            end = pending.indexOf('\n');
          }
        }

        pending += decode.decode();

        if (pending.trim() !== '') outcomes.push(v.parse(MapResultSchema, JSON.parse(pending)));
      })(),
    ]);
  } catch (cause) {
    child.kill('SIGTERM');
    await child.exited;

    throw new Error('armada map did not produce its documented JSON-lines output', { cause });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }

  const exitCode = await child.exited;
  const { job } = progress;

  if (job === undefined) throw new Error(`armada map exited ${String(exitCode)} without naming its job: ${progress.said}`);

  return { job, outcomes, exitCode };
}

/**
 * The legs a run measures, each a deployment and the build it serves: staging against production, staging alone
 * (`stagingOnly`), or the one deployment KINU_EVAL_ORIGIN names (`pass`). `asked` is the build the caller expects the
 * candidate to serve.
 */
async function legsOf(pass: boolean, stagingOnly: boolean, asked: string | undefined) {
  const target = evalTargetVerdict(pass ? process.env['KINU_EVAL_ORIGIN'] : deploymentOf('staging').origin);

  if (target.kind === 'refused' || target.why !== 'deployment') throw new Error('evals-map names a real Kinu deployment through KINU_EVAL_ORIGIN');

  const origins: { leg: 'candidate' | 'baseline'; origin: string }[] = [{ leg: 'candidate', origin: target.origin }];

  if (!pass && !stagingOnly) origins.push({ leg: 'baseline', origin: deploymentOf('production').origin });

  const [candidateBuild = '', baselineBuild = ''] = await Promise.all(origins.map(async ({ origin }) => (await deployedBuild({ origin })).sha));

  if (asked !== undefined && !candidateBuild.startsWith(asked) && !asked.startsWith(candidateBuild)) {
    throw new Error(`${target.origin} serves ${candidateBuild}, not the requested ${asked}`);
  }

  return { origins, candidateBuild, baselineBuild };
}

/** What one run maps: its definitions, where its artifacts go, its legs, matrix and tasks, and the trial accounts its
 *  matrix numbers over (`slots` task files: a trial's account counts every task, run or not). */
type MapPlan = {
  readonly sha: string; readonly out: string; readonly origins: readonly { leg: 'candidate' | 'baseline'; origin: string }[];
  readonly matrix: EvalMatrix; readonly taskFiles: readonly string[]; readonly slots: number; readonly pass: boolean;
};

/**
 * The run's trials on a block of trial accounts no open run holds (scripts/evals-lease.ts), each origin's keys stored on
 * that block first. A run that took a block at the same moment as an earlier one gives it up and leases again.
 */
async function leasedMap(plan: MapPlan, started: (job: string) => void) {
  const armada = kinuArmada();
  const hosts = plan.origins.map(({ origin }) => new URL(origin).host);
  const size = plan.slots * plan.matrix.models.length * plan.matrix.arms.length * plan.matrix.trials;
  const tasks = await collectEvalTasks();

  for (;;) {
    const first = await leaseBlock(armada, { size, pass: plan.pass, hosts }, console.log);
    const claim = { first, last: first - 1 + size, hosts };
    const matrix = { ...plan.matrix, firstSlot: first };
    const items = evalQueue(evalItems(plan.taskFiles, matrix, plan.origins, plan.pass), tasks);

    // Standalone runs need the same actual credentials/catalog as deploy --evals, on exactly the block leased. Only the
    // operator's provisioning step reads the existing key file; trial containers receive identities, never Muse keys.
    for (const { origin } of plan.origins) {
      const provision = Bun.spawn([...NETWORK_SCOPE, process.execPath, 'scripts/eval-provider-keys.ts', origin, `--accounts=${String(first)}-${String(claim.last)}`], {
        cwd: ROOT, env: { ...process.env, KINU_EVAL_MODELS: matrix.models.join(',') },
        stdout: 'inherit', stderr: 'inherit',
      });

      if (await provision.exited !== 0) throw new Error(`actual eval keys/catalog were not provisioned at ${origin}; no trials started`);
    }

    const identities = [...new Set(plan.origins.map(({ origin }) => evalWebIdentityEnv(origin)))];
    const argv = evalMapArgv({ sha: plan.sha, out: plan.out, identities, trials: items.length, claim });
    let lost = false;
    let checked: Promise<void> = Promise.resolve();

    console.log(`evals: ${String(items.length)} trials on trial-${String(first)} to trial-${String(claim.last)}, in one queue under ${String(MUSE_CALLS_AT_ONCE)} calls at once, each spending its task's peak`);

    const mapped = await mapTrials(argv, items, (named) => {
      started(named);
      checked = (async () => {
        if (!await outranked(armada, named, claim)) return;
        lost = true;
        console.log(`evals: an earlier run took trial-${String(first)} to trial-${String(claim.last)} at the same moment; giving them up`);
        await armada.cancel(named);
      })();
    });

    await checked;

    if (!lost) return { items, ...mapped };
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    tasks: { type: 'string' }, trials: { type: 'string' }, out: { type: 'string' }, post: { type: 'string' },
    pass: { type: 'boolean', default: false }, record: { type: 'boolean', default: false },
    'staging-only': { type: 'boolean', default: false },
  } });

  // Staging alone measures the models a run names against each other on one build: no production leg, so no verdict.
  if (values['staging-only'] && (values.pass || values.record || values.post !== undefined)) {
    throw new Error('--staging-only measures models, never a build\'s verdict: drop --pass, --record and --post');
  }

  const sha = gitIn(ROOT, 'rev-parse', 'HEAD');

  if (gitIn(ROOT, 'status', '--porcelain') !== '') throw new Error('armada measures a committed checkout: commit the tree first');
  const { origins, candidateBuild, baselineBuild } = await legsOf(values.pass, values['staging-only'], positionals[0]);

  const matrix = evalMatrix({ ...process.env, KINU_EVAL_TRIALS: values.pass ? '1' : values.trials ?? process.env['KINU_EVAL_TRIALS'] }, ARMS.map((arm) => arm.id));
  const allTasks = trackedFiles().filter(isEvalTask).sort();

  const taskFiles = evalTaskFiles(allTasks, values.tasks);

  const out = resolve(values.out ?? process.env['BENCH_ARTIFACTS'] ?? join(ROOT, 'bench-artifacts', 'evals-armada', `${String(Date.now())}-${sha.slice(0, 12)}`));

  mkdirSync(out, { recursive: true });
  const startedAt = Date.now();

  const run: EvalRun = {
    definitions: sha, candidateBuild, baselineBuild, taskFiles, models: [...matrix.models], arms: [...matrix.arms],
    trials: matrix.trials, startedAt, jobs: [], budget: MUSE_CALLS_AT_ONCE, pass: values.pass,
  };

  // Kept as soon as armada names the job, so a run cut short still says which job holds its trials.
  const { items, job, outcomes } = await leasedMap({ sha, out, origins, matrix, taskFiles, slots: allTasks.length, pass: values.pass }, (named) => {
    run.jobs = [named];
    writeFileSync(join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  });

  run.jobs = [job];
  writeFileSync(join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(out, 'trial-job.json'), `${JSON.stringify({ job, outcomes }, null, 2)}\n`);

  if (outcomes.some((outcome) => outcome.kind === 'cancelled')) return 130;

  const postExit = await processEvals(run, items, outcomes, join(out, 'evals'));

  run.wallSeconds = (Date.now() - startedAt) / 1000;
  writeFileSync(join(out, 'evals', 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`report: ${join(out, 'evals')}; wall ${run.wallSeconds.toFixed(1)}s, armada job ${job}`);

  if (values.record) {
    const recorded = Bun.spawn([...NETWORK_SCOPE, process.execPath, 'scripts/promote.ts', 'evals', join(out, 'evals')],
      { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });

    if (await recorded.exited !== 0) throw new Error('recording this eval verdict failed');
  }

  if (values.post !== undefined) {
    for (const [name, marker] of [['comparison', '<!-- kinu-evals-results -->'], ['why', '<!-- kinu-evals-why -->']] as const) {
      const posted = Bun.spawn([...NETWORK_SCOPE, 'bash', 'evals/scripts/post-comment.sh', values.post, join(out, 'evals', name, 'comment.md'), marker],
        { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });

      if (await posted.exited !== 0) throw new Error(`posting the ${name} comment failed`);
    }
  }

  return postExit;
}

if (import.meta.main) process.exitCode = await main();
