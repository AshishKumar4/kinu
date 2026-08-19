// Bench task + attempt shapes. Pure types and pure derivations — the executing
// runner (filesystem sandbox, subprocesses) lives in scripts/bench.ts.
//
// The task family: a seeded defect in THIS repo, scored by running this repo's
// own checks. Nothing in the scoring path is LLM-judged; a task passes when a
// process exits 0.
import { unitHash } from './stats';
import { normalizeUsage, usageTotal } from '../usage';
import { TURN_WALL_CLOCK_ENVELOPE_MS } from '../config';
import type { LanguageModelUsage } from 'ai';
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
 * Measured, not guessed — both fields, separately.
 *
 * `maxTokens`: on a 5-task pilot against deepseek-v4-flash, a 200k token cap
 * breached on 2 of 5 attempts (40%) and scored them failed; the same five tasks
 * with a 600k cap passed 5/5. A cap that tight measures the budget rather than
 * the solver, and it does so ASYMMETRICALLY — it penalises whichever variant
 * explores more, which in a scaffold comparison is the thing under test. Raised
 * with headroom; an attempt that genuinely runs away still terminates.
 *
 * `wallClockMs`: the identical argument, which this field did NOT have. It was
 * 300_000 while sharing the sentence above, and an attempt is one whole Proteus
 * turn against the sandbox — measured at up to 509 s
 * ({@link TURN_WALL_CLOCK_ENVELOPE_MS}). So the tighter arm of the pair was the
 * clock, breaching on exactly the attempts that explored longest and scoring
 * them failed. It gets the measured turn envelope.
 */
export const DEFAULT_ATTEMPT_BUDGET: AttemptBudget = {
  wallClockMs: TURN_WALL_CLOCK_ENVELOPE_MS,
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
  /** Total tokens the attempt's own meter observed. Absent when nothing metered
   *  the attempt — a worker that crashed before it could report, a
   *  deterministic control that never calls a model — because an attempt priced
   *  at zero looks FREE, and every budget comparison then reads it as
   *  comfortably inside its envelope. Zero is an observed zero: the meter ran
   *  and counted none. */
  tokens?: number;
  /** Exact inference requests observed by the attempt-local meter. Absent only
   *  for an uninstrumented/legacy solver result; zero is an observed zero. */
  modelCalls?: number;
  /** Largest per-turn prompt the provider actually priced over the attempt.
   *  Absent for the same reason `tokens` is; zero means the meter ran and the
   *  variant made no model call. Total tokens says what an attempt cost; this
   *  says how big its working set got, and a context-discipline change moves the
   *  two independently. */
  peakPromptTokens?: number;
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
  tokens: v.optional(NonNegativeInteger),
  modelCalls: v.optional(NonNegativeInteger),
  peakPromptTokens: v.optional(NonNegativeInteger),
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

/** What a solver claims it spent. Every field is optional and absence means
 *  UNMEASURED, never free: a worker that died before its meter reported omits
 *  them, while a deterministic control that issues no request at all reports
 *  explicit zeros, because that zero is something it observed. */
export interface SolverResult {
  tokens?: number;
  /** Exact inference requests observed by the solver's attempt-local meter. */
  modelCalls?: number;
  /** See AttemptOutcome.peakPromptTokens. */
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

/** Tokens spent on one model call, or undefined when the report carried no
 *  countable input or output at all.
 *
 *  That usage object is a provider trust boundary and its shape is
 *  version-dependent. At the provider layer ai v6 reports the NESTED
 *  `inputTokens: { total, noCache, cacheRead }` (`LanguageModelV3Usage`,
 *  @ai-sdk/provider dist/index.d.ts:1797-1818; V2's flat form is at :2673-2696,
 *  which is what the comment here used to name), while the higher-level
 *  streamText result reports the flat `LanguageModelUsage` (ai
 *  dist/index.d.ts:267-325). Both dialects are read here and the nested one is
 *  lifted onto the flat one, so `normalizeUsage` stays the ONE thing that
 *  decides what a provider reported — the first version of this added the
 *  objects together and produced the STRING "0[object Object]".
 *
 *  What it no longer does is call an unreadable or missing field zero. A token
 *  budget that silently mis-sums is worse than no budget, and a fabricated zero
 *  is that mis-sum in its most expensive form: it prices an unmeasured attempt
 *  as free, which any comparison against a cap then reads as "inside budget". So
 *  absence comes back as absence and the BUDGET CALLER decides what an
 *  unmeasured attempt means — scripts/bench.ts refuses to judge one. */
const UsageBoundarySchema = v.object({
  inputTokens: v.optional(v.unknown()),
  outputTokens: v.optional(v.unknown()),
});

/** One token figure in either dialect, reduced at the boundary to the count it
 *  reports: the flat count, or the nested object whose `total` is that same
 *  count. The two fields are parsed one at a time rather than as a single shape,
 *  so a provider that garbles its input figure still has its output figure read.
 *  `v.finite()` is what keeps NaN and Infinity out of a budget — neither is a
 *  quantity, and arithmetic that swallows one stops being a budget at all. */
const TokenFigureSchema = v.pipe(
  v.union([
    v.pipe(v.number(), v.finite()),
    v.looseObject({ total: v.optional(v.nullable(v.pipe(v.number(), v.finite()))) }),
  ]),
  v.transform((figure): number | undefined => (
    v.is(v.number(), figure) ? figure : figure.total ?? undefined
  )),
);

export function usageTokens<Reported>(usage: Reported): number | undefined {
  const parsed = v.safeParse(UsageBoundarySchema, usage);
  if (!parsed.success) return undefined;
  const input = v.safeParse(TokenFigureSchema, parsed.output.inputTokens);
  const output = v.safeParse(TokenFigureSchema, parsed.output.outputTokens);
  // The nested dialect's cache and reasoning parts are SUBSETS of these two
  // totals, so they cannot move a token count — and the provider's own `raw`
  // payload is left out for the same reason. `raw` is the oracle for WHETHER a
  // field was reported, but the adapters only fabricate zeros in the DETAIL
  // fields (@ai-sdk/openai-compatible dist/index.js:88-89,
  // @ai-sdk/anthropic dist/index.js:1782-1783); they leave an unreported total
  // undefined. A caller that needs the details reads the `Usage` on the step
  // event rather than this budget reader.
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

/** Which variant attempts a task first, randomized per task and repeat from the
 *  run seed. Order matters once real agents are involved (warm caches, host
 *  state), and a fixed order would confound it with the variant. The repeat is
 *  part of the draw so a task's repeats do not all inherit one order — that
 *  would leave the very confound the randomization exists to break. Fully
 *  determined by (seed, task, repeat), so a run reproduces exactly. */
export function runOrder(taskId: string, seed: number, repeat = 0): 'ab' | 'ba' {
  return unitHash(`order:${seed}:${taskId}:${repeat}`) < 0.5 ? 'ab' : 'ba';
}
