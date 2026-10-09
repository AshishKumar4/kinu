#!/usr/bin/env bun
// Opt-in evaluations: one native armada map task per trial, followed by one artifact-reading post task.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { connect, type Json } from 'armada';
import { argvOf, cancelOnInterrupt, extractTar, onCommit } from 'armada/ci';
import { commandTask } from 'armada/task';
import { EVAL_MAP_POOL, EVAL_TASK_TIMEOUT_SECONDS, evalMatrix, type EvalMatrix } from '../evals/src/config';
import { ARMS } from '../evals/src/target';
import { evalTargetVerdict, evalWebIdentityEnv } from '../packages/test-utils/src/eval-identity';
import { gitEnv } from '../packages/test-utils/src/git-env';
import { readEvalRun, type EvalRun, type TrialItem } from './evals-artifacts';
import { isEvalTask, trackedFiles } from './sources';

const ROOT = join(import.meta.dirname, '..');

const HEALTH = v.object({ build: v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/u)) }) });

/** Keep each cell's whole matrix for trialSlot: selection does not renumber its account. */
export function evalItems(taskFiles: readonly string[], matrix: EvalMatrix, origins: readonly { leg: 'candidate' | 'baseline'; origin: string }[], pass: boolean): TrialItem[] {
  return taskFiles.flatMap((file) => matrix.models.flatMap((model) => matrix.arms.flatMap((arm) =>
    Array.from({ length: matrix.trials }, (_, index) => origins.map(({ leg, origin }) => ({
      leg, origin, task: file.slice('evals/tasks/'.length).replace(/\.eval\.ts$/u, ''),
      model, arm, trial: index + 1, trials: matrix.trials, models: [...matrix.models], arms: [...matrix.arms], pass,
    }))).flat())));
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
  const out = resolve(values.out ?? join(ROOT, 'bench-artifacts', 'evals-armada', `${String(Date.now())}-${sha.slice(0, 12)}`));

  mkdirSync(out, { recursive: true });
  // This deployment is explicit for the CLI and SDK. Never use another connection or print its bearer.
  process.env['ARMADA_CONNECTION'] = join(homedir(), '.config', 'armada', 'armada-kinu.json');

  const armada = connect();
  const began = Date.now();
  const spec = await onCommit(armada, sha);
  const names = [...new Set(origins.map(({ origin }) => evalWebIdentityEnv(origin)))];

  const map = commandTask<Json>(spec.recipe, argvOf(['bun', 'evals/scripts/trial.ts'], spec.recipe),
    { timeout: EVAL_TASK_TIMEOUT_SECONDS, secrets: names }).stream(items, {
    armada, pool: EVAL_MAP_POOL, label: `evals ${candidateBuild} definitions ${sha.slice(0, 12)}`,
    env: spec.env, tmpfs: spec.tmpfs,
  });

  const job = await map.id;

  const run: EvalRun = {
    definitions: sha, candidateBuild, baselineBuild, taskFiles, models: [...matrix.models], arms: [...matrix.arms],
    trials: matrix.trials, startedAt: began, job, pool: EVAL_MAP_POOL, pass: values.pass,
  };

  writeFileSync(join(out, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`evals job ${job}: ${String(items.length)} trials, pool ${String(EVAL_MAP_POOL)}, artifacts in ${out}`);

  const outcomes: { index: number; kind: string; exitCode: number; tail: string }[] = [];

  await cancelOnInterrupt(map, job, async () => {
    for await (const result of map) {
      outcomes.push({ index: result.index, kind: result.kind, exitCode: result.meta.exitCode, tail: result.meta.tail });
      const item = items[result.index];

      console.log(`${item?.leg ?? ''} ${item?.task ?? ''} trial ${String(item?.trial ?? '')}: ${result.kind}, ${result.meta.seconds.toFixed(1)}s`);
    }
  });

  const summary = await map.summary();

  writeFileSync(join(out, 'trial-job.json'), `${JSON.stringify({ job, summary, outcomes }, null, 2)}\n`);

  // Native deployToken supplies the masked bearer in the post task's environment, never a new secret file.
  // The same commit recipe and native map/extractTar implementation serve trials and post artifacts.
  const postJob = await armada.create({
    recipe: spec.recipe, commit: spec.recipe.commit, run: { kind: 'command' },
    items: [{ item: { run, items, outcomes }, argv: ['bun', 'scripts/evals-post.ts'] }],
    timeout: EVAL_TASK_TIMEOUT_SECONDS, pool: 1, deployToken: true,
    env: { ...spec.env, ARMADA_URL: armada.connection.url }, tmpfs: [...spec.tmpfs],
    secrets: values.pass ? [] : ['KINU_EVAL_STAGING_WEB_IDENTITY', 'KINU_OBS_TOKEN'],
    label: `evals comparison and Sol ${job}`,
  });

  const post = commandTask<Json>(spec.recipe, () => ['bun', 'scripts/evals-post.ts']).job(postJob, { armada });
  let postExit = 2;

  await cancelOnInterrupt(post, postJob, async () => {
    for await (const result of post) {
      const archive = await post.artifacts(result.index);

      if (archive !== null) extractTar(archive, out);
      postExit = result.meta.exitCode;
      console.log(`evals post job ${postJob}: ${result.kind}, ${result.meta.seconds.toFixed(1)}s`);

      if (!result.ok) console.error(result.meta.tail);
    }
  });

  const finished = readEvalRun(join(out, 'evals', 'run.json'));

  finished.postJob = postJob;
  finished.wallSeconds = (Date.now() - began) / 1000;
  writeFileSync(join(out, 'evals', 'run.json'), `${JSON.stringify(finished, null, 2)}\n`);
  console.log(`report: ${join(out, 'evals')}; wall ${finished.wallSeconds.toFixed(1)}s, pool ${String(EVAL_MAP_POOL)}`);

  if (values.record) {
    const recorded = Bun.spawn([process.execPath, 'scripts/promote.ts', 'evals', join(out, 'evals')], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });

    if (await recorded.exited !== 0) throw new Error('recording this eval verdict failed');
  }

  if (values.post !== undefined) {
    for (const [name, marker] of [['comparison', '<!-- kinu-evals-results -->'], ['why', '<!-- kinu-evals-why -->']] as const) {
      const posted = Bun.spawn(['bash', 'evals/scripts/post-comment.sh', values.post, join(out, 'evals', name, 'comment.md'), marker],
        { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });

      if (await posted.exited !== 0) throw new Error(`posting the ${name} comment failed`);
    }
  }

  return postExit;
}

if (import.meta.main) process.exitCode = await main();
