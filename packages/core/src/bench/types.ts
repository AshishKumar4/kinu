// Bench task + attempt shapes. Pure types and pure derivations — the executing
// runner (filesystem sandbox, subprocesses) lives in scripts/bench.ts.
//
// The task family: a seeded defect in THIS repo, scored by running this repo's
// own checks. Nothing in the scoring path is LLM-judged; a task passes when a
// process exits 0.
import { unitHash } from './stats.js';
import * as v from 'valibot';

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

/**
 * Measured, not guessed. On a 5-task pilot against deepseek-v4-flash, a 200k
 * token cap breached on 2 of 5 attempts (40%) and scored them failed; the same
 * five tasks with a 600k cap passed 5/5. A cap that tight measures the budget
 * rather than the solver, and it does so ASYMMETRICALLY — it penalises whichever
 * variant explores more, which in a scaffold comparison is the thing under test.
 * Raised with headroom; an attempt that genuinely runs away still terminates.
 */
export const DEFAULT_ATTEMPT_BUDGET: AttemptBudget = {
  wallClockMs: 300_000,
  maxTokens: 600_000,
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
  /** 0-based repeat index. Repeats of one task are correlated observations of
   *  the same task, never independent pairs — see bench/stats.ts. */
  repeat: number;
  passed: boolean;
  checks: readonly CheckOutcome[];
  durationMs: number;
  tokens: number;
  /** Exact inference requests observed by the attempt-local meter. Absent only
   *  for an uninstrumented/legacy solver result; zero is an observed zero. */
  modelCalls?: number;
  /** Largest per-turn prompt the provider actually priced over the attempt, or
   *  0 when the variant made no model call. Total tokens says what an attempt
   *  cost; this says how big its working set got, and a context-discipline
   *  change moves the two independently. */
  peakPromptTokens: number;
  /** null when the attempt stayed inside its envelope. */
  budgetBreach: BudgetBreach | null;
  error?: string;
}

const NonNegativeInteger = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0));

/** Parsers for the two outcome shapes, beside the shapes themselves. Anything
 *  that reads an outcome back — the validation diagnostics document, a retained
 *  run's per-trial ledger — parses it rather than asserting it, so a retained
 *  trial that has drifted from this contract fails loudly instead of being
 *  silently reinterpreted. */
export const CheckOutcomeSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  passed: v.boolean(),
  exitCode: v.nullable(NonNegativeInteger),
  durationMs: NonNegativeInteger,
  output: v.string(),
});

export const AttemptOutcomeSchema = v.strictObject({
  taskId: v.pipe(v.string(), v.minLength(1)),
  variantId: v.pipe(v.string(), v.minLength(1)),
  slot: v.picklist(['a', 'b']),
  repeat: NonNegativeInteger,
  passed: v.boolean(),
  checks: v.array(CheckOutcomeSchema),
  durationMs: NonNegativeInteger,
  tokens: NonNegativeInteger,
  modelCalls: v.optional(NonNegativeInteger),
  peakPromptTokens: NonNegativeInteger,
  budgetBreach: v.nullable(v.picklist(['wall-clock', 'tokens'])),
  error: v.optional(v.string()),
});

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
  /** 0-based repeat index. A solver that models run-to-run noise must fold this
   *  into its draw, or every repeat returns the same answer and repeats measure
   *  nothing. (seed, task, repeat) still determines the draw, so runs
   *  reproduce. */
  repeat: number;
}

export interface SolverResult {
  tokens?: number;
  /** Exact inference requests observed by the solver's attempt-local meter. */
  modelCalls?: number;
  /** See AttemptOutcome.peakPromptTokens. Deterministic controls omit it. */
  peakPromptTokens?: number;
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
const UsageBoundarySchema = v.object({
  inputTokens: v.optional(v.unknown()),
  outputTokens: v.optional(v.unknown()),
});

const TokenFieldSchema = v.union([
  v.number(),
  v.object({ total: v.optional(v.number()) }),
]);

function finiteTokenCount(value: v.InferOutput<typeof TokenFieldSchema>): number {
  const count = v.is(v.number(), value) ? value : value.total ?? 0;
  return Number.isFinite(count) ? count : 0;
}

export function usageTokens<Usage>(usage: Usage): number {
  const parsed = v.safeParse(UsageBoundarySchema, usage);
  if (!parsed.success) return 0;
  const input = v.safeParse(TokenFieldSchema, parsed.output.inputTokens);
  const output = v.safeParse(TokenFieldSchema, parsed.output.outputTokens);
  return (input.success ? finiteTokenCount(input.output) : 0)
    + (output.success ? finiteTokenCount(output.output) : 0);
}

/** Which variant attempts a task first, randomized per task and repeat from the
 *  run seed. Order matters once real agents are involved (warm caches, host
 *  state), and a fixed order would confound it with the variant. The repeat is
 *  part of the draw so a task's repeats do not all inherit one order — that
 *  would leave the very confound the randomization exists to break. Fully
 *  determined by (seed, task, repeat), so a run reproduces exactly. */
export function runOrder(taskId: string, seed: number, repeat = 0): 'ab' | 'ba' {
  return unitHash(`order:${seed}:${taskId}:${repeat}`) < 0.5 ? 'ab' : 'ba';
}
