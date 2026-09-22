// The sealed split: held-out tasks no adaptation loop ever sees. Membership is a
// salted hash of the task id; `SealedSplit` exposes aggregates only; the runner's
// sandbox excludes the corpus; every evaluation is counted in an append-only ledger.
import { fnv1a64 } from '../utils/fnv1a';
import { pairedBinaryComparison, unitHash } from './stats';
import type { BootstrapOptions, PairedBinaryStats, PairedOutcome } from './stats';
import type { BenchTask } from './types';

/** Changing it re-rolls every assignment and invalidates historical sealed results. */
export const SEAL_SALT = 'kinu-bench-seal-v1';

export const DEFAULT_SEALED_FRACTION = 0.5;

export type BenchSplit = 'dev' | 'sealed';

/** Not a security primitive; it removes per-task discretion. */
export function splitOf(taskId: string, salt = SEAL_SALT, sealedFraction = DEFAULT_SEALED_FRACTION): BenchSplit {
  return unitHash(`${salt}:${taskId}`) < sealedFraction ? 'sealed' : 'dev';
}

export function taskHash(task: BenchTask): string {
  return fnv1a64(JSON.stringify([
    task.id, task.title, task.prompt,
    [...task.editable].sort(), [...task.guarded].sort(),
    task.checks.map((c) => [c.id, [...c.command], c.cwd ?? '', c.timeoutMs ?? 0]),
  ]));
}

/** Printed in every report, so edits to a held-out task are detectable. */
export function manifestHash(tasks: readonly BenchTask[]): string {
  return fnv1a64([...tasks].map(taskHash).sort().join('|'));
}

export interface SealedScorecard {
  tasks: number;
  manifestHash: string;
  /** Aggregates only: no task ids, outputs, or per-case rows. */
  stats: PairedBinaryStats;
}

export type SealedPairRunner = (task: BenchTask) => Promise<{ a: readonly boolean[]; b: readonly boolean[] }>;

/** Validation is noisy, so failures are retried; passing only on a retry is recorded as flaky. */
export interface TaskValidation {
  ok: boolean;
  attempts: number;
  /** 1-based; >1 means flaky. */
  passedOnAttempt: number | null;
  detail: string;
}

export interface SealedValidation {
  checked: number;
  invalid: string[];
  flaky: string[];
}

/** Bounded, stop-on-first-success retries: `1 + retries` attempts at most. */
export async function validateWithRetries(
  retries: number,
  check: (attempt: number) => Promise<{ ok: boolean; detail: string }>,
): Promise<TaskValidation> {
  if (!Number.isInteger(retries) || retries < 0) throw new Error(`validate retries must be a non-negative integer, got ${retries}`);
  const budget = retries + 1;
  let first = '';

  for (let attempt = 1; attempt <= budget; attempt++) {
    const { ok, detail } = await check(attempt);

    if (attempt === 1) first = detail;

    if (ok) {
      return {
        ok: true,
        attempts: attempt,
        passedOnAttempt: attempt,
        detail: attempt === 1 ? detail : `FLAKY: ${detail} — but attempt 1 failed (${first})`,
      };
    }

    if (attempt === budget) {
      return { ok: false, attempts: attempt, passedOnAttempt: null, detail: `failed all ${budget} attempt(s): ${detail}` };
    }
  }

  throw new Error('unreachable: the retry budget is at least 1');
}

export class SealedSplit {
  readonly #tasks: readonly BenchTask[];
  readonly size: number;
  readonly manifestHash: string;

  constructor(tasks: readonly BenchTask[]) {
    this.#tasks = tasks;
    this.size = tasks.length;
    this.manifestHash = manifestHash(tasks);
  }

  /** The only exit from the seal; per-task outcomes are consumed here. */
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

  /** Well-formedness only, which carries no performance signal. `checked` reports
   *  what `only` actually selected, so a narrowed run is not a verdict on the seal. */
  async validate(
    check: (task: BenchTask) => Promise<TaskValidation>, only?: readonly string[],
  ): Promise<SealedValidation> {
    const invalid: string[] = [];
    const flaky: string[] = [];

    const selected = only === undefined
      ? this.#tasks
      : this.#tasks.filter((task) => only.includes(task.id));

    for (const task of selected) {
      const result = await check(task);

      if (!result.ok) invalid.push(task.id);
      else if ((result.passedOnAttempt ?? 1) > 1) flaky.push(task.id);
    }

    return { checked: selected.length, invalid, flaky };
  }

  /** Leaks nothing `splitOf` does not already compute; lets a bad `--id` refuse. */
  has(taskId: string): boolean {
    return this.#tasks.some((task) => task.id === taskId);
  }

  /** Hashes, never content. */
  fingerprints(): readonly string[] {
    return this.#tasks.map(taskHash);
  }
}

export interface BenchCorpus {
  /** Freely usable by adaptation. */
  dev: readonly BenchTask[];
  sealed: SealedSplit;
  salt: string;
  sealedFraction: number;
  manifestHash: string;
}

export interface PartitionOptions {
  salt?: string;
  sealedFraction?: number;
}

export function partitionCorpus(tasks: readonly BenchTask[], opts: PartitionOptions = {}): BenchCorpus {
  const salt = opts.salt ?? SEAL_SALT;
  const sealedFraction = opts.sealedFraction ?? DEFAULT_SEALED_FRACTION;

  if (!Number.isFinite(sealedFraction) || sealedFraction < 0 || sealedFraction > 1) {
    throw new Error(`sealedFraction must be in [0, 1], got ${sealedFraction}`);
  }

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

/** Returns the prompt line that quotes the fix, or null. */
export function promptLeaksFix(prompt: string, patch: string): string | null {
  const normalized = prompt.replace(/\s+/g, ' ');

  for (const raw of patch.split('\n')) {
    if (!raw.startsWith('-') || raw.startsWith('---')) continue;
    // A defect patch's '-' lines are the fix.
    const line = raw.slice(1).trim().replace(/\s+/g, ' ');

    if (line.length >= 16 && normalized.includes(line)) return line;
  }

  return null;
}
