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
import { fnv1a64 } from '../prompting/volatile-context';
import { pairedBinaryComparison, unitHash } from './stats';
import type { BootstrapOptions, PairedBinaryStats, PairedOutcome } from './stats';
import type { BenchTask } from './types';

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

/** One entry per repeat, per variant. */
export type SealedPairRunner = (task: BenchTask) => Promise<{ a: readonly boolean[]; b: readonly boolean[] }>;

/** The outcome of well-formedness checking one task, with its retry history.
 *
 *  Validation is itself noisy: a real 165-task run flagged one task BAD that
 *  then validated 5/5 in isolation. A single scored attempt can therefore
 *  record a false fail, so a task that fails is re-checked — and a task that
 *  only passed on a retry is NOT the same thing as one that passed first time.
 *  Both facts are carried here rather than collapsed into a boolean. */
export interface TaskValidation {
  ok: boolean;
  /** How many well-formedness checks were run, including the first. */
  attempts: number;
  /** 1-based attempt that succeeded; null when none did. >1 means flaky. */
  passedOnAttempt: number | null;
  /** Human-readable outcome of the last attempt. */
  detail: string;
}

export interface SealedValidation {
  checked: number;
  /** Failed every attempt — genuinely broken tasks. */
  invalid: string[];
  /** Passed, but only after a retry — non-deterministic tasks. */
  flaky: string[];
}

/** The validation repeat policy. Runs `check` until it succeeds or the budget of
 *  `1 + retries` attempts is spent, and records which attempt won.
 *
 *  Bounded and stop-on-first-success on purpose. Unbounded retrying would
 *  eventually let any sufficiently noisy broken task through, and running every
 *  attempt regardless would triple the cost of the common case, which is a
 *  corpus that validates first time. */
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
   *  variant, so surfacing which ones are broken (or unstable) leaks no
   *  performance signal. A corpus that cannot be validated is worse than one
   *  that can. */
  async validate(check: (task: BenchTask) => Promise<TaskValidation>): Promise<SealedValidation> {
    const invalid: string[] = [];
    const flaky: string[] = [];
    for (const task of this.#tasks) {
      const result = await check(task);
      if (!result.ok) invalid.push(task.id);
      else if ((result.passedOnAttempt ?? 1) > 1) flaky.push(task.id);
    }
    return { checked: this.#tasks.length, invalid, flaky };
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
