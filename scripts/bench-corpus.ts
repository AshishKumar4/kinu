// Bench corpus loading. Reads tests/bench/tasks.jsonl + tests/bench/patches/,
// validates every task at load, and hands back the dev/sealed partition. Also
// answers whether the corpus still APPLIES, which is the one property nothing
// about the files themselves can tell you.
//
// Check suites are named presets rather than per-task copies of the same commands:
// the corpus is data about DEFECTS, not a place to restate how this
// repo is verified.
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as v from 'valibot';
import { gitEnv } from '@kinu.run/test-utils';
import { enumerateRepository, isBenchDefectPatch } from './sources';
import { partitionCorpus, promptLeaksFix } from '../packages/core/src/index';
import type { BenchCheck, BenchCorpus, BenchTask, PartitionOptions } from '../packages/core/src/index';

export interface BenchSuite {
  checks: readonly BenchCheck[];
  /** Restored from the pristine tree immediately before scoring. A bare path is
   *  restored wholesale; a path containing '*' restores matching files and
   *  deletes ones the solver added. */
  guarded: readonly string[];
}

const BENCH_SUITE_NAMES = ['core', 'lean'] as const;

type BenchSuiteName = (typeof BENCH_SUITE_NAMES)[number];

/** The verifiable outcomes this repo already supplies. `core` is the whole core
 *  suite plus its typecheck — running the FULL suite rather than just the
 *  target test is deliberate: it scores collateral damage for free.
 *
 *  The suite runs as `test:core` runs it, four workers. Serially it did not fit
 *  its own limit: on 2026-09-23 it took 131 s in a worktree and was killed at
 *  180 s in the sandbox (validate-d8389864d96e, both attempts `exitCode: null`),
 *  so every task read BAD; `--parallel=4` took 61 s on the same box. */
export const BENCH_SUITES: Readonly<Record<BenchSuiteName, BenchSuite>> = Object.freeze({
  core: {
    checks: [
      { id: 'core-tests', command: ['bun', 'test', '--timeout=0', '--parallel=4', '--cwd', 'packages/core'], timeoutMs: 180_000 },
      // The vendored binary, not `bun x` — scoring must never depend on a
      // package fetch, and the sandbox runs with a pruned environment.
      { id: 'core-typecheck', command: ['node_modules/.bin/tsc', '--noEmit', '-p', 'packages/core'], timeoutMs: 180_000 },
    ],
    guarded: ['packages/core/tests', 'packages/core/src/**/*.test.ts'],
  },
  lean: {
    checks: [
      { id: 'lean-verify', command: ['bash', 'scripts/verify-lean.sh'], timeoutMs: 900_000 },
    ],
    guarded: ['lean/check-no-false.sh', 'lean/check-traceability.mjs', 'lean/traceability.yaml'],
  },
});

const TaskLineSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase kebab-case')),
  title: v.pipe(v.string(), v.minLength(1)),
  prompt: v.pipe(v.string(), v.minLength(1)),
  suite: v.picklist(BENCH_SUITE_NAMES),
  editable: v.array(v.pipe(v.string(), v.minLength(1))),
  tags: v.optional(v.array(v.string())),
});

export interface LoadedCorpus {
  corpus: BenchCorpus;
  /** Defect diff per task id, applied forward to break, reversed to fix. */
  patches: ReadonlyMap<string, string>;
  path: string;
}

function benchCorpusDir(repoRoot: string): string {
  return join(repoRoot, 'tests', 'bench');
}

export function loadBenchCorpus(repoRoot: string, opts: PartitionOptions = {}): LoadedCorpus {
  const dir = benchCorpusDir(repoRoot);
  const path = join(dir, 'tasks.jsonl');
  const raw = readFileSync(path, 'utf8');
  const tasks: BenchTask[] = [];
  const patches = new Map<string, string>();

  for (const [i, line] of raw.split('\n').entries()) {
    const text = line.trim();

    if (!text || text.startsWith('#')) continue;
    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(text);
    } catch (err) {
      throw new Error(`${path}:${i + 1}: not valid JSON`, { cause: err });
    }

    const parsed = v.safeParse(TaskLineSchema, parsedJson);

    if (!parsed.success) {
      throw new Error(`${path}:${i + 1}: ${parsed.issues.map((x) => x.message).join('; ')}`);
    }

    const line_ = parsed.output;
    const patchPath = join(dir, 'patches', `${line_.id}.patch`);

    if (!existsSync(patchPath)) throw new Error(`${path}:${i + 1}: missing defect patch ${patchPath}`);
    const patch = readFileSync(patchPath, 'utf8');

    const leak = promptLeaksFix(line_.prompt, patch);

    if (leak) throw new Error(`${path}:${i + 1}: prompt quotes the fix ("${leak}") — that is not a task`);

    const suite = BENCH_SUITES[line_.suite];
    patches.set(line_.id, patch);

    const task: BenchTask = {
      id: line_.id,
      title: line_.title,
      prompt: line_.prompt,
      editable: line_.editable,
      guarded: suite.guarded,
      checks: suite.checks,
    };

    if (line_.tags) task.tags = line_.tags;
    tasks.push(task);
  }

  if (tasks.length === 0) throw new Error(`${path}: no tasks — an empty corpus proves nothing`);

  return { corpus: partitionCorpus(tasks, opts), patches, path };
}

/**
 * The corpus's patch files, as repo-relative paths: the TRACKED subset of the one
 * enumeration, narrowed by a named predicate. `trackedFiles()` also lists
 * untracked additions, and an untracked `.patch` is not part of the corpus: a
 * fresh checkout lacks it, so counting it would let a task pass here that fails
 * to load everywhere else. `gate:set-equality` refuses a private walk.
 */
export function benchPatchFiles(repoRoot: string): readonly string[] {
  return enumerateRepository(repoRoot).tracked.filter(isBenchDefectPatch);
}

/** A patch that no longer applies, and git's own account of why. */
export interface StalePatch {
  readonly id: string;
  readonly path: string;
  /** git apply's stderr, verbatim. The line and hunk it failed on is the whole
   *  content of a re-anchor, so summarising it would throw away the fix. */
  readonly detail: string;
}

/** Where the tracked patch files and the `tasks.jsonl` lines disagree. The gate's
 *  patch count equals the task count only when both lists are empty. */
export interface CorpusMembership {
  readonly tasks: number;
  /** Tracked patch files no task line names: no run applies them, and the
   *  count includes them anyway. A half-finished retirement leaves one. */
  readonly orphans: readonly string[];
  /** Task ids whose patch is not among `files`: untracked, so the gate never
   *  checks it and a fresh checkout fails to load the corpus. */
  readonly unchecked: readonly string[];
}

export function corpusMembership(repoRoot: string, files: readonly string[]): CorpusMembership {
  const named = new Set(loadBenchCorpus(repoRoot).patches.keys());
  const tracked = new Set(files.map((file) => basename(file, '.patch')));

  return {
    tasks: named.size,
    orphans: files.filter((file) => !named.has(basename(file, '.patch'))),
    unchecked: [...named].filter((id) => !tracked.has(id)),
  };
}

/**
 * Every seeded patch that no longer applies to the tree at `repoRoot`.
 *
 * A defect patch is data ABOUT source that keeps moving, so an ordinary refactor
 * elsewhere silently invalidates a task and its `prepare` throws at attempt time
 * — long after anyone would connect it to the refactor. Seeded patches have
 * needed re-anchoring more than once, each time as a follow-up commit after the
 * breaking change had already landed.
 *
 * Applicability only. Which files belong to the corpus is `corpusMembership`'s
 * question; an orphan that still applies passes here.
 *
 * The command is the SAME `git apply` the sandbox runs (bench-sandbox.ts), so
 * nothing can pass here and fail there. `--check` never writes.
 *
 * `files` is handed in rather than walked here, so the gate's population and this
 * function's are the same one: production callers pass `benchPatchFiles`, and
 * tests pass a fixture's own list, because a fixture has no git index.
 */
export function stalePatches(repoRoot: string, files: readonly string[]): StalePatch[] {
  const stale: StalePatch[] = [];

  for (const relative of files) {
    const path = join(repoRoot, relative);

    const res = Bun.spawnSync(
      ['git', 'apply', '--check', '--whitespace=nowarn', '-'],
      // The tree at `repoRoot` IS the subject. GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
      // are stripped so nothing ambient can answer for a different repository:
      // `git apply` resolves its paths against `cwd`, and a stray GIT_INDEX_FILE
      // has already once made `git status` in this repo describe another tree.
      { cwd: repoRoot, env: gitEnv(), stdin: Buffer.from(readFileSync(path)), stdout: 'ignore', stderr: 'pipe' },
    );

    if (res.exitCode === 0) continue;
    stale.push({ id: basename(relative, '.patch'), path, detail: res.stderr.toString().trim() });
  }

  return stale;
}
