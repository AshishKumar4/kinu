// Bench corpus loading. Reads tests/bench/tasks.jsonl + tests/bench/patches/,
// validates every task at load, and hands back the dev/sealed partition.
//
// Check suites are named presets rather than per-task copies of the same two
// commands: the corpus is data about DEFECTS, not a place to restate how this
// repo is verified.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
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
 *  suite plus its typecheck — running the FULL suite (1.6s) rather than just the
 *  target test is deliberate: it scores collateral damage for free. */
export const BENCH_SUITES: Readonly<Record<BenchSuiteName, BenchSuite>> = Object.freeze({
  core: {
    checks: [
      { id: 'core-tests', command: ['bun', 'test', '--cwd', 'packages/core'], timeoutMs: 180_000 },
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

  raw.split('\n').forEach((line, i) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;
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
  });

  if (tasks.length === 0) throw new Error(`${path}: no tasks — an empty corpus proves nothing`);
  return { corpus: partitionCorpus(tasks, opts), patches, path };
}
