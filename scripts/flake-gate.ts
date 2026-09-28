#!/usr/bin/env bun
/**
 * THE FLAKE GATE. A test that passes and fails on one tree is a flake, and only running it more than once shows
 * one: every other row runs each suite once and reads its exit code.
 *
 * ITS SUBJECT IS THE COMMIT BEING MADE: every test file the index adds or changes against HEAD, and in a merge
 * against every parent, since a file the merge takes whole from a side was that side's commits'. Each runnable suite
 * runs REPEATS times, BROWSER_REPEATS for one that drives Chrome, the way the ladder row that claims it runs it
 * (`narrowedTo`: its runner and its flags, the file its only target). Suites run beside each other, a suite never
 * beside itself, and one browser and one workers pool at a time. One red run fails the commit, and the report says
 * which: red in every run is a failing test, red in some is a FLAKE, named with the tests and the runs that failed.
 * Outside a commit (at push, in CI, at a deploy) the index is HEAD and there is nothing to repeat.
 *
 * NEVER A RETRY, NEVER A QUARANTINE. A red run is the only evidence of a race or a leak, and a gate that retried
 * until green would trade it for a slower green. There is no list of known flakes: a flake is fixed at its root.
 * Every red run's whole output is kept under bench-artifacts/flake-gate/, since the interleaving that failed is only
 * there.
 *
 * A test file whose runner needs a deployment or a model (a first-run case, an eval task, a live suite whose every
 * test skips here) is named and not repeated: the tier that runs it is where it is measured.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';
import { tolerate } from '@kinu.run/core/obs';
import { stripGitContext } from '../packages/test-utils/src/git';
import { runUnderDeadline } from './deadline';
import { finding } from './gate-ratchet';
import { GATE_DEADLINE_SECONDS, LADDER, TIERS, claims, narrowedTo, sharedBrowserModules, tierRun, type Gate } from './ladder';
import { discoverArgv } from './python-suites';
import { parseJUnit } from './skip-ratchet';
import { parse, walk } from './syntax';
import { writtenSkips } from './test-census';
import { ANTI_SLOP_RULES, isAntiSlopRuleSuite, isFirstRunSuite, isParseable, isPythonSuite, isRunnableSuite, trackedFiles } from './sources';

const root = new URL('..', import.meta.url).pathname;

/** Runs of each changed suite: the hammer's six, the smallest count that has caught a 1-in-3 flake here. A floor on
 *  confidence, never a proof of absence, and the green path says so. */
export const REPEATS = 6;

/** Runs of a changed suite that drives Chrome. Each holds the box's one browser for as long as a UI row does. */
export const BROWSER_REPEATS = 3;

/** Suites that hold neither a browser nor a workers pool, repeated beside each other at once. */
const PLAIN_AT_ONCE = 4;

/** The aggregator every anti-slop rule suite runs through: it imports each one, and no command names them. */
const RULES_AGGREGATOR = `${ANTI_SLOP_RULES.slice(0, -1)}.test.ts`;

/** What a suite holds while it runs: the box's one browser, a workers pool or dev server, or neither. */
export type Lane = 'browser' | 'pool' | 'plain';

/** How one changed test file is measured here. */
export type Plan =
  | {
    readonly kind: 'repeat';
    readonly file: string;
    readonly argv: readonly string[];
    readonly runs: number;
    readonly lane: Lane;
    readonly row: Pick<Gate, 'label' | 'deadline'>;
  }
  | { readonly kind: 'elsewhere'; readonly file: string; readonly why: string }
  | { readonly kind: 'unrunnable'; readonly file: string; readonly why: string };

/** A repository, and the environment its `git` reads: in a hook, the index the commit takes and where it lives. */
export interface Repository {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

function git(repository: Repository, args: readonly string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd: repository.cwd, env: repository.env, stdout: 'pipe', stderr: 'pipe' });

  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${String(run.exitCode)}: ${run.stderr.toString().trim()}`);

  return run.stdout.toString();
}

/**
 * The test files the commit being made adds or changes: the index against HEAD. A merge's are those that differ
 * from every parent, as `git diff --cc` reads one: a resolution, or an edit made in the merge. In a hook `git`
 * reads the index the commit takes, including the temporary one `git commit -a` names in GIT_INDEX_FILE.
 */
export function stagedTestFiles(repository: Repository = { cwd: root, env: process.env }): string[] {
  const merging = resolve(repository.cwd, git(repository, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim());
  const heads = tolerate(() => readFileSync(merging, 'utf8'), 'enoent')?.split('\n').filter((head) => head !== '') ?? [];

  const [changed = new Set<string>(), ...others] = ['HEAD', ...heads]
    .map((parent) => new Set(git(repository, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', parent]).split('\0')));

  const moved = movedUnchanged(repository);

  return [...changed]
    .filter((file) => others.every((other) => other.has(file)) && !moved.has(file))
    .filter((file) => isRunnableSuite(file) || isPythonSuite(file) || isFirstRunSuite(file));
}

/** A module's text with every import specifier blanked, read from its syntax tree: what a move rewrites. Any other
 *  file (a Python suite) is compared whole. */
function withoutSpecifiers(file: string, text: string): string {
  if (!isParseable(file)) return text;
  const spans: { start: number; end: number }[] = [];

  walk(parse(file, text).root, (node) => {
    const { raw } = node;

    if (raw.type !== 'ImportDeclaration' && raw.type !== 'ExportAllDeclaration' && raw.type !== 'ImportExpression'
      && raw.type !== 'ExportNamedDeclaration') return;

    if (raw.source !== null && raw.source.type === 'Literal') spans.push({ start: raw.source.start, end: raw.source.end });
  });

  return spans.sort((a, b) => b.start - a.start).reduce((blanked, { start, end }) => `${blanked.slice(0, start)}''${blanked.slice(end)}`, text);
}

/**
 * Files the index renames from HEAD whose text equals the source's but for rewritten import specifiers: the same
 * tests, so their flakiness is the source's, already measured. Any other edit, one assertion included, repeats it.
 */
export function movedUnchanged(repository: Repository = { cwd: root, env: process.env }): ReadonlySet<string> {
  const fields = git(repository, ['diff', '--cached', '-M', '--name-status', '-z', '--diff-filter=R', 'HEAD']).split('\0');
  const moved = new Set<string>();

  for (let at = 0; at + 2 < fields.length; at += 3) {
    const from = fields[at + 1] ?? '';
    const to = fields[at + 2] ?? '';
    const before = git(repository, ['show', `HEAD:${from}`]);
    const after = git(repository, ['show', `:${to}`]);

    if (withoutSpecifiers(from, before) === withoutSpecifiers(to, after)) moved.add(to);
  }

  return moved;
}

/** Each row's `claims()` over one tracked list, worked out once: `planFor` asks it of every row for every file. */
const claimedBy = new WeakMap<readonly string[], Map<string, ReadonlySet<string>>>();

function claimsOf(run: string, tracked: readonly string[]): ReadonlySet<string> {
  const known = claimedBy.get(tracked) ?? new Map<string, ReadonlySet<string>>();

  claimedBy.set(tracked, known);
  const cached = known.get(run);

  if (cached !== undefined) return cached;
  const claimed = new Set(claims(run, tracked));

  known.set(run, claimed);

  return claimed;
}

/** How `file` is repeated: through the cheapest row that claims it, narrowed to the file alone. */
export function planFor(
  file: string,
  tracked: readonly string[],
  rows: readonly Pick<Gate, 'run' | 'label' | 'tier' | 'deadline'>[] = LADDER,
  browsers: ReadonlySet<string> = sharedBrowserModules(),
): Plan {
  if (isFirstRunSuite(file)) {
    return { kind: 'elsewhere', file, why: 'a first-run case drives the deployment a deploy publishes, and runs in its post-publish tier' };
  }

  const subject = isAntiSlopRuleSuite(file) ? RULES_AGGREGATOR : file;

  const [row] = rows.filter((candidate) => claimsOf(candidate.run, tracked).has(subject))
    .sort((left, right) => TIERS.indexOf(left.tier) - TIERS.indexOf(right.tier));

  if (row === undefined) return { kind: 'unrunnable', file, why: 'no ladder row claims it, so nothing runs it' };

  if (row.tier === 'evals') return { kind: 'elsewhere', file, why: `its only runner, "${row.label}", spends a model or a credential` };
  const argv = narrowedTo(row.run, subject, tracked);

  if (argv === undefined) return { kind: 'unrunnable', file, why: `\`${row.run}\` does not narrow to ${subject} alone` };

  if (browsers.has(subject)) return { kind: 'repeat', file, argv, runs: BROWSER_REPEATS, lane: 'browser', row };

  const pool = argv.includes('vitest') || argv.some((word) => word.endsWith('with-dev-server.ts'));

  return { kind: 'repeat', file, argv, runs: REPEATS, lane: pool ? 'pool' : 'plain', row };
}

/** A command, and whether it writes a JUnit report: `bun test` and `vitest run` do; the others answer by exit code. */
export interface Reported {
  readonly argv: string[];
  readonly junit: boolean;
}

/** `argv` writing a JUnit report to `report`, for the two runners that write one. */
export function withJUnit(argv: readonly string[], report: string): Reported {
  const at = argv.findIndex((word, index) => (word === 'test' && argv[index - 1] === 'bun') || (word === 'run' && argv[index - 1] === 'vitest'));

  if (at === -1) return { argv: [...argv], junit: false };

  const flags = argv[at] === 'test'
    ? ['--reporter=junit', `--reporter-outfile=${report}`]
    : ['--reporter=default', '--reporter=junit', `--outputFile=${report}`];

  return { argv: [...argv.slice(0, at + 1), ...flags, ...argv.slice(at + 1)], junit: true };
}

/** One run of a suite. */
export interface RunOutcome {
  readonly run: number;
  readonly exitCode: number;
  readonly seconds: number;
  /** The run's JUnit report, where its runner writes one: every testcase, the failed ones by key, the skipped. */
  readonly report?: { readonly total: number; readonly failed: readonly string[]; readonly skipped: number };
  readonly output: string;
}

/** A red run: a non-zero exit, or a runner that reports tests and reported none, the silent zero. */
export const isRed = (outcome: RunOutcome): boolean => outcome.exitCode !== 0 || outcome.report?.total === 0;

/** What the runs of one suite say about it. */
export type Verdict =
  | { readonly kind: 'green' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'red'; readonly failing: readonly string[] }
  | { readonly kind: 'flaky'; readonly red: readonly number[]; readonly tests: ReadonlyMap<string, readonly number[]> };

export function verdictOf(outcomes: readonly RunOutcome[]): Verdict {
  const red = outcomes.filter(isRed).map((outcome) => outcome.run);
  const failedIn = new Map<string, number[]>();

  for (const outcome of outcomes) {
    for (const key of outcome.report?.failed ?? []) failedIn.set(key, [...(failedIn.get(key) ?? []), outcome.run]);
  }

  if (red.length === 0) {
    return outcomes.every((outcome) => outcome.report !== undefined && outcome.report.skipped === outcome.report.total)
      ? { kind: 'skipped' } : { kind: 'green' };
  }

  if (red.length === outcomes.length) {
    return { kind: 'red', failing: [...failedIn].filter(([, runs]) => runs.length === outcomes.length).map(([key]) => key) };
  }

  return { kind: 'flaky', red, tests: failedIn };
}

/** A runner of `size` jobs at once. */
function slots(size: number): <T>(work: () => Promise<T>) => Promise<T> {
  let free = size;
  const waiting: (() => void)[] = [];

  return async (work) => {
    if (free > 0) free -= 1;
    else await new Promise<void>((wake) => { waiting.push(wake); });

    try {
      return await work();
    } finally {
      const next = waiting.shift();

      if (next === undefined) free += 1;
      else next();
    }
  };
}

/** Bun's implicit spawn env is its startup snapshot (ADR L10), so the test must start without hook context too.
 *  The parent keeps that context: stagedTestFiles must still read the index the committing hook names. */
function testEnvironment() {
  const env: Record<string, string> = {};

  for (const name of Object.keys(process.env)) {
    const value = process.env[name];

    if (value !== undefined) env[name] = value;
  }

  stripGitContext(env);

  return env;
}

/** One run of a planned suite, under its row's deadline, with its JUnit report read where it writes one. */
async function runOnce(plan: Extract<Plan, { kind: 'repeat' }>, run: number, scratch: string): Promise<RunOutcome> {
  const report = join(scratch, `${plan.file.replaceAll('/', '_')}.${String(run)}.xml`);
  const { argv, junit } = withJUnit(plan.argv, report);
  // `vitest` is a package binary: a package script finds it on the PATH `bun run` gives it, and this spawn names it.
  const spawned = argv[0] === 'vitest' ? [join(root, 'node_modules', '.bin', 'vitest'), ...argv.slice(1)] : argv;

  const outcome = await runUnderDeadline({
    argv: spawned, cwd: root, seconds: plan.row.deadline?.seconds ?? GATE_DEADLINE_SECONDS,
    label: `${plan.file} run ${String(run)}`, stdio: 'pipe', env: testEnvironment(),
  });

  const xml = junit ? tolerate(() => readFileSync(report, 'utf8'), 'enoent') : undefined;
  const parsed = xml === undefined ? undefined : parseJUnit(xml);

  return {
    run,
    exitCode: outcome.exitCode,
    seconds: outcome.seconds,
    report: junit
      ? { total: parsed?.total ?? 0, failed: parsed?.failed.map((test) => test.key) ?? [], skipped: parsed?.skipped.length ?? 0 }
      : undefined,
    output: `${outcome.stdout}${outcome.stderr}`,
  };
}

/** Every planned suite, each run `plan.runs` times in a row, the suites beside each other within their lanes. */
export async function repeatAll(
  plans: readonly Extract<Plan, { kind: 'repeat' }>[],
  scratch: string,
): Promise<ReadonlyMap<string, readonly RunOutcome[]>> {
  const lanes: Record<Lane, ReturnType<typeof slots>> = { browser: slots(1), pool: slots(1), plain: slots(PLAIN_AT_ONCE) };
  const results = new Map<string, readonly RunOutcome[]>();

  await Promise.all(plans.map((plan) => lanes[plan.lane](async () => {
    const outcomes: RunOutcome[] = [];

    for (let run = 1; run <= plan.runs; run += 1) outcomes.push(await runOnce(plan, run, scratch));
    results.set(plan.file, outcomes);
  })));

  return results;
}

/* ── The verdict ──────────────────────────────────────────────────────── */

const BLIND_SPOTS = [
  'a merge repeats only the test files it changes itself: one it takes whole from a side was that side\'s own '
    + 'commits\' subject, and the sweep\'s',
  'a flake that a changed helper or product file puts into a suite this commit does not change: the nightly sweep '
    + '(`bun run sweep:flakes`, .github/workflows/flake-sweep.yml) repeats every suite the CI tier runs',
  'N runs sample N interleavings: greens raise confidence and prove nothing about absence',
  'a suite never runs beside itself here, so a race between two copies of one suite is not provoked',
  'a file runs apart from its row\'s siblings, so a leak between them (a module mock, a global) is not provoked '
    + 'here; a row that runs its files in fresh globals (`--isolate`) cannot have one',
  'the working tree is run, not the staged content: the hook\'s own stated imprecision',
  'a moved test whose only edits are its import specifiers is not repeated: a rewritten import that now resolves to '
    + 'a different module is run once by the CI tier, not repeated here',
] as const;

/** The line naming one repeated suite's verdict; `written` are the skips its file declares unconditionally. */
function line(plan: Extract<Plan, { kind: 'repeat' }>, outcomes: readonly RunOutcome[], verdict: Verdict, written: readonly string[]): string {
  const seconds = outcomes.reduce((sum, outcome) => sum + outcome.seconds, 0).toFixed(1);
  const runs = `${String(outcomes.length)} run(s) through "${plan.row.label}", ${seconds}s`;

  switch (verdict.kind) {
    case 'green': return `  ok       ${plan.file}  green in ${runs}`;
    case 'skipped': return written.length > 0
      ? `  SKIPPED  ${plan.file}  every test skipped in ${runs}, as written`
      : `  skipped  ${plan.file}  every test skipped in ${runs}, each on a condition this machine does not meet`;
    case 'red': return `  RED      ${plan.file}  red in every one of ${runs}`;
    case 'flaky': return `  FLAKE    ${plan.file}  red in run(s) ${verdict.red.join(', ')} of ${runs}`;
  }
}

/* ── The nightly sweep ────────────────────────────────────────────────── */

/** Runs of each suite in the sweep: fewer than a commit's six, over every suite the CI tier runs. */
export const SWEEP_RUNS = 3;

/** One sweep batch: the test files one row runs together, run the way that row runs them. */
export interface SweepBatch {
  readonly row: Pick<Gate, 'label' | 'deadline'>;
  readonly argv: readonly string[];
  readonly lane: Lane;
}

/**
 * Every batch the sweep runs: each test file the CI tier runs claims, planned as the commit gate plans it, then its
 * row's files put back together under one command, so every suite runs beside its row's siblings. A Python suite runs
 * its directory's discovery. The rows are exactly `--tier=ci`'s, so a nightly runner hosts all of them.
 */
export function sweepBatches(tracked: readonly string[]): SweepBatch[] {
  const rows = tierRun('ci');
  const files = [...new Set(rows.flatMap((row) => claims(row.run, tracked)))];
  const batches = new Map<string, { row: Pick<Gate, 'label' | 'deadline'>; prefix: string[]; targets: Set<string>; lane: Lane }>();

  for (const plan of files.map((file) => planFor(file, tracked, rows))) {
    if (plan.kind !== 'repeat') continue;

    const python = plan.argv.includes('unittest');
    const prefix = python ? discoverArgv(dirname(plan.file)) : plan.argv.slice(0, -1);
    const key = `${plan.row.label}\u0000${prefix.join(' ')}`;
    const batch = batches.get(key) ?? { row: plan.row, prefix, targets: new Set<string>(), lane: plan.lane };

    if (!python) batch.targets.add(plan.argv.at(-1) ?? '');

    if (plan.lane === 'browser') batch.lane = 'browser';
    batches.set(key, batch);
  }

  return [...batches.values()].map(({ row, prefix, targets, lane }) => ({ row, argv: [...prefix, ...targets], lane }));
}

/** `argv` running its tests in an order `seed` decides: bun's `--randomize`, vitest's shuffle. A runner with neither
 *  runs in its own order. */
export function seeded(argv: readonly string[], seed: number): string[] {
  const at = argv.findIndex((word, index) => (word === 'test' && argv[index - 1] === 'bun') || (word === 'run' && argv[index - 1] === 'vitest'));

  if (at === -1) return [...argv];

  const flags = argv[at] === 'test'
    ? ['--randomize', `--seed=${String(seed)}`]
    : ['--sequence.shuffle', `--sequence.seed=${String(seed)}`];

  return [...argv.slice(0, at + 1), ...flags, ...argv.slice(at + 1)];
}

/** One seeded run of a batch: every test's key, and the ones that failed. */
export interface SweepRun {
  readonly seed: number;
  readonly exitCode: number;
  readonly seconds: number;
  readonly tests: readonly string[];
  readonly failed: readonly string[];
  /** The whole output of a run that was not green, since the interleaving that failed is only there. */
  readonly output?: string;
}

/** What a batch's runs say about each test that was not green in all of them. */
export interface SweepVerdict {
  /** Red under some seeds and green under others: an order or a timing the test depends on. */
  readonly flaky: readonly { readonly test: string; readonly red: readonly number[]; readonly green: readonly number[] }[];
  /** Red under every seed that ran it. */
  readonly red: readonly string[];
  /** Runs that failed with no test failing: a crash, a timeout, a runner that reports nothing. */
  readonly broken: readonly number[];
}

export function sweepVerdict(runs: readonly SweepRun[]): SweepVerdict {
  const tests = [...new Set(runs.flatMap((run) => [...run.tests, ...run.failed]))].sort();
  const flaky: SweepVerdict['flaky'][number][] = [];
  const red: string[] = [];

  for (const test of tests) {
    const ran = runs.filter((run) => run.tests.includes(test) || run.failed.includes(test));
    const failing = ran.filter((run) => run.failed.includes(test)).map((run) => run.seed);
    const passing = ran.filter((run) => !run.failed.includes(test)).map((run) => run.seed);

    if (failing.length > 0 && passing.length > 0) flaky.push({ test, red: failing, green: passing });
    else if (failing.length > 0) red.push(test);
  }

  const broken = runs.filter((run) => (run.exitCode !== 0 && run.failed.length === 0) || run.tests.length === 0).map((run) => run.seed);

  return { flaky, red, broken };
}

const CiRunSchema = v.array(v.object({ conclusion: v.string(), status: v.string(), createdAt: v.string(), url: v.string() }));

/** Main's latest CI run, as GitHub reports it, or why it could not be read. */
function mainCiVerdict(): string {
  const run = Bun.spawnSync(['gh', 'run', 'list', '--workflow=ci.yml', '--branch', 'main', '--limit', '1', '--json', 'conclusion,status,createdAt,url'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
  });

  const parsed = run.exitCode === 0 ? v.safeParse(CiRunSchema, tolerate(() => JSON.parse(run.stdout.toString()), 'malformed-input')) : undefined;
  const [latest] = parsed?.success === true ? parsed.output : [];

  if (latest === undefined) return `unknown: gh run list answered ${String(run.exitCode)} ${run.stderr.toString().trim().slice(0, 160)}`;

  return `${latest.conclusion === '' ? latest.status : latest.conclusion}, the run of ${latest.createdAt} (${latest.url})`;
}

/** One run of `batch` in the order `seed` decides, its JUnit report read where its runner writes one. */
export async function sweepRun(batch: SweepBatch, seed: number, scratch: string, index: number): Promise<SweepRun> {
  const report = join(scratch, `sweep-${String(index)}-${String(seed)}.xml`);
  const { argv, junit } = withJUnit(seeded(batch.argv, seed), report);
  const spawned = argv[0] === 'vitest' ? [join(root, 'node_modules', '.bin', 'vitest'), ...argv.slice(1)] : argv;

  const outcome = await runUnderDeadline({
    argv: spawned, cwd: root, seconds: batch.row.deadline?.seconds ?? GATE_DEADLINE_SECONDS,
    label: `${batch.row.label} under seed ${String(seed)}`, stdio: 'pipe', env: testEnvironment(),
  });

  const xml = junit ? tolerate(() => readFileSync(report, 'utf8'), 'enoent') : undefined;
  const parsed = xml === undefined ? undefined : parseJUnit(xml);
  // A runner without a report stands for its batch as one test, named by its row, and fails as it exits.
  const tests = parsed === undefined ? [batch.row.label] : [...parsed.keys];

  const failed = parsed?.failed.map((test) => test.key) ?? (outcome.exitCode === 0 ? [] : [batch.row.label]);

  const green = outcome.exitCode === 0 && failed.length === 0;

  return {
    seed, exitCode: outcome.exitCode, seconds: outcome.seconds, tests, failed,
    output: green ? undefined : `${outcome.stdout}${outcome.stderr}`,
  };
}

/** One of `count` disjoint parts of the sweep, numbered from 1: the batches whose index is `part - 1` modulo `count`.
 *  The parts together are the whole sweep, so each can run on a runner of its own. */
export interface Shard {
  readonly part: number;
  readonly count: number;
}

/** `--shard=<part>/<count>` from `argv`, or undefined for the whole sweep. A malformed one throws. */
export function shardFrom(argv: readonly string[]): Shard | undefined {
  const word = argv.find((each) => each.startsWith('--shard='));

  if (word === undefined) return undefined;
  const [part, count] = word.slice('--shard='.length).split('/').map(Number);

  if (part === undefined || count === undefined || !Number.isInteger(part) || !Number.isInteger(count) || part < 1 || part > count) {
    throw new Error(`${word}: expected --shard=<part>/<count> with 1 <= part <= count`);
  }

  return { part, count };
}

/** The sweep: every batch, SWEEP_RUNS seeded runs each, one batch at a time so each runs on the load it would alone.
 *  `only` narrows it to the batches of one row, by label: a flake chased on demand. */
async function sweep(only: string | undefined, shard: Shard | undefined): Promise<number> {
  const tracked = trackedFiles();
  const named = sweepBatches(tracked).filter((batch) => only === undefined || batch.row.label === only);

  if (named.length === 0) throw new Error(`no CI-tier row is labelled ${JSON.stringify(only)}`);
  const batches = named.filter((_batch, index) => shard === undefined || index % shard.count === shard.part - 1);

  // A part of a narrowed sweep can be left with nothing: the other parts hold its row.
  if (batches.length === 0) {
    console.log(`flake-sweep: part ${String(shard?.part)} of ${String(shard?.count)} holds none of the ${String(named.length)} batch(es)`);

    return 0;
  }

  const ci = mainCiVerdict();

  console.log(`flake-sweep: main's CI: ${ci}`);
  console.log(`flake-sweep: ${String(batches.length)} batch(es) from the CI tier${shard === undefined ? '' : `, part ${String(shard.part)} of ${String(shard.count)}`}, `
    + `${String(SWEEP_RUNS)} seeded run(s) each`);

  const scratch = mkdtempSync(join(tmpdir(), 'kinu-scratch-flake-sweep-'));
  const results: { batch: SweepBatch; runs: SweepRun[]; verdict: SweepVerdict }[] = [];

  try {
    for (const [index, batch] of batches.entries()) {
      const runs: SweepRun[] = [];

      for (let run = 0; run < SWEEP_RUNS; run += 1) runs.push(await sweepRun(batch, crypto.getRandomValues(new Uint32Array(1))[0] ?? 0, scratch, index));
      const verdict = sweepVerdict(runs);
      results.push({ batch, runs, verdict });

      for (const entry of verdict.flaky) {
        console.log(`  FLAKE  ${entry.test}  red under seed(s) ${entry.red.join(', ')}, green under ${entry.green.join(', ')}`);
      }

      for (const test of verdict.red) console.log(`  RED    ${test}  red under every seed`);

      for (const seed of verdict.broken) console.log(`  BROKEN ${batch.row.label}  the run under seed ${String(seed)} failed with no test failing`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const directory = join(root, 'bench-artifacts', 'flake-sweep');
  const artifact = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const tree = git({ cwd: root, env: process.env }, ['rev-parse', 'HEAD']).trim();

  mkdirSync(directory, { recursive: true });
  writeFileSync(artifact, `${JSON.stringify({ ranAt: new Date().toISOString(), tree, ci, results }, null, 2)}\n`);

  const flaky = results.reduce((sum, { verdict }) => sum + verdict.flaky.length, 0);
  const red = results.reduce((sum, { verdict }) => sum + verdict.red.length + verdict.broken.length, 0);

  console.log(`flake-sweep: ${String(flaky)} flaky test(s), ${String(red)} red; the report: ${artifact}`);

  return flaky + red > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const staged = stagedTestFiles();

  if (staged.length === 0) {
    console.log('flake-gate: this commit changes no test file, so there is nothing to repeat');
    console.log(`  blind: ${BLIND_SPOTS[BLIND_SPOTS.length - 1] ?? ''}`);

    return 0;
  }

  const tracked = trackedFiles();
  const plans = staged.map((file) => planFor(file, tracked));
  const repeated = plans.filter((plan) => plan.kind === 'repeat');
  console.log(`flake-gate: ${String(staged.length)} test file(s) in this commit, ${String(repeated.length)} repeated here`);

  const scratch = mkdtempSync(join(tmpdir(), 'kinu-scratch-flake-gate-'));
  const findings: string[] = [];
  const evidence: unknown[] = [];

  try {
    const results = await repeatAll(repeated, scratch);

    for (const plan of plans) {
      if (plan.kind !== 'repeat') {
        console.log(`  ${plan.kind === 'elsewhere' ? 'elsewhere' : 'UNRUN   '} ${plan.file}  ${plan.why}`);

        if (plan.kind === 'unrunnable') {
          findings.push(finding({
            at: plan.file,
            invariant: 'every test file a commit changes is repeated before the commit lands',
            found: plan.why,
            silently: 'a test nobody ran more than once lands, and its first red is a stranger\'s',
            fix: 'give the file a runner a ladder row claims (`bun scripts/ladder.ts --matrix`)',
          }));
        }

        continue;
      }

      const outcomes = results.get(plan.file) ?? [];
      const verdict = verdictOf(outcomes);
      const written = verdict.kind === 'skipped' ? writtenSkips(plan.file, readFileSync(join(root, plan.file), 'utf8')) : [];
      console.log(line(plan, outcomes, verdict, written));

      if (written.length > 0) {
        findings.push(finding({
          at: plan.file,
          invariant: 'a test this commit adds or changes runs somewhere',
          found: `every test skipped, as written: ${written.join('; ')}`,
          silently: 'the file lands tests no machine runs, and its green run says nothing about them',
          fix: 'run them, or gate each on the condition it needs with `test.skipIf`, which the skip ratchet governs',
        }));
      }

      if (verdict.kind === 'flaky') {
        for (const [key, runs] of verdict.tests) console.log(`           ${key}  red in run(s) ${runs.join(', ')}`);
      }

      if (verdict.kind === 'red' || verdict.kind === 'flaky') {
        evidence.push({ file: plan.file, argv: plan.argv, verdict: verdict.kind, runs: outcomes.filter(isRed) });
        findings.push(finding({
          at: plan.file,
          invariant: 'a test this commit adds or changes passes in every run on one tree',
          found: verdict.kind === 'red'
            ? `red in all ${String(outcomes.length)} runs${verdict.failing.length > 0 ? `: ${verdict.failing.join('; ')}` : ''}`
            : `a FLAKE: red in run(s) ${verdict.red.join(', ')} of ${String(outcomes.length)}, green in the rest`,
          silently: verdict.kind === 'red'
            ? 'the suite fails, and every later tier inherits it'
            : 'it passes here often enough to land and fails a later run on a change that did not touch it',
          fix: `${plan.argv.join(' ')}   # the suite alone, as the gate ran it; fix the cause, never retry until green`,
        }));
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (findings.length > 0) {
    const directory = join(root, 'bench-artifacts', 'flake-gate');
    const artifact = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(artifact, `${JSON.stringify({ ranAt: new Date().toISOString(), staged, evidence }, null, 2)}\n`);
    console.error(`\nflake-gate: ${String(findings.length)} finding(s)\n`);

    for (const entry of findings) console.error(entry);
    console.error(`\nEvery red run's output: ${artifact}`);

    return 1;
  }

  console.log('flake-gate: ok');

  for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);

  return 0;
}

if (import.meta.main) {
  const only = process.argv.find((word) => word.startsWith('--only='))?.slice('--only='.length);

  process.exit(await (process.argv.includes('--sweep') ? sweep(only, shardFrom(process.argv)) : main()));
}
