// The sealed split. Held-out tasks that no reflection, GEPA minibatch, scaffold
// proposal, or human tuning pass ever sees.
//
// The seal is structural, not a promise someone has to remember:
//   1. Membership is a deterministic function of the task id and a committed
//      salt — nobody picks which tasks are held out, so nobody can move a task
//      that a variant happens to fail.
//   2. `SealedSplit` holds its tasks in a `#private` field with exactly one
//      exit: `evaluate()`, which returns AGGREGATES ONLY. There is no per-task
//      id, diff, error string, or trace in a `SealedScorecard`, so an adaptation
//      loop consuming harness output has nothing to fit to.
//   3. The dev-facing corpus is a plain array that provably excludes sealed
//      tasks (asserted in unit tests), so contamination cannot happen by a
//      caller reaching for the wrong field.
//   4. The runner's sandbox excludes the whole task corpus directory, so an
//      agent under evaluation cannot read any task definition, dev or sealed.
//   5. Every evaluation appends to an append-only ledger; the report prints the
//      ordinal, so repeated peeking at the held-out set is countable.
import { fnv1a64 } from '../prompting/volatile-context.js';
import { pairedBinaryComparison, unitHash } from './stats.js';
import type { BootstrapOptions, PairedBinaryStats, PairedOutcome } from './stats.js';
import type { BenchTask } from './types.js';

/** Committed salt. Changing it re-rolls every task's assignment and invalidates
 *  historical sealed results — the manifest hash in each report is what makes
 *  such a change visible rather than silent. */
export const SEAL_SALT = 'proteus-bench-seal-v1';

/** Half the corpus is held out. With a small corpus a smaller held-out share
 *  would resolve nothing at all. */
export const DEFAULT_SEALED_FRACTION = 0.5;

export type BenchSplit = 'dev' | 'sealed';

/** Deterministic assignment. Not a security primitive — its job is to remove
 *  all per-task discretion, which is what actually protects a held-out set. */
export function splitOf(taskId: string, salt = SEAL_SALT, sealedFraction = DEFAULT_SEALED_FRACTION): BenchSplit {
  return unitHash(`${salt}:${taskId}`) < sealedFraction ? 'sealed' : 'dev';
}

/** Content digest of one task — changing a task's prompt or checks changes it. */
export function taskHash(task: BenchTask): string {
  return fnv1a64(JSON.stringify([
    task.id, task.title, task.prompt,
    [...task.editable].sort(), [...task.guarded].sort(),
    task.checks.map((c) => [c.id, [...c.command], c.cwd ?? '', c.timeoutMs ?? 0]),
  ]));
}

/** Digest over a whole task set. Printed in every report and pinned by a test,
 *  so silently editing a held-out task to be easier is detectable. */
export function manifestHash(tasks: readonly BenchTask[]): string {
  return fnv1a64([...tasks].map(taskHash).sort().join('|'));
}

export interface SealedScorecard {
  tasks: number;
  manifestHash: string;
  /** Aggregates only. Deliberately no task ids, outputs, or per-case rows. */
  stats: PairedBinaryStats;
}

export type SealedPairRunner = (task: BenchTask) => Promise<{ a: boolean; b: boolean }>;

export class SealedSplit {
  readonly #tasks: readonly BenchTask[];
  readonly size: number;
  readonly manifestHash: string;

  constructor(tasks: readonly BenchTask[]) {
    this.#tasks = tasks;
    this.size = tasks.length;
    this.manifestHash = manifestHash(tasks);
  }

  /** The only way anything leaves the seal. Runs both variants on every held-out
   *  task and returns aggregate statistics — the per-task outcomes are consumed
   *  here and never surfaced. */
  async evaluate(run: SealedPairRunner, opts: BootstrapOptions = {}): Promise<SealedScorecard> {
    const outcomes: PairedOutcome[] = [];
    for (const task of this.#tasks) {
      const { a, b } = await run(task);
      outcomes.push({ taskId: task.id, a, b });
    }
    return {
      tasks: this.#tasks.length,
      manifestHash: this.manifestHash,
      stats: pairedBinaryComparison(outcomes, opts),
    };
  }

  /** Well-formedness only. A task is valid when its defect breaks the checks
   *  and reversing it restores them — a property of the TASK, not of any
   *  variant, so surfacing which ones are broken leaks no performance signal.
   *  A corpus that cannot be validated is worse than one that can. */
  async validate(check: (task: BenchTask) => Promise<boolean>): Promise<{ checked: number; invalid: string[] }> {
    const invalid: string[] = [];
    for (const task of this.#tasks) {
      if (!(await check(task))) invalid.push(task.id);
    }
    return { checked: this.#tasks.length, invalid };
  }

  /** Held-out task ids exist only to be excluded elsewhere (e.g. asserting the
   *  dev split is disjoint). Returns hashes, never content. */
  fingerprints(): readonly string[] {
    return this.#tasks.map(taskHash);
  }
}

export interface BenchCorpus {
  /** Freely usable: reflection, GEPA, scaffold proposals, and human iteration. */
  dev: readonly BenchTask[];
  sealed: SealedSplit;
  salt: string;
  sealedFraction: number;
  /** Over the whole corpus, both splits. */
  manifestHash: string;
}

export interface PartitionOptions {
  salt?: string;
  sealedFraction?: number;
}

export function partitionCorpus(tasks: readonly BenchTask[], opts: PartitionOptions = {}): BenchCorpus {
  const salt = opts.salt ?? SEAL_SALT;
  const sealedFraction = opts.sealedFraction ?? DEFAULT_SEALED_FRACTION;
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`duplicate bench task id: ${t.id}`);
    ids.add(t.id);
  }
  const dev: BenchTask[] = [];
  const sealed: BenchTask[] = [];
  for (const t of tasks) (splitOf(t.id, salt, sealedFraction) === 'sealed' ? sealed : dev).push(t);
  return { dev, sealed: new SealedSplit(sealed), salt, sealedFraction, manifestHash: manifestHash(tasks) };
}

/** A task whose prompt quotes the fix is not a task. Returns the offending line,
 *  or null when the prompt is clean. */
export function promptLeaksFix(prompt: string, patch: string): string | null {
  const normalized = prompt.replace(/\s+/g, ' ');
  for (const raw of patch.split('\n')) {
    if (!raw.startsWith('-') || raw.startsWith('---')) continue;
    // A defect patch turns good code into bad; its '-' lines ARE the fix.
    const line = raw.slice(1).trim().replace(/\s+/g, ' ');
    if (line.length >= 16 && normalized.includes(line)) return line;
  }
  return null;
}
