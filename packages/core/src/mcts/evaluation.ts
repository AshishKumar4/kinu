/**
 * Grounded branch evaluation — the production MCTS scorer.
 *
 * Called from the engine's EVALUATE phase (mcts/engine.ts) for every branch
 * on every backend: CF Facets, the CF inline fallback, and CLI forked
 * branches all flow through here. There is deliberately no per-backend
 * evaluate — branches explore, the engine scores.
 *
 * Two layers, combined so execution dominates:
 *
 * 1. EXECUTION GROUNDING — when the branch produced code, it is actually run
 *    through the threaded executor (optionally extended with judge-generated
 *    assertions that exercise it against the task). Pass/fail picks the score
 *    band: a branch whose code fails can never outscore one whose code runs.
 *      pass  → [0.60, 1.00]   fail → [0.05, 0.30]
 * 2. JUDGE ENSEMBLE — k independent judge samples (median-aggregated,
 *    parse-failure-robust: a sample that fails to parse is dropped, never
 *    counted as 0) place the branch within its band. The judge scores against
 *    the TASK and relative to sibling proposals, not absolute vibes.
 *    Prose-only branches are judge-only at reduced confidence:
 *      prose → [0.00, 0.75]
 *
 * ── BAND TABLE (WP-A5) ──────────────────────────────────────────────
 *   outcome                           multiplier·judge      range
 *   code ran & PASSED                 0.60 + 0.40·j         [0.60, 1.00]
 *   code ran & FAILED                 0.05 + 0.25·j         [0.05, 0.30]
 *   code did not PARSE                0.05 (no judge)        0.05
 *   code in an UNRUNNABLE language    0.30·j                [0.00, 0.30]
 *   prose only (no sibling code)      0.75·j                [0.00, 0.75]
 *   prose only (a sibling HAS code)   0.30·j                [0.00, 0.30]
 *
 * The parse row is the evaluation cascade, kept to its cheapest honest form:
 * a branch whose code the engine could not even parse has DECIDED its own
 * verdict, and no judge opinion can move it inside the fail band — so the
 * ensemble's k calls are spent on nothing. Skipping them lands the branch on
 * the band floor, which is the exact score the "no judge sample survived"
 * path already assigns, so this changes no score outside the branches whose
 * spend it skips. Everything that parses — including code that ran and threw
 * — is judged exactly as before, because there the judge's placement inside
 * the band is real information.
 *
 * The last prose row closes the loophole: without it a branch that dodged code
 * (prose, cap 0.75) outscored one that attempted code and FAILED (cap 0.30),
 * rewarding non-attempts. When any sibling in the expansion produced code, a
 * prose-only branch is capped at the FAIL ceiling (0.30) — it cannot beat a
 * failed executable sibling by declining to compete on execution.
 * Unsupported fenced code is a distinct, named outcome. It is capped at the
 * same ceiling because it was not executed and therefore cannot outrank a
 * verified pass.
 *
 * The downstream thresholds are pinned to these band boundaries (see
 * config.ts): craftExtractionThreshold 0.80 = pass-band midpoint (executed +
 * ≥median judge; unreachable by any prose branch); minAcceptableScore 0.30 =
 * FAIL ceiling (a converged answer must clear the fail/dodge band);
 * reflectionThreshold 0.35 = FAIL ceiling + thin margin (every fail-band node
 * earns a lesson); pruneThreshold 0.25 sits inside the fail band.
 *
 * The judge is the cross-model rt.judgeModel when configured; falling back to
 * the explorer model is the DOCUMENTED fallback (self-enhancement bias per
 * LLM-as-Judge arXiv:2306.05685), not a hidden default. If every judge sample
 * fails, the branch gets its band floor (0 for prose) — infrastructure
 * failure must look bad, never neutral (see engine.ts EVALUATE).
 *
 * Research grounding: model self-selection plateaus ~55% vs 99% oracle
 * (arXiv:2602.18998); verifier quality, not search, is the bottleneck
 * (Koh et al. arXiv:2407.01476).
 */

import * as v from 'valibot';
import type { LLM, Executor } from '../types/primitives.js';
import type { EvaluationGrounding } from '../types/evaluation.js';
import { readProposalCode } from '../execution/code-fence.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window.js';
import { DEFAULT_CONFIG } from '../config.js';

/** Score bands. Execution verdicts dominate: fail ceiling < pass floor, and
 *  prose confidence is capped below a passing branch with a median judge.
 *  See the BAND TABLE in the module header. */
const PASS_FLOOR = 0.6;
const PASS_SPAN = 0.4;
const FAIL_FLOOR = 0.05;
const FAIL_SPAN = 0.25;
/** Top of the fail band (0.30): a code branch that ran and failed can score no
 *  higher, and neither may a prose branch when siblings actually attempted code. */
const FAIL_CEIL = FAIL_FLOOR + FAIL_SPAN;
const PROSE_CONFIDENCE = 0.75;

/**
 * Wall clock on a SINGLE judge completion.
 *
 * The judge is an ordinary provider call (`generateText` with no abort signal),
 * so an upstream that accepts the request and then never responds leaves the
 * promise pending forever. The evaluator awaits these calls inside a
 * `Promise.all` / `Promise.allSettled`, which resolves only when EVERY member
 * settles — so one non-responding judge stalls the whole evaluation. MCTS runs
 * that evaluation inside a durable background fiber that carries no wall clock
 * of its own (fork wall_clock_ms is intentionally unset so real work runs to
 * completion), and nothing aborts it, so the stall becomes a permanent hang:
 * the search freezes on its first expansion and the tree never grows again.
 *
 * A timed-out judge is DROPPED exactly like a thrown one (see sampleJudgeScore /
 * generateAssertions), so the ensemble degrades to the samples that did answer
 * instead of the search dying. Generous by design — a real judge completion on
 * a bounded prompt finishes well inside this even on a reasoning model; only a
 * genuinely stuck call is cut. Override per-evaluation via
 * EvaluateBranchOptions.judgeCallTimeoutMs.
 */
export const DEFAULT_JUDGE_CALL_TIMEOUT_MS = 120_000;

/** `judge.complete`, bounded. Rejects (→ the caller's existing catch → the
 *  sample is dropped) if the provider does not answer within `timeoutMs`. The
 *  underlying call cannot be cancelled without an abort signal the LLM seam
 *  does not carry, but losing the race unblocks the evaluator, which is the
 *  freeze this fixes. */
async function completeWithinTimeout(judge: LLM, prompt: string, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`judge call exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([judge.complete(prompt), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface EvaluateBranchOptions {
  task: string;
  /** The branch proposal. Its fenced code is parsed centrally against the executor. */
  trajectory: string;
  /** Sibling proposals from the same expansion — judged relative to these. */
  siblings?: readonly string[];
  /** True when any sibling in this expansion produced runnable code. Caps a
   *  prose-only branch at the FAIL ceiling so declining to attempt code cannot
   *  beat a sibling that attempted it and failed (WP-A5 band loophole). */
  siblingsProducedCode?: boolean;
  /** Plan mode uses judge-only scoring and must never invoke the executor. */
  executionPolicy?: 'grounded' | 'judge-only';
  executor: Executor;
  /** Cross-model judge. Omitted → explorer judges (documented fallback). */
  judge?: LLM;
  explorer: LLM;
  /** Judge ensemble size (median-aggregated). Default 3. */
  judgeSamples?: number;
  /** Per-evaluation LLM-call budget: assertion generation + judge samples.
   *  The operator's spend dial — see DEFAULT_CONFIG.mcts.maxEvalLLMCalls. */
  maxLLMCalls?: number;
  /** Wall clock on each individual judge call, so a non-responding judge is
   *  dropped rather than hanging the whole search. Defaults to
   *  DEFAULT_JUDGE_CALL_TIMEOUT_MS. */
  judgeCallTimeoutMs?: number;
}

export interface BranchEvaluation {
  /** [0..1] — what the engine backpropagates. */
  score: number;
  /** How the score was grounded. */
  grounding: EvaluationGrounding;
  /** Execution verdict when grounding === 'execution'. */
  execution?: { passed: boolean; error?: string; assertionsGenerated: boolean };
  /** Present when the branch offered code this executor cannot run. */
  unrunnableLanguage?: string;
  /** Judge samples that parsed successfully (out of those attempted). Zero
   *  when the cascade short-circuited before the ensemble was sampled. */
  judgeSamplesUsed: number;
}

/** Engine messages for source that never became a program. The signatures are
 *  JavaScript-engine phrases; `syntaxerror` also covers interpreters that name
 *  their parse failures that way. Anything unrecognised deliberately falls
 *  through to judging instead of inventing a parse verdict. */
const PARSE_FAILURE_SIGNATURES = [
  'syntaxerror',
  'unexpected token',
  'unexpected end of input',
  'unexpected end of script',
  'unexpected identifier',
  'unexpected reserved word',
  'unexpected string',
  'invalid or unexpected token',
  'missing ) after',
  'missing } after',
] as const;

/** True when an execution error says the source did not parse. */
export function isParseFailure(error: string): boolean {
  const text = error.toLowerCase();
  return PARSE_FAILURE_SIGNATURES.some((sig) => text.includes(sig));
}

/**
 * Cascade stage 0's verdict: did THIS BRANCH's code fail to parse?
 *
 * The judge-written assertion harness shares the branch's parse unit, so a bad
 * assertion snippet fails the whole run with a parse error that is not the
 * branch's fault. When assertions were appended, the code is re-run alone to
 * attribute the failure before the branch is charged with it — one extra
 * sandbox call, only ever on the already-failing path, and never on the path
 * where the branch keeps its judge ensemble.
 */
async function codeFailedToParse(
  executor: Executor,
  execution: NonNullable<BranchEvaluation['execution']>,
  code: string,
  language: string,
): Promise<boolean> {
  if (execution.passed || !execution.error || !isParseFailure(execution.error)) return false;
  if (!execution.assertionsGenerated) return true;
  const bare = await runForVerdict(executor, code, null, language);
  return !bare.passed && !!bare.error && isParseFailure(bare.error);
}

export async function evaluateWithMultiModelJudging(
  opts: EvaluateBranchOptions,
): Promise<BranchEvaluation> {
  const trajectory = opts.trajectory.trim();
  // A branch that produced nothing (failed exploration) is dead — spend no
  // judge calls on it.
  if (trajectory.length === 0) {
    return { score: 0, grounding: 'judge', judgeSamplesUsed: 0 };
  }

  const defaults = DEFAULT_CONFIG.mcts;
  const judgeSamples = Math.max(1, opts.judgeSamples ?? defaults.judgeSamples);
  const maxLLMCalls = Math.max(1, opts.maxLLMCalls ?? defaults.maxEvalLLMCalls);
  const judge = opts.judge ?? opts.explorer;
  const judgeTimeoutMs = opts.judgeCallTimeoutMs ?? DEFAULT_JUDGE_CALL_TIMEOUT_MS;

  const proposal = opts.executionPolicy === 'judge-only'
    ? null
    : readProposalCode(trajectory, opts.executor.languages);

  // Layer 1: execution grounding. Assertion generation costs 1 LLM call and
  // only runs when the budget leaves room for at least 1 judge sample.
  let execution: BranchEvaluation['execution'];
  let llmCallsLeft = maxLLMCalls;
  if (proposal?.kind === 'runnable') {
    const { code, language } = proposal;
    let assertions: string | null = null;
    if (llmCallsLeft >= 2) {
      llmCallsLeft--;
      assertions = await generateAssertions(judge, opts.task, code, language, judgeTimeoutMs);
    }
    execution = await runForVerdict(opts.executor, code, assertions, language);
    // Cascade stage 0: source that never parsed has decided its own verdict.
    // Spend no judge calls placing it inside a band it cannot leave.
    if (await codeFailedToParse(opts.executor, execution, code, language)) {
      return { score: FAIL_FLOOR, grounding: 'execution', execution, judgeSamplesUsed: 0 };
    }
  }

  // Layer 2: judge ensemble (median, parse-failure-robust).
  const k = Math.min(judgeSamples, llmCallsLeft);
  const prompt = buildJudgePrompt(opts.task, trajectory, opts.siblings ?? [], execution);
  const samples = await Promise.all(
    Array.from({ length: k }, () => sampleJudgeScore(judge, prompt, judgeTimeoutMs)),
  );
  const parsed = samples.filter((s): s is number => s !== null);
  const judgeScore = parsed.length > 0 ? median(parsed) : null;

  if (execution) {
    const score = execution.passed
      ? PASS_FLOOR + PASS_SPAN * (judgeScore ?? 0)
      : FAIL_FLOOR + FAIL_SPAN * (judgeScore ?? 0);
    return { score, grounding: 'execution', execution, judgeSamplesUsed: parsed.length };
  }
  if (proposal?.kind === 'unrunnable') {
    return {
      score: FAIL_CEIL * (judgeScore ?? 0),
      grounding: 'unrunnable',
      unrunnableLanguage: proposal.language,
      judgeSamplesUsed: parsed.length,
    };
  }
  // Prose-only: reduced confidence, and capped at the FAIL ceiling when a
  // sibling actually attempted code (WP-A5) — dodging execution must not
  // outscore attempting-and-failing.
  const proseCap = opts.siblingsProducedCode ? FAIL_CEIL : PROSE_CONFIDENCE;
  return {
    score: proseCap * (judgeScore ?? 0),
    grounding: 'judge',
    judgeSamplesUsed: parsed.length,
  };
}

/**
 * Ask the judge model to write assertions that exercise the code against the
 * task. Returns null (bare run) when the judge declines or produces no code
 * block — assertion generation is best-effort, never a hard dependency.
 *
 * Exported so the convergence tie-break (mcts/test-selection.ts, DO-NOW #3)
 * generates ONE discriminating harness reused across the near-tied candidates.
 */
export async function generateAssertions(
  judge: LLM,
  task: string,
  code: string,
  language: string,
  timeoutMs: number = DEFAULT_JUDGE_CALL_TIMEOUT_MS,
): Promise<string | null> {
  const prompt = `You are writing a verification harness for code proposed by another agent.

Task the code is meant to solve:
${evidenceWindow(task, EVIDENCE_BUDGETS.judgeTask)}

Proposed ${language} code:
\`\`\`${language}
${evidenceWindow(code, EVIDENCE_BUDGETS.assertionCode)}
\`\`\`

Write a SHORT ${language} snippet that runs AFTER the code above in the same
scope and raises or throws if the code does not satisfy the task. If the code
defines functions, call them with representative inputs and check the outputs.
No imports, no network, no printing — just exercise and fail loudly.

Reply with ONLY a \`\`\`${language} code block. If the code cannot be meaningfully
verified by assertions, reply with exactly: UNVERIFIABLE`;

  try {
    const text = await completeWithinTimeout(judge, prompt, timeoutMs);
    if (/^\s*UNVERIFIABLE\s*$/.test(text)) return null;
    const assertion = readProposalCode(text, [language]);
    return assertion?.kind === 'runnable' ? assertion.code : null;
  } catch {
    return null;
  }
}

/**
 * Run the branch's code (plus generated assertions, sharing its scope) as
 * plain statements in the selected language. Executors surface thrown errors
 * and non-zero interpreter exits through ExecuteResult.error. A throwing
 * executor counts as a failed run, consistent with "failures never look neutral".
 * Known limit: a top-level `return` inside the proposed code skips appended
 * assertions (the bare run still grounds syntax/runtime errors).
 */
export async function runForVerdict(
  executor: Executor,
  code: string,
  assertions: string | null,
  language: string,
): Promise<NonNullable<BranchEvaluation['execution']>> {
  const harness = assertions ? `${code}\n\n${assertions}` : code;
  try {
    const { error } = await executor.execute(harness, [], { language });
    return error
      ? { passed: false, error, assertionsGenerated: assertions !== null }
      : { passed: true, assertionsGenerated: assertions !== null };
  } catch (e) {
    return {
      passed: false,
      error: e instanceof Error ? e.message : String(e),
      assertionsGenerated: assertions !== null,
    };
  }
}

function buildJudgePrompt(
  task: string,
  trajectory: string,
  siblings: readonly string[],
  execution: BranchEvaluation['execution'],
): string {
  const siblingBlock = siblings
    .filter((s) => s.trim().length > 0)
    .slice(0, 4)
    .map((s, i) => `${i + 1}. ${evidenceWindow(s, EVIDENCE_BUDGETS.judgeSibling)}`)
    .join('\n');

  const executionBlock = execution
    ? execution.passed
      ? '\nExecution evidence: the candidate\'s code was run and PASSED.\n'
      : `\nExecution evidence: the candidate's code was run and FAILED: ${evidenceWindow(execution.error ?? 'unknown error', EVIDENCE_BUDGETS.judgeExecutionError)}\n`
    : '';

  return `You are scoring ONE candidate approach produced during a tree search over competing approaches.

Task:
${evidenceWindow(task, EVIDENCE_BUDGETS.judgeTask)}

Candidate approach:
${evidenceWindow(trajectory, EVIDENCE_BUDGETS.judgeTrajectory)}
${siblingBlock ? `\nSibling approaches competing in the same expansion (calibration only — do NOT score them):\n${siblingBlock}\n` : ''}${executionBlock}
Score the CANDIDATE from 0.0 to 1.0 for how well it solves the Task:
- correctness and completeness with respect to the Task (dominant criterion)
- concreteness: a specific, actionable approach beats vague prose
- relative quality: would you pick it over the siblings listed above?

JSON shape:
{"score": <float 0.0-1.0>, "rationale": "<15 words max>"}
${jsonObjectOnlyInstruction()}`;
}

/** One judge sample. Unparseable or failed samples are DROPPED (null), never
 *  scored 0 — a single flaky parse must not crater the ensemble median. */
async function sampleJudgeScore(judge: LLM, prompt: string, timeoutMs: number): Promise<number | null> {
  let text: string;
  try {
    text = await completeWithinTimeout(judge, prompt, timeoutMs);
  } catch {
    return null;
  }
  try {
    const parsed = v.parse(v.object({
      score: v.union([v.number(), v.string()]),
    }), extractJsonObject(text));
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    return Math.min(1, Math.max(0, score));
  } catch {
    return null;
  }
}

/** Median of a non-empty list. Shared with the heads k-sample merge
 *  (heads/controller.ts) so both ensembles aggregate identically. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
