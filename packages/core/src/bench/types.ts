// Bench task and attempt shapes. The runner lives in scripts/bench.ts. Scoring
// is never LLM-judged: a task passes when its checks exit 0.
import { unitHash } from './stats';
import { normalizeUsage, usageTotal } from '../usage';
import type { LanguageModelUsage } from 'ai';
import * as v from 'valibot';

export interface BenchCheck {
  id: string;
  /** argv, executed without a shell. */
  command: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface BenchTask {
  id: string;
  title: string;
  /** Must never contain the fix, the defect patch, or the check sources. */
  prompt: string;
  editable: readonly string[];
  /** Restored from the pristine tree before scoring, so a solver cannot edit the measure. */
  guarded: readonly string[];
  /** Ordered cheapest-first so failures short-circuit. */
  checks: readonly BenchCheck[];
  tags?: readonly string[];
}

/** Pinned per attempt and hashed into the report, so provisioning is not a variable. */
export interface AttemptBudget {
  wallClockMs: number;
  maxTokens: number;
}

/**
 * Measured on a pilot: tighter caps breached on the attempts that explored most,
 * penalising the variant under test. A measurement-harness bound only; production
 * turns carry no wall clock (owner ruling, 2026-08-21).
 */
export const DEFAULT_ATTEMPT_BUDGET: AttemptBudget = {
  wallClockMs: 600_000,
  maxTokens: 600_000,
};

export type BudgetBreach = 'wall-clock' | 'tokens';

export interface CheckOutcome {
  id: string;
  passed: boolean;
  /** null when killed by its timeout. */
  exitCode: number | null;
  durationMs: number;
  /** Diagnostic only; never fed back into adaptation for a sealed task. */
  output: string;
}

export interface AttemptOutcome {
  taskId: string;
  variantId: string;
  slot: 'a' | 'b';
  /** Repeats of one task are correlated, never independent pairs. */
  repeat: number;
  passed: boolean;
  checks: readonly CheckOutcome[];
  durationMs: number;
  /** Absent when nothing metered the attempt; zero is an observed zero, never "free". */
  tokens?: number;
  modelCalls?: number;
  /** Largest per-turn prompt priced over the attempt; absent as for `tokens`. */
  peakPromptTokens?: number;
  budgetBreach: BudgetBreach | null;
  error?: string;
}

const NonNegativeInteger = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0));

/** Retained outcomes are parsed, not asserted, so drift fails loudly. */
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
  tokens: v.optional(NonNegativeInteger),
  modelCalls: v.optional(NonNegativeInteger),
  peakPromptTokens: v.optional(NonNegativeInteger),
  budgetBreach: v.nullable(v.picklist(['wall-clock', 'tokens'])),
  error: v.optional(v.string()),
});

/** Solvers mutate a prepared sandbox in place; they never score themselves. */
export interface SolverContext {
  task: BenchTask;
  sandboxDir: string;
  /** Never the real KINU_HOME. */
  kinuHome: string;
  budget: AttemptBudget;
  signal: AbortSignal;
  seed: number;
  /** Must be folded into any noise draw, or repeats measure nothing. */
  repeat: number;
}

/** Absent fields mean unmeasured, never free; controls report explicit zeros. */
export interface SolverResult {
  tokens?: number;
  modelCalls?: number;
  peakPromptTokens?: number;
  error?: string;
}

export interface Solver {
  id: string;
  description: string;
  solve(ctx: SolverContext): Promise<SolverResult>;
}

/** All-or-nothing: partial credit would need a chosen weighting, i.e. a rubric. */
export function attemptPassed(checks: readonly CheckOutcome[]): boolean {
  return checks.length > 0 && checks.every((c) => c.passed);
}

/** Provider usage is a trust boundary with two dialects (nested V3 `{ total }` and flat).
 *  Unreadable figures stay undefined, never zero; scripts/bench.ts refuses to judge one. */
const UsageBoundarySchema = v.object({
  inputTokens: v.optional(v.unknown()),
  outputTokens: v.optional(v.unknown()),
});

/** Parsed per field so one garbled figure does not hide the other; `v.finite()` keeps NaN out. */
const TokenFigureSchema = v.pipe(
  v.union([
    v.pipe(v.number(), v.finite()),
    v.looseObject({ total: v.optional(v.nullable(v.pipe(v.number(), v.finite()))) }),
  ]),
  v.transform((figure): number | undefined => (
    v.is(v.number(), figure) ? figure : figure.total ?? undefined
  )),
);

export function usageTokens(usage: { reported: unknown }): number | undefined {
  const parsed = v.safeParse(UsageBoundarySchema, usage.reported);

  if (!parsed.success) return undefined;
  const input = v.safeParse(TokenFigureSchema, parsed.output.inputTokens);
  const output = v.safeParse(TokenFigureSchema, parsed.output.outputTokens);

  // Cache and reasoning details are subsets of these totals, so they are omitted.
  const report: LanguageModelUsage = {
    inputTokens: input.success ? input.output : undefined,
    inputTokenDetails: {
      noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined,
    },
    outputTokens: output.success ? output.output : undefined,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
  };

  return usageTotal(normalizeUsage(report));
}

/** Per task and repeat from the run seed, so order is not confounded with variant. */
export function runOrder(taskId: string, seed: number, repeat = 0): 'ab' | 'ba' {
  return unitHash(`order:${seed}:${taskId}:${repeat}`) < 0.5 ? 'ab' : 'ba';
}
