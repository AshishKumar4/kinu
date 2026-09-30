// Every eval task against one deployment at once, a task's stored result reused while nothing it
// measures has changed, and the whole compared with the latest complete report of an earlier build
// of this line of history:
//   bun evals/scripts/gate.ts [--digest <artifact digest>] [--gate]
//
// A task's result is keyed by what it measures: the build the deployment serves (the digest of its
// Worker and client when the caller computed one, else its build sha), the deployment's origin, the
// eval definitions (the `evals/` tree at HEAD), the task file, and the matrix (models, arms, trials).
// A key with a stored result runs nothing. Every other task runs in its own process, all at once,
// every trial of it at once. A task's report is stored only when it is complete and free of
// infrastructure failures, and the joined report becomes a baseline only when it can be one
// (`validateEvalResults`: every task, trials 1 to N once each, one build, one eval commit, no
// infrastructure failure). With `--gate`, a regressed cohort or a report that cannot be a baseline
// exits 1; without it the verdict is printed and the exit is 0.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';
import { compareEvalResults, renderEvalComparison, validateEvalResults } from '../src/comparison';
import { DEFINITION_PATHS, EXERCISED_PATHS, evalCommit, evalMatrix } from '../src/config';
import { ARMS, deployedBuild, resolveEvalTarget } from '../src/target';
import { diffBetween, ensureCommit, git } from './git';

const USAGE = 'Usage: bun evals/scripts/gate.ts [--digest <artifact digest>] [--gate]';

const REPO = join(import.meta.dirname, '../..');

/** Stored task results and baselines, per machine: the runner that ran them is the one that reuses them. */
const STORE = join(homedir(), '.cache', 'kinu-evals');

const ReportFilesSchema = v.looseObject({ testResults: v.array(v.looseObject({ name: v.string() })) });

const StampedSchema = v.looseObject({ testResults: v.array(v.looseObject({
  assertionResults: v.array(v.looseObject({ meta: v.looseObject({ harness: v.looseObject({ run: v.looseObject({
    session: v.looseObject({ metadata: v.looseObject({ productSha: v.string(), evalCommit: v.string() }) }),
  }) }) }) })),
})) });

/** What one task's result depends on. Any change to one of them is a new key, and the task runs again. */
export interface TaskKey {
  /** The served build: its artifact digest, or its build sha. */
  readonly build: string;
  /** The Worker version serving it: a redeploy of the same build with other config or another served model is a
   *  new version. */
  readonly version: string | null;
  readonly origin: string;
  /** The `evals/` tree at HEAD. */
  readonly definitions: string;
  readonly task: string;
  readonly models: readonly string[];
  readonly arms: readonly string[];
  readonly trials: number;
}

export function taskKey(key: TaskKey): string {
  return createHash('sha256').update(JSON.stringify(key)).digest('hex');
}

/** The newest stored baseline of a strict ancestor of `candidate`; `stored` is newest first. */
export function baselineOf(candidate: string, stored: readonly string[], isAncestor: (sha: string) => boolean): string | undefined {
  return stored.find((sha) => sha !== candidate && isAncestor(sha));
}

/**
 * A reused task report, stamped with this run's build and eval commit. Its key matched, so it measured the same
 * build and the same definitions; a joined report holds one build and one commit, so it says this run's.
 */
export function restamp(report: string, side: { productSha: string; evalCommit: string }): string {
  const stamped = v.parse(StampedSchema, JSON.parse(report));

  for (const file of stamped.testResults) {
    for (const assertion of file.assertionResults) Object.assign(assertion.meta.harness.run.session.metadata, side);
  }

  return JSON.stringify(stamped);
}

/** Each task's report joined into one, each task once: a task missing or twice over is refused, not read as removed. */
export function joinReports(tasks: readonly string[], reports: ReadonlyMap<string, string>): string {
  const files = tasks.flatMap((task) => {
    const report = reports.get(task);

    if (report === undefined) throw new Error(`no report for ${task}`);

    return v.parse(ReportFilesSchema, JSON.parse(report)).testResults;
  });

  const named = files.map((file) => basename(file.name)).sort();

  if (named.join('\n') !== [...tasks].sort().join('\n')) throw new Error(`the joined report holds ${named.join(', ')}, not ${tasks.join(', ')}`);

  return `${JSON.stringify({ testResults: files })}\n`;
}

/** Why `report` cannot stand for its tasks, or null when it can. */
function unfit(report: string, trials: number): string | null {
  try {
    validateEvalResults(report, trials);

    return null;
  } catch (error) {
    return renderThrownChain({ cause: error });
  }
}

function definitionsTree(): string {
  const tree = git(['rev-parse', 'HEAD:evals']);

  if (tree.status !== 0) throw new Error('git rev-parse HEAD:evals failed');

  return tree.stdout.trim();
}

/** Stored baselines at this trial count, newest first. */
function storedBaselines(trials: number): string[] {
  const dir = join(STORE, 'baselines');
  const suffix = `-${String(trials)}.json`;

  if (!existsSync(dir)) return [];

  return readdirSync(dir).filter((name) => name.endsWith(suffix))
    .map((name) => ({ sha: name.slice(0, -suffix.length), at: statSync(join(dir, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at)
    .map((entry) => entry.sha);
}

async function runTask(task: string, out: string, env: Readonly<Record<string, string>>): Promise<void> {
  await Bun.spawn([
    'bun', '--bun', './node_modules/.bin/vitest', 'run', '--config', 'evals/vitest.config.ts', join('evals/tasks', task),
    '--reporter=vitest-evals/reporter', '--reporter=json', `--outputFile.json=${out}`,
  ], { cwd: REPO, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' }).exited;

  if (!existsSync(out)) throw new Error(`${task} wrote no report`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { digest: { type: 'string' }, gate: { type: 'boolean' } } });

  if (values.digest !== undefined && !/^[0-9a-f]{64}$/u.test(values.digest)) throw new Error(USAGE);

  const target = resolveEvalTarget(process.env);
  const matrix = evalMatrix(process.env, ARMS.map((arm) => arm.id));
  const commit = evalCommit(process.env);
  const { sha, versionId } = await deployedBuild(target);
  const definitions = definitionsTree();
  const tasks = readdirSync(join(REPO, 'evals/tasks')).filter((name) => name.endsWith('.eval.ts')).sort();
  const run = join(REPO, 'bench-artifacts', 'evals', sha);

  for (const dir of [join(STORE, 'tasks'), join(STORE, 'baselines'), run]) mkdirSync(dir, { recursive: true });

  const stored = (task: string) => join(STORE, 'tasks', `${taskKey({
    build: values.digest ?? sha, version: versionId, origin: target.origin, definitions, task,
    models: matrix.models, arms: matrix.arms, trials: matrix.trials,
  })}.json`);

  const reports = new Map<string, string>();

  for (const task of tasks) {
    if (existsSync(stored(task))) reports.set(task, restamp(readFileSync(stored(task), 'utf8'), { productSha: sha, evalCommit: commit }));
  }

  const pending = tasks.filter((task) => !reports.has(task));

  process.stdout.write(`evals: ${target.origin} serves ${sha}; ${String(reports.size)} of ${String(tasks.length)} tasks reused, `
    + `${String(pending.length)} run now, ${String(matrix.trials)} trials each, all at once\n`);

  const env = { KINU_EVAL_TRIALS: String(matrix.trials), KINU_EVAL_COMMIT: commit, BENCH_ARTIFACTS: run };

  await Promise.all(pending.map(async (task) => {
    const out = join(run, task.replace(/\.eval\.ts$/u, '.json'));

    await runTask(task, out, env);
    const report = readFileSync(out, 'utf8');
    const problem = unfit(report, matrix.trials);

    reports.set(task, report);

    if (problem === null) writeFileSync(stored(task), report);
    else process.stdout.write(`evals: ${task} is not stored for reuse: ${problem}\n`);
  }));

  const joined = joinReports(tasks, reports);
  const problem = unfit(joined, matrix.trials);

  writeFileSync(join(run, 'results.json'), joined);

  if (problem === null) writeFileSync(join(STORE, 'baselines', `${sha}-${String(matrix.trials)}.json`), joined);
  else process.stdout.write(`evals: this report cannot be a baseline: ${problem}\n`);

  const baseline = baselineOf(sha, storedBaselines(matrix.trials), (candidate) => {
    ensureCommit(candidate);

    return git(['merge-base', '--is-ancestor', candidate, sha]).status === 0;
  });

  const comparison = compareEvalResults(
    baseline === undefined ? null : readFileSync(join(STORE, 'baselines', `${baseline}-${String(matrix.trials)}.json`), 'utf8'),
    joined,
    {
      definitionsChanged: (from, to) => git(['diff', '--quiet', from, to, '--', ...DEFINITION_PATHS]).status === 1,
      changedFiles: (from, to) => diffBetween(from, to, { paths: EXERCISED_PATHS, names: true }).split('\n').filter((line) => line !== ''),
    },
  );

  writeFileSync(join(run, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  writeFileSync(join(run, 'comparison.md'), `${renderEvalComparison(comparison)}\n`);
  process.stdout.write(`${renderEvalComparison(comparison)}\nevals: ${comparison.verdict} against ${baseline ?? 'no baseline'}; ${run}\n`);

  return values.gate === true && (comparison.verdict === 'regressed' || problem !== null) ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
