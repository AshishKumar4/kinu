#!/usr/bin/env bun
// Opt-in evaluations: native armada CLI map tasks and its artifact extractor; light post-steps read those outputs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { MUSE_CALLS_AT_ONCE, evalMatrix, type EvalMatrix } from '../evals/src/config';
import { claimLabel, trialAccounts, trialInheritedRows, type SlotClaim } from '../evals/src/slot';
import { collectEvalTasks } from '../evals/src/eval';
import type { EvalTask } from '../evals/src/task';
import { ARMS, deployedBuild } from '../evals/src/target';
import { evalTargetVerdict, evalWebIdentityEnv } from '../packages/test-utils/src/eval-identity';
import { deploymentOf } from './infra-manifest';
import { gitIn } from '../packages/test-utils/src/git-env';
import { MapResultSchema, type EvalRun, type MapResult, type TrialItem } from './evals-artifacts';
import { drainArmadaProgress } from './armada-progress';
import { KINU_ARMADA, keysWindows, kinuArmada, leaseBlock, outranked } from './evals-lease';
import { EVAL_SUITES, suiteTasks, type EvalSuite } from './evals-suites';
import { NETWORK_SCOPE, processEvals, resolveGh, settleEvalRun } from './evals-post';
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
        leg, origin, task, model, arm, trial: index + 1, trials: matrix.trials, models, arms, pass, firstSlot: matrix.firstSlot, sequence: matrix.sequence,
      }))).flat()));
  });
}

/** A trial as armada queues it: what each of its runs spends of the shared Muse budget (`cost`, its task's recorded
 *  model-call peak), and its place in the one queue (`weight`, the same: the widest trials start while the budget is
 *  whole, and narrower ones fill what they leave). A cell's two legs are adjacent and weigh alike, so they start
 *  together and meet the provider at the same hour. */
export type QueuedTrial = TrialItem & { readonly cost: number; readonly weight: number };

/** Every trial in one work-conserving queue under one ceiling, both legs together: a trial starts whenever its cost
 *  fits what the running trials leave of `budget` (armada's; `MUSE_CALLS_AT_ONCE` unless a run names a lower one), so
 *  no share of it waits idle on a queue that drained. Replayed on the 51 trials 66938aa25 finished: 4,854 s against
 *  10,268 s for the four fixed width pools it replaces. */
export function evalQueue(items: readonly TrialItem[], tasks: readonly EvalTask[], budget = MUSE_CALLS_AT_ONCE): QueuedTrial[] {
  const peaks = new Map(tasks.map((task) => [task.id, task.modelCallPeak]));

  return items.map((item) => {
    const peak = peaks.get(item.task);

    if (peak === undefined || peak.source.trim() === '' || !Number.isSafeInteger(peak.calls) || peak.calls < 1 || peak.calls > budget) {
      throw new Error(`${item.task} names no measured model-call peak from 1 to ${String(budget)} with a source`);
    }

    return { ...item, cost: peak.calls, weight: peak.calls };
  });
}

/** Only armada's supported CLI: one map of `trials` items under the shared budget, as many containers as the budget
 *  can run trials at once, no elapsed limit on the job or a trial (each ends on its own; the job ends once this
 *  command stops following it), the commit's checkout and per-task artifact extraction. */
export function evalMapArgv({ sha, out, identities, trials, claim, budget = MUSE_CALLS_AT_ONCE, sequence = false }: {
  readonly sha: string; readonly out: string; readonly identities: readonly string[]; readonly trials: number; readonly claim: SlotClaim;
  /** The model calls the run's trials make at once, at most; `MUSE_CALLS_AT_ONCE` unless the run names fewer. */
  readonly budget?: number;
  /** One trial at a time: a sequence's tasks share one account and run in the queue's order. */
  readonly sequence?: boolean;
}): string[] {
  return [join(ROOT, 'node_modules', '.bin', 'armada'), 'map',
    `--connection=${KINU_ARMADA}`, `--commit=${sha}`,
    '--items=-', `--pool=${String(sequence ? 1 : Math.min(trials, budget))}`, `--budget=${String(budget)}`,
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
 * (`stagingOnly`), production alone (`daily`: its baseline is the day before's run, `promote.ts daily`), or the one
 * deployment KINU_EVAL_ORIGIN names (`pass`). `asked` is the build the caller expects the candidate to serve.
 */
async function legsOf(pass: boolean, stagingOnly: boolean, daily: DailyDeployment | null, asked: string | undefined) {
  const candidateOrigin = pass ? process.env['KINU_EVAL_ORIGIN'] : deploymentOf(daily ?? 'staging').origin;
  const target = evalTargetVerdict(candidateOrigin);

  if (target.kind === 'refused' || target.why !== 'deployment') throw new Error('evals-map names a real Kinu deployment through KINU_EVAL_ORIGIN');

  const origins: { leg: 'candidate' | 'baseline'; origin: string }[] = [{ leg: 'candidate', origin: target.origin }];

  if (!pass && !stagingOnly && daily === null) origins.push({ leg: 'baseline', origin: deploymentOf('production').origin });

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
  /** The model calls at once, at most (`--calls-at-once`). */
  readonly budget: number;
};

/** Before a sequence's first task: each of its accounts holds nothing another run left, its provisioning just reset. */
async function sequencesIsolated(plan: MapPlan, matrix: EvalMatrix): Promise<void> {
  for (const { origin } of plan.origins) {
    const secret = process.env[evalWebIdentityEnv(origin)] ?? '';

    for (const account of trialAccounts(plan.taskFiles.map((file) => file.slice('evals/tasks/'.length)), matrix)) {
      const read = await trialInheritedRows({ origin, identity: { kind: 'secret', secret, account } });
      const held = 'why' in read ? read.why : Object.entries(read.inherited).map(([table, rows]) => `${table} ${String(rows)}`).join(', ');

      if (held !== '') throw new Error(`${account} at ${origin} cannot open a sequence: ${held}`);
    }
  }
}

/**
 * The run's trials on a block of trial accounts no open run holds (scripts/evals-lease.ts), each origin's keys stored on
 * that block first. A run that took a block at the same moment as an earlier one gives it up and leases again.
 */
async function leasedMap(plan: MapPlan, started: (job: string) => void) {
  const armada = kinuArmada();
  const hosts = plan.origins.map(({ origin }) => new URL(origin).host);
  // A trial's account counts every task file, run or not; a sequence's counts none, its tasks sharing one.
  const size = (plan.matrix.sequence ? 1 : plan.slots) * plan.matrix.models.length * plan.matrix.arms.length * plan.matrix.trials;
  const tasks = await collectEvalTasks();

  await keysWindows(console.log);

  for (;;) {
    const first = await leaseBlock(armada, { size, pass: plan.pass, hosts }, console.log);
    const claim = { first, last: first - 1 + size, hosts };
    const matrix = { ...plan.matrix, firstSlot: first };
    const items = evalQueue(evalItems(plan.taskFiles, matrix, plan.origins, plan.pass), tasks, plan.budget);

    // Standalone runs need the same actual credentials/catalog as deploy --evals, on exactly the block leased. Only the
    // operator's provisioning step reads the existing key file; trial containers receive identities, never Muse keys.
    for (const { origin } of plan.origins) {
      const provision = Bun.spawn([...NETWORK_SCOPE, process.execPath, 'scripts/eval-provider-keys.ts', origin, `--accounts=${String(first)}-${String(claim.last)}`], {
        cwd: ROOT, env: { ...process.env, KINU_EVAL_MODELS: matrix.models.join(',') },
        stdout: 'inherit', stderr: 'inherit',
      });

      if (await provision.exited !== 0) throw new Error(`actual eval keys/catalog were not provisioned at ${origin}; no trials started`);
    }

    // A sequence's tasks open on what its earlier tasks left (prepareTrialAccount), so each account is checked once, here.
    if (matrix.sequence) await sequencesIsolated(plan, matrix);

    const identities = [...new Set(plan.origins.map(({ origin }) => evalWebIdentityEnv(origin)))];
    const argv = evalMapArgv({ sha: plan.sha, out: plan.out, identities, trials: items.length, claim, budget: plan.budget, sequence: matrix.sequence });
    let lost = false;
    let checked: Promise<void> = Promise.resolve();

    console.log(`evals: ${String(items.length)} trials on trial-${String(first)} to trial-${String(claim.last)}, in one queue under ${String(plan.budget)} calls at once, each spending its task's peak`);

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

/** `ended`, the run's trials, then the eval keys' windows read again, whether it answered or threw: its own cost. */
async function reported<T>(ended: () => Promise<T>): Promise<T> {
  try {
    return await ended();
  } finally {
    await keysWindows((line) => { console.log(`${line} (after the run)`); }, { refuseSpent: false });
  }
}

/** Where a daily run's candidate runs. */
type DailyDeployment = 'production' | 'staging';

/** A daily run as its record names it (`EvalRun`): its suite, and where its candidate runs. */
interface DailyRun {
  readonly suite: EvalSuite;
  readonly deployment: DailyDeployment;
}

/** A daily run's suite and where its candidate runs (`--suite`, `--on`): the fast suite on production unless named. */
function dailyRun(values: { readonly suite?: string | undefined; readonly on?: string | undefined }): DailyRun {
  const suite = v.parse(v.picklist(EVAL_SUITES, `--suite is ${EVAL_SUITES.join(' or ')}`), values.suite ?? 'fast');
  const deployment = v.parse(v.picklist(['production', 'staging'], '--on is production or staging'), values.on ?? 'production');

  return { suite, deployment };
}

/** The calls a run makes at once (`--calls-at-once`), refused with any pair of flags that cannot run together. */
function checkedBudget(values: {
  readonly 'calls-at-once'?: string | undefined; readonly 'staging-only': boolean; readonly daily: boolean;
  readonly pass: boolean; readonly record: boolean; readonly post?: string | undefined;
  readonly suite?: string | undefined; readonly on?: string | undefined;
}): number {
  // A run on someone's own plan keeps to fewer calls at once than the eval key's ceiling, never more.
  const budget = values['calls-at-once'] === undefined ? MUSE_CALLS_AT_ONCE : Number(values['calls-at-once']);

  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MUSE_CALLS_AT_ONCE) {
    throw new Error(`--calls-at-once is a whole number from 1 to ${String(MUSE_CALLS_AT_ONCE)}`);
  }

  // Staging alone measures the models a run names against each other on one build: no production leg, so no verdict.
  if (values['staging-only'] && (values.pass || values.record || values.post !== undefined)) {
    throw new Error('--staging-only measures models, never a build\'s verdict: drop --pass, --record and --post');
  }

  // The daily run measures the build production serves; its verdict is `promote.ts daily`'s, against the day before's.
  if (values.daily && (values.pass || values['staging-only'] || values.record || values.post !== undefined)) {
    throw new Error('--daily is a suite\'s full matrix on one deployment, recorded by `promote.ts daily`: drop --pass, --staging-only, --record and --post');
  }

  if (!values.daily && (values.suite !== undefined || values.on !== undefined)) throw new Error('--suite and --on name a daily run\'s: add --daily');

  return budget;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    tasks: { type: 'string' }, trials: { type: 'string' }, out: { type: 'string' }, post: { type: 'string' },
    pass: { type: 'boolean', default: false }, record: { type: 'boolean', default: false },
    'staging-only': { type: 'boolean', default: false },
    'calls-at-once': { type: 'string' },
    sequence: { type: 'boolean', default: false },
    settle: { type: 'string' },
    daily: { type: 'boolean', default: false },
    suite: { type: 'string' },
    on: { type: 'string' },
  } });

  const budget = checkedBudget(values);

  // Resolved before hours of trials, in this caller's environment: the network scope the posting runs in need not find it.
  const gh = values.post === undefined ? null : resolveGh();

  if (values.post !== undefined && gh === null) {
    console.error('evals: --post posts through gh, which is not on PATH and GH names none: this run\'s comments will not be posted, and its verdict is unaffected');
  }

  const clean = gitIn(ROOT, 'status', '--porcelain') === '';

  // `--settle=<out>/evals`: a finished run's report, recorded and posted again with no new trials, as when its posting
  // failed. Recording reads this checkout's HEAD and its comparison code (`promote.ts evals`), so it runs committed, at
  // the run's own commit; posting alone runs anywhere. A run from before `--settle` records with
  // `bun scripts/promote.ts evals <out>/evals`.
  if (values.settle !== undefined) {
    if (values.record && !clean) throw new Error('a recorded verdict is the commit\'s own: commit the tree first');
    const { unposted } = await settleEvalRun({ dir: resolve(values.settle), record: values.record, post: values.post, gh });

    return unposted.length === 0 ? 0 : 1;
  }

  const sha = gitIn(ROOT, 'rev-parse', 'HEAD');

  if (!clean) throw new Error('armada measures a committed checkout: commit the tree first');
  const gated = values.daily ? dailyRun(values) : null;
  const { origins, candidateBuild, baselineBuild } = await legsOf(values.pass, values['staging-only'], gated?.deployment ?? null, positionals[0]);

  const matrix = evalMatrix({
    ...process.env, KINU_EVAL_TRIALS: values.pass ? '1' : values.trials ?? process.env['KINU_EVAL_TRIALS'], KINU_EVAL_SEQUENCE: values.sequence ? '1' : '0',
  }, ARMS.map((arm) => arm.id));

  const allTasks = trackedFiles().filter(isEvalTask).sort();

  // A daily run and a deploy's soak run their suite's tasks; the soak, the fast ones (scripts/evals-suites.ts).
  const suite = gated?.suite ?? (values.pass ? 'fast' : null);
  const taskFiles = evalTaskFiles(suite === null ? allTasks : suiteTasks(suite, allTasks), values.tasks);

  const out = resolve(values.out ?? process.env['BENCH_ARTIFACTS'] ?? join(ROOT, 'bench-artifacts', 'evals-armada', `${String(Date.now())}-${sha.slice(0, 12)}`));

  mkdirSync(out, { recursive: true });
  const startedAt = Date.now();

  const run: EvalRun = {
    definitions: sha, candidateBuild, baselineBuild, taskFiles, models: [...matrix.models], arms: [...matrix.arms],
    trials: matrix.trials, startedAt, jobs: [], budget, pass: values.pass, ...gated !== null && { daily: true, ...gated },
  };

  // What the run cost the eval keys, read against the windows it started with, however its trials end.
  const { postExit, job } = await reported(async () => {
    // Kept as soon as armada names the job, so a run cut short still says which job holds its trials.
    const map = await leasedMap({ sha, out, origins, matrix, taskFiles, slots: allTasks.length, pass: values.pass, budget }, (named) => {
      run.jobs = [named];
      writeFileSync(join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    });

    run.jobs = [map.job];
    writeFileSync(join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    writeFileSync(join(out, 'trial-job.json'), `${JSON.stringify({ job: map.job, outcomes: map.outcomes }, null, 2)}\n`);

    if (map.outcomes.some((outcome) => outcome.kind === 'cancelled')) return { postExit: 130, job: map.job };

    return { postExit: await processEvals(run, map.items, map.outcomes, join(out, 'evals')), job: map.job };
  });

  if (postExit === 130) return postExit;
  run.wallSeconds = (Date.now() - startedAt) / 1000;
  writeFileSync(join(out, 'evals', 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`report: ${join(out, 'evals')}; wall ${run.wallSeconds.toFixed(1)}s, armada job ${job}`);

  // The verdict's own exit: a comment not posted is reported there, never this run's failure.
  await settleEvalRun({ dir: join(out, 'evals'), record: values.record, post: values.post, gh });

  return postExit;
}

if (import.meta.main) process.exitCode = await main();
