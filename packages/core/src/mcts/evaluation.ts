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

import type { LLM, Executor } from '../types/primitives.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { DEFAULT_CONFIG } from '../config.js';

/** Score bands. Execution verdicts dominate: fail ceiling < pass floor, and
 *  prose confidence is capped below a passing branch with a median judge. */
const PASS_FLOOR = 0.6;
const PASS_SPAN = 0.4;
const FAIL_FLOOR = 0.05;
const FAIL_SPAN = 0.25;
const PROSE_CONFIDENCE = 0.75;

export interface EvaluateBranchOptions {
  task: string;
  /** The branch's exploration output (proposal text / trajectory). */
  trajectory: string;
  /** Code the branch extracted, if any. Falls back to the last JS-family
   *  code fence in the trajectory. */
  codeUsed?: string | null;
  /** Sibling proposals from the same expansion — judged relative to these. */
  siblings?: readonly string[];
  executor: Executor;
  /** Cross-model judge. Omitted → explorer judges (documented fallback). */
  judge?: LLM;
  explorer: LLM;
  /** Judge ensemble size (median-aggregated). Default 3. */
  judgeSamples?: number;
  /** Per-evaluation LLM-call budget: assertion generation + judge samples.
   *  The operator's spend dial — see DEFAULT_CONFIG.mcts.maxEvalLLMCalls. */
  maxLLMCalls?: number;
}

export interface BranchEvaluation {
  /** [0..1] — what the engine backpropagates. */
  score: number;
  /** 'execution' when the branch's code actually ran; 'judge' when prose-only. */
  grounding: 'execution' | 'judge';
  /** Execution verdict when grounding === 'execution'. */
  execution?: { passed: boolean; error?: string; assertionsGenerated: boolean };
  /** Judge samples that parsed successfully (out of those attempted). */
  judgeSamplesUsed: number;
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

  const code = opts.codeUsed?.trim() || extractCode(trajectory);

  // Layer 1: execution grounding. Assertion generation costs 1 LLM call and
  // only runs when the budget leaves room for at least 1 judge sample.
  let execution: BranchEvaluation['execution'];
  let llmCallsLeft = maxLLMCalls;
  if (code) {
    let assertions: string | null = null;
    if (llmCallsLeft >= 2) {
      llmCallsLeft--;
      assertions = await generateAssertions(judge, opts.task, code);
    }
    execution = await runForVerdict(opts.executor, code, assertions);
  }

  // Layer 2: judge ensemble (median, parse-failure-robust).
  const k = Math.min(judgeSamples, llmCallsLeft);
  const prompt = buildJudgePrompt(opts.task, trajectory, opts.siblings ?? [], execution);
  const samples = await Promise.all(
    Array.from({ length: k }, () => sampleJudgeScore(judge, prompt)),
  );
  const parsed = samples.filter((s): s is number => s !== null);
  const judgeScore = parsed.length > 0 ? median(parsed) : null;

  if (execution) {
    const score = execution.passed
      ? PASS_FLOOR + PASS_SPAN * (judgeScore ?? 0)
      : FAIL_FLOOR + FAIL_SPAN * (judgeScore ?? 0);
    return { score, grounding: 'execution', execution, judgeSamplesUsed: parsed.length };
  }
  return {
    score: PROSE_CONFIDENCE * (judgeScore ?? 0),
    grounding: 'judge',
    judgeSamplesUsed: parsed.length,
  };
}

/** Last JS-family code fence in the trajectory. Branch prompts ask for ```js;
 *  the executors are JS sandboxes, so other languages stay judge-only. */
function extractCode(trajectory: string): string | null {
  const blocks = [...trajectory.matchAll(/```(?:js|javascript|typescript|ts)\n([\s\S]*?)\n```/g)]
    .map((m) => m[1]!.trim())
    .filter((c) => c.length > 0);
  return blocks.length > 0 ? blocks[blocks.length - 1]! : null;
}

/**
 * Ask the judge model to write assertions that exercise the code against the
 * task. Returns null (bare run) when the judge declines or produces no code
 * block — assertion generation is best-effort, never a hard dependency.
 *
 * Exported so the convergence tie-break (mcts/test-selection.ts, DO-NOW #3)
 * generates ONE discriminating harness reused across the near-tied candidates.
 */
export async function generateAssertions(judge: LLM, task: string, code: string): Promise<string | null> {
  const prompt = `You are writing a verification harness for code proposed by another agent.

Task the code is meant to solve:
${task.slice(0, 1500)}

Proposed code:
\`\`\`js
${code.slice(0, 4000)}
\`\`\`

Write a SHORT JavaScript snippet that runs AFTER the code above in the same
scope and throws an Error if the code does not satisfy the task. If the code
defines functions, call them with representative inputs and check the outputs.
No imports, no network, no console — just exercise and throw on failure.

Reply with ONLY a \`\`\`js code block. If the code cannot be meaningfully
verified by assertions, reply with exactly: UNVERIFIABLE`;

  try {
    const text = await judge.complete(prompt);
    if (/^\s*UNVERIFIABLE\s*$/.test(text)) return null;
    const match = text.match(/```(?:js|javascript|typescript|ts)?\n([\s\S]*?)\n```/);
    const snippet = match?.[1]?.trim();
    return snippet && snippet.length > 0 ? snippet : null;
  } catch {
    return null;
  }
}

/**
 * Run the branch's code (plus generated assertions, sharing its scope) as
 * plain statements — both executors (codemode DynamicWorkerExecutor on CF,
 * the subprocess executor on CLI) wrap statements and surface a thrown error
 * via ExecuteResult.error. A throwing executor counts as a failed run:
 * conservative, and consistent with "failures never look neutral".
 * Known limit: a top-level `return` inside the proposed code skips appended
 * assertions (the bare run still grounds syntax/runtime errors).
 */
export async function runForVerdict(
  executor: Executor,
  code: string,
  assertions: string | null,
): Promise<NonNullable<BranchEvaluation['execution']>> {
  const harness = assertions ? `${code}\n\n${assertions}` : code;
  try {
    const { error } = await executor.execute(harness, []);
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
    .map((s, i) => `${i + 1}. ${s.slice(0, 400)}`)
    .join('\n');

  const executionBlock = execution
    ? execution.passed
      ? '\nExecution evidence: the candidate\'s code was run and PASSED.\n'
      : `\nExecution evidence: the candidate's code was run and FAILED: ${(execution.error ?? 'unknown error').slice(0, 300)}\n`
    : '';

  return `You are scoring ONE candidate approach produced during a tree search over competing approaches.

Task:
${task.slice(0, 1500)}

Candidate approach:
${trajectory.slice(0, 3000)}
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
async function sampleJudgeScore(judge: LLM, prompt: string): Promise<number | null> {
  let text: string;
  try {
    text = await judge.complete(prompt);
  } catch {
    return null;
  }
  try {
    const parsed = extractJsonObject(text) as { score?: unknown };
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    return Math.min(1, Math.max(0, score));
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
