// Bench task + attempt shapes. Pure types and pure derivations — the executing
// runner (filesystem sandbox, subprocesses) lives in scripts/bench.ts.
//
// The task family: a seeded defect in THIS repo, scored by running this repo's
// own checks. Nothing in the scoring path is LLM-judged; a task passes when a
// process exits 0.
import { unitHash } from './stats.js';

/** One machine-run check. All of a task's checks must exit 0 to score 1. */
export interface BenchCheck {
  id: string;
  /** argv, executed without a shell. */
  command: readonly string[];
  /** Relative to the sandbox root. */
  cwd?: string;
  timeoutMs?: number;
}

export interface BenchTask {
  id: string;
  title: string;
  /** What the solver is told. Must never contain the fix, the defect patch, or
   *  the check sources — the corpus loader asserts the patch is not embedded. */
  prompt: string;
  /** Paths the defect touches; the solver's expected edit surface. */
  editable: readonly string[];
  /** Paths restored from the pristine tree immediately before scoring, so a
   *  solver cannot raise the number by editing the thing that measures it. */
  guarded: readonly string[];
  /** Every check must pass. Ordered cheapest-first so failures short-circuit. */
  checks: readonly BenchCheck[];
  tags?: readonly string[];
}

/** A pinned compute envelope. An unpinned envelope silently becomes the
 *  variable under test — provisioning alone can move outcomes several points —
 *  so every attempt runs under exactly this budget and the budget is hashed
 *  into the report. */
export interface AttemptBudget {
  wallClockMs: number;
  maxTokens: number;
}

export const DEFAULT_ATTEMPT_BUDGET: AttemptBudget = {
  wallClockMs: 300_000,
  maxTokens: 200_000,
};

export type BudgetBreach = 'wall-clock' | 'tokens';

export interface CheckOutcome {
  id: string;
  passed: boolean;
  /** null when the check was killed by its timeout. */
  exitCode: number | null;
  durationMs: number;
  /** Tail of combined stdout/stderr, truncated. Diagnostic only — never fed
   *  back into any adaptation loop for a sealed task. */
  output: string;
}

export interface AttemptOutcome {
  taskId: string;
  variantId: string;
  /** Which side of the randomized pairing this variant occupied. */
  slot: 'a' | 'b';
  passed: boolean;
  checks: readonly CheckOutcome[];
  durationMs: number;
  tokens: number;
  /** null when the attempt stayed inside its envelope. */
  budgetBreach: BudgetBreach | null;
  error?: string;
}

/** Solvers mutate a prepared sandbox in place; they never score themselves. */
export interface SolverContext {
  task: BenchTask;
  /** Absolute path to this attempt's private sandbox copy of the repo. */
  sandboxDir: string;
  /** Absolute path to this attempt's PROTEUS_HOME. Never the real one. */
  proteusHome: string;
  budget: AttemptBudget;
  signal: AbortSignal;
  /** Deterministic per-attempt seed, so controls are reproducible. */
  seed: number;
}

export interface SolverResult {
  tokens?: number;
  error?: string;
}

export interface Solver {
  id: string;
  description: string;
  solve(ctx: SolverContext): Promise<SolverResult>;
}

/** Passing a task is all-or-nothing: every check must exit 0. Partial credit
 *  would need a weighting someone chose, and a chosen weighting is a rubric. */
export function attemptPassed(checks: readonly CheckOutcome[]): boolean {
  return checks.length > 0 && checks.every((c) => c.passed);
}

/** Tokens spent on one model call, read from the AI SDK's low-level stream
 *  `finish` part.
 *
 *  That usage object is a provider trust boundary and its shape is
 *  version-dependent: at the LanguageModelV2 layer ai v6 reports
 *  `inputTokens: { total, noCache, cacheRead }`, while the higher-level
 *  streamText result normalizes the same field to a plain number. Both are
 *  accepted and anything else counts as zero, because a token budget that
 *  silently mis-sums is worse than no budget — the first version of this added
 *  the objects together and produced the STRING "0[object Object]". */
export function usageTokens(usage: unknown): number {
  return tokenField(usage, 'inputTokens') + tokenField(usage, 'outputTokens');
}

function tokenField(usage: unknown, key: string): number {
  if (typeof usage !== 'object' || usage === null) return 0;
  const value = (usage as Record<string, unknown>)[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'object' && value !== null) {
    const total = (value as Record<string, unknown>).total;
    if (typeof total === 'number' && Number.isFinite(total)) return total;
  }
  return 0;
}

/** Which variant attempts a task first, randomized per task from the run seed.
 *  Order matters once real agents are involved (warm caches, host state), and a
 *  fixed order would confound it with the variant. Deterministic given a seed so
 *  a run reproduces exactly. */
export function runOrder(taskId: string, seed: number): 'ab' | 'ba' {
  return unitHash(`order:${seed}:${taskId}`) < 0.5 ? 'ab' : 'ba';
}
