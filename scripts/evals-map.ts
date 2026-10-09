#!/usr/bin/env bun
// Opt-in evaluations: native armada CLI map tasks and its artifact extractor; light post-steps read those outputs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { EVAL_MAP_POOL, EVAL_TASK_TIMEOUT_SECONDS, evalMatrix, type EvalMatrix } from '../evals/src/config';
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

/** Only armada's supported CLI: its one shared pool, commit checkout and per-task artifact extraction. */
export function evalMapArgv(sha: string, out: string, identities: readonly string[]): string[] {
  return [join(ROOT, 'node_modules', '.bin', 'armada'), 'map',
    `--connection=${join(homedir(), '.config', 'armada', 'armada-kinu.json')}`, `--commit=${sha}`,
    '--items=-', `--pool=${String(EVAL_MAP_POOL)}`, `--timeout=${String(EVAL_TASK_TIMEOUT_SECONDS)}`,
    `--artifacts=${join(out, 'trials')}`, `--secrets=${identities.join(',')}`, '--json',
    `--label=evals ${sha.slice(0, 12)}`, '--', 'bun', 'evals/scripts/trial.ts'];
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
  const selected = values.tasks?.split(',') ?? allTasks.map((file) => file.slice('evals/tasks/'.length).replace(/\.eval\.ts$/u, ''));
  const taskFiles = selected.map((task) => `evals/tasks/${task}.eval.ts`);

  if (taskFiles.length === 0 || taskFiles.some((file) => !allTasks.includes(file)) || new Set(taskFiles).size !== taskFiles.length) {
    throw new Error(`--tasks must name distinct tasks from ${allTasks.join(', ')}`);
  }

  const items = evalItems(taskFiles, matrix, origins, values.pass);
  const out = resolve(values.out ?? process.env['BENCH_ARTIFACTS'] ?? join(ROOT, 'bench-artifacts', 'evals-armada', `${String(Date.now())}-${sha.slice(0, 12)}`));

  mkdirSync(out, { recursive: true });
  const startedAt = Date.now();

  console.log(`evals: ${String(items.length)} trials, one shared pool of ${String(EVAL_MAP_POOL)}, native artifacts in ${join(out, 'trials')}`);

  const identities = [...new Set(origins.map(({ origin }) => evalWebIdentityEnv(origin)))];

  const mapped = await mapTrials(evalMapArgv(sha, out, identities), items);

  const run: EvalRun = {
    definitions: sha, candidateBuild, baselineBuild, taskFiles, models: [...matrix.models], arms: [...matrix.arms],
    trials: matrix.trials, startedAt, job: mapped.job, pool: EVAL_MAP_POOL, pass: values.pass,
  };

  writeFileSync(join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(out, 'trial-job.json'), `${JSON.stringify(mapped, null, 2)}\n`);

  if (mapped.outcomes.some((outcome) => outcome.kind === 'cancelled')) return 130;

  const postExit = await processEvals(run, items, mapped.outcomes, join(out, 'evals'));

  run.wallSeconds = (Date.now() - startedAt) / 1000;
  writeFileSync(join(out, 'evals', 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`report: ${join(out, 'evals')}; wall ${run.wallSeconds.toFixed(1)}s, pool ${String(EVAL_MAP_POOL)}, armada job ${mapped.job}`);

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
