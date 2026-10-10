#!/usr/bin/env bun
// Opt-in evaluations: native armada CLI map tasks and its artifact extractor; light post-steps read those outputs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { EVAL_WIDTH_POOLS, EVAL_TASK_TIMEOUT_SECONDS, MUSE_CALLS_AT_ONCE, evalMatrix, type EvalMatrix } from '../evals/src/config';
import { collectEvalTasks } from '../evals/src/eval';
import type { EvalCallWidth, EvalTask } from '../evals/src/task';
import { ARMS } from '../evals/src/target';
import { evalTargetVerdict, evalWebIdentityEnv } from '../packages/test-utils/src/eval-identity';
import { gitEnv } from '../packages/test-utils/src/git-env';
import { MapResultSchema, type EvalRun, type MapResult, type TrialItem } from './evals-artifacts';
import { LOCAL_CHECK, processEvals } from './evals-post';
import { isEvalTask, trackedFiles } from './sources';

const ROOT = join(import.meta.dirname, '..');

const HEALTH = v.object({ build: v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/u)) }) });

/** Keep each cell's whole matrix for trialSlot: selection does not renumber its account. */
export function evalItems(taskFiles: readonly string[], matrix: EvalMatrix, origins: readonly { leg: 'candidate' | 'baseline'; origin: string }[], pass: boolean): TrialItem[] {
  const models = [...matrix.models];
  const arms = [...matrix.arms];

  return taskFiles.flatMap((file) => {
    const task = file.slice('evals/tasks/'.length).replace(/\.eval\.ts$/u, '');

    return models.flatMap((model) => arms.flatMap((arm) =>
      Array.from({ length: matrix.trials }, (_, index) => origins.map(({ leg, origin }) => ({
        leg, origin, task, model, arm, trial: index + 1, trials: matrix.trials, models, arms, pass,
      }))).flat()));
  });
}

export interface EvalWidthQueue {
  readonly calls: EvalCallWidth;
  readonly pool: number;
  readonly cells: readonly { readonly index: number; readonly item: TrialItem }[];
}

/** Equal-width native queues reserve actual task peaks under one shared provider ceiling, across both legs. */
export function evalWidthQueues(items: readonly TrialItem[], tasks: readonly EvalTask[]): EvalWidthQueue[] {
  const definitions = new Map(tasks.map((task) => [task.id, task]));
  const widths = new Map<EvalCallWidth, { index: number; item: TrialItem }[]>();

  for (const [index, item] of items.entries()) {
    const peak = definitions.get(item.task)?.modelCallPeak;

    if (peak === undefined || peak.source.trim() === '' || !Object.hasOwn(EVAL_WIDTH_POOLS, peak.calls)) {
      throw new Error(`${item.task} names no supported measured model-call peak with a source`);
    }

    const cells = widths.get(peak.calls) ?? [];

    cells.push({ index, item });
    widths.set(peak.calls, cells);
  }

  const queues = [...widths.entries()].sort(([a], [b]) => a - b).map(([calls, cells]) => {
    const capacity = EVAL_WIDTH_POOLS[calls];

    return { calls, pool: Math.min(capacity, cells.length), cells };
  });

  const reserved = queues.reduce((total, queue) => total + queue.calls * queue.pool, 0);

  if (reserved > MUSE_CALLS_AT_ONCE) throw new Error(`native width queues reserve ${String(reserved)} calls, past ${String(MUSE_CALLS_AT_ONCE)}`);

  return queues;
}

/** Only armada's supported CLI: a native uniform-width pool, commit checkout and per-task artifact extraction. */
export function evalMapArgv(sha: string, out: string, identities: readonly string[], queue: Pick<EvalWidthQueue, 'calls' | 'pool'>): string[] {
  return [join(ROOT, 'node_modules', '.bin', 'armada'), 'map',
    `--connection=${join(homedir(), '.config', 'armada', 'armada-kinu.json')}`, `--commit=${sha}`,
    '--items=-', `--pool=${String(queue.pool)}`, `--timeout=${String(EVAL_TASK_TIMEOUT_SECONDS)}`,
    `--artifacts=${join(out, 'trials')}`, `--secrets=${identities.join(',')}`, '--json',
    `--label=evals ${sha.slice(0, 12)} width ${String(queue.calls)}`, '--', 'bun', 'evals/scripts/trial.ts'];
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

/** Decode the native JSON-lines contract while draining progress concurrently, without a pipe deadlock. */
async function mapTrials(argv: string[], items: readonly TrialItem[]) {
  const env = { ...process.env };

  delete env['ARMADA_URL'];
  delete env['ARMADA_TOKEN'];

  const child = Bun.spawn(argv, { cwd: ROOT, env, stdin: new Blob([JSON.stringify(items)]), stdout: 'pipe', stderr: 'pipe' });

  const outcomes: MapResult[] = [];
  let progress = '';
  let pending = '';
  const decode = new TextDecoder();

  const interrupt = (): void => { child.kill('SIGINT'); };

  const terminate = (): void => { child.kill('SIGTERM'); };

  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);

  try {
    await Promise.all([
      (async () => {
        for await (const bytes of child.stderr) {
          const text = new TextDecoder().decode(bytes);

          progress += text;
          process.stderr.write(text);
        }
      })(),
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
              console.log(`${item.leg} ${item.task} trial ${String(item.trial)}: ${outcome.kind}, ${outcome.seconds.toFixed(1)}s`);
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
  const job = /^job (\S+)$/mu.exec(progress)?.[1];

  if (job === undefined) throw new Error(`armada map exited ${String(exitCode)} without naming its job: ${progress}`);

  return { job, outcomes, exitCode };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    tasks: { type: 'string' }, trials: { type: 'string' }, out: { type: 'string' }, post: { type: 'string' },
    pass: { type: 'boolean', default: false }, record: { type: 'boolean', default: false },
  } });

  const definitions = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT, env: gitEnv(), stdout: 'pipe', stderr: 'pipe' });

  if (definitions.exitCode !== 0) throw new Error(`reading the definitions commit: ${definitions.stderr.toString()}`);
  const sha = definitions.stdout.toString().trim();

  const dirty = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: ROOT, env: gitEnv(), stdout: 'pipe' });

  if (dirty.stdout.toString().trim() !== '') throw new Error('armada measures a committed checkout: commit the tree first');
  const candidateOrigin = values.pass ? process.env['KINU_EVAL_ORIGIN'] : 'https://staging.kinu.run';
  const target = evalTargetVerdict(candidateOrigin);

  if (target.kind === 'refused' || target.why !== 'deployment') throw new Error('evals-map names a real Kinu deployment through KINU_EVAL_ORIGIN');

  const origins: { leg: 'candidate' | 'baseline'; origin: string }[] = [{ leg: 'candidate', origin: target.origin }];

  if (!values.pass) origins.push({ leg: 'baseline', origin: 'https://kinu.run' });

  const builds = await Promise.all(origins.map(async ({ origin }) => {
    const response = await fetch(`${origin}/api/health`);

    if (!response.ok) throw new Error(`${origin}/api/health answered ${String(response.status)}`);

    return v.parse(HEALTH, await response.json()).build.sha;
  }));

  const candidateBuild = builds[0] ?? '';
  const baselineBuild = builds[1] ?? '';
  const asked = positionals[0];

  if (asked !== undefined && !candidateBuild.startsWith(asked) && !asked.startsWith(candidateBuild)) {
    throw new Error(`${target.origin} serves ${candidateBuild}, not the requested ${asked}`);
  }

  const matrix = evalMatrix({ ...process.env, KINU_EVAL_TRIALS: values.pass ? '1' : values.trials ?? process.env['KINU_EVAL_TRIALS'] }, ARMS.map((arm) => arm.id));
  const allTasks = trackedFiles().filter(isEvalTask).sort();

  const taskFiles = evalTaskFiles(allTasks, values.tasks);

  const items = evalItems(taskFiles, matrix, origins, values.pass);
  const queues = evalWidthQueues(items, await collectEvalTasks());

  // Standalone runs need the same actual credentials/catalog as deploy --evals. Only the operator's
  // provisioning step reads the existing key file; trial containers receive identities, never Muse keys.
  for (const { origin } of origins) {
    const provision = Bun.spawn([LOCAL_CHECK, process.execPath, 'scripts/eval-provider-keys.ts', origin], {
      cwd: ROOT, env: { ...process.env, LOCAL_CHECK_MEMORY: '4G', KINU_EVAL_MODELS: matrix.models.join(',') },
      stdout: 'inherit', stderr: 'inherit',
    });

    if (await provision.exited !== 0) throw new Error(`actual eval keys/catalog were not provisioned at ${origin}; no trials started`);
  }

  const out = resolve(values.out ?? process.env['BENCH_ARTIFACTS'] ?? join(ROOT, 'bench-artifacts', 'evals-armada', `${String(Date.now())}-${sha.slice(0, 12)}`));

  mkdirSync(out, { recursive: true });
  const startedAt = Date.now();

  const pool = queues.reduce((total, queue) => total + queue.pool, 0);
  const reserved = queues.reduce((total, queue) => total + queue.pool * queue.calls, 0);

  console.log(`evals: ${String(items.length)} trials, ${String(pool)} simultaneous across ${String(queues.length)} native width queues, ${String(reserved)}/${String(MUSE_CALLS_AT_ONCE)} calls reserved`);

  const identities = [...new Set(origins.map(({ origin }) => evalWebIdentityEnv(origin)))];

  const mapped = await Promise.all(queues.map(async (queue) => ({ queue,
    ...(await mapTrials(evalMapArgv(sha, join(out, `width-${String(queue.calls)}`), identities, queue), queue.cells.map(({ item }) => item))),
  })));

  const outcomes = mapped.flatMap(({ queue, outcomes: local }) => local.map((outcome) => {
    const cell = queue.cells[outcome.index];

    if (cell === undefined) throw new Error(`native width ${String(queue.calls)} returned unknown index ${String(outcome.index)}`);

    return { ...outcome, index: cell.index };
  }));

  const run: EvalRun = {
    definitions: sha, candidateBuild, baselineBuild, taskFiles, models: [...matrix.models], arms: [...matrix.arms],
    trials: matrix.trials, startedAt, jobs: mapped.map(({ job }) => job), pool, pass: values.pass,
    queues: mapped.map(({ job, queue }) => ({ job, calls: queue.calls, pool: queue.pool, tasks: [...new Set(queue.cells.map(({ item }) => item.task))] })),
  };

  writeFileSync(join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(out, 'trial-job.json'), `${JSON.stringify(mapped, null, 2)}\n`);

  if (outcomes.some((outcome) => outcome.kind === 'cancelled')) return 130;

  const postExit = await processEvals(run, items, outcomes, join(out, 'evals'));

  run.wallSeconds = (Date.now() - startedAt) / 1000;
  writeFileSync(join(out, 'evals', 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`report: ${join(out, 'evals')}; wall ${run.wallSeconds.toFixed(1)}s, ${String(pool)} simultaneous, armada jobs ${run.jobs.join(', ')}`);

  if (values.record) {
    const recorded = Bun.spawn([LOCAL_CHECK, process.execPath, 'scripts/promote.ts', 'evals', join(out, 'evals')],
      { cwd: ROOT, env: { ...process.env, LOCAL_CHECK_MEMORY: '4G' }, stdout: 'inherit', stderr: 'inherit' });

    if (await recorded.exited !== 0) throw new Error('recording this eval verdict failed');
  }

  if (values.post !== undefined) {
    for (const [name, marker] of [['comparison', '<!-- kinu-evals-results -->'], ['why', '<!-- kinu-evals-why -->']] as const) {
      const posted = Bun.spawn([LOCAL_CHECK, 'bash', 'evals/scripts/post-comment.sh', values.post, join(out, 'evals', name, 'comment.md'), marker],
        { cwd: ROOT, env: { ...process.env, LOCAL_CHECK_MEMORY: '4G' }, stdout: 'inherit', stderr: 'inherit' });

      if (await posted.exited !== 0) throw new Error(`posting the ${name} comment failed`);
    }
  }

  return postExit;
}

if (import.meta.main) process.exitCode = await main();
