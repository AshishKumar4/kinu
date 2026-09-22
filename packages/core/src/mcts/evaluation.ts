/**
 * Grounded branch evaluation: the one MCTS scorer, called from the engine's EVALUATE phase on every backend.
 * Execution picks the band, the judge ensemble (median, unparsed samples dropped) places within it.
 * Band table (WP-A5):
 *   code passed 0.60 + 0.40·j; code failed 0.05 + 0.25·j; code did not parse 0.05 (no judge);
 *   unrunnable language 0.30·j; prose 0.75·j, or 0.30·j when a sibling has code.
 * Thresholds in config.ts are pinned to these band boundaries.
 * All judge samples failing yields the band floor: infrastructure failure must look bad, never neutral.
 * Model self-selection plateaus ~55% vs 99% oracle (arXiv:2602.18998); verifier quality,
 * not search, is the bottleneck (Koh et al. arXiv:2407.01476).
 */

/** No elapsed deadline on judge calls (owner ruling, 2026-08); spend is bounded by call count. */

const PASS_FLOOR = 0.6;

const PASS_SPAN = 0.4;

const FAIL_FLOOR = 0.05;

const FAIL_SPAN = 0.25;

/** Top of the fail band; also the cap for prose when siblings attempted code. */
const FAIL_CEIL = FAIL_FLOOR + FAIL_SPAN;

const PROSE_CONFIDENCE = 0.75;

import * as v from 'valibot';
import type { LLM, Executor } from '../types/primitives';
import type { EvaluationGrounding } from '../types/evaluation';
import { fencedBlocks, readProposalCode } from '../execution/code-fence';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { renderThrownChain, tolerate } from '../obs/index';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { DEFAULT_CONFIG } from '../config';

export interface EvaluateBranchOptions {
  task: string;
  trajectory: string;
  siblings?: readonly string[];
  /** True when any sibling produced runnable code; caps prose-only branches at the fail ceiling (WP-A5). */
  siblingsProducedCode?: boolean;
  executionPolicy?: 'grounded' | 'judge-only';
  executor: Executor;
  /** Cross-model judge; omitted means the explorer judges (arXiv:2306.05685 self-enhancement bias). */
  judge?: LLM;
  explorer: LLM;
  /** Requested judge ensemble size; `maxLLMCalls` may clamp it (see {@link judgeCallBudget}). */
  judgeSamples?: number;
  /** Per-evaluation LLM-call pool shared by check generation and judge samples. */
  maxLLMCalls?: number;
}

export interface BranchEvaluation {
  score: number;
  grounding: EvaluationGrounding;
  /** Execution verdict. `passedChecks`/`totalChecks` absent means no fraction was measured, not zero. */
  execution?: {
    passed: boolean;
    passedChecks?: number;
    totalChecks?: number;
    error?: string;
    assertionsGenerated: boolean;
  };
  unrunnableLanguage?: string;
  /** Judge samples actually requested after the budget clamp; zero only when the cascade short-circuited. */
  judgeSamplesAttempted: number;
  judgeSamplesUsed: number;
}

function checkTally(passedChecks: number | undefined, totalChecks: number | undefined, generated: boolean): string {
  if (totalChecks !== undefined && passedChecks !== undefined) {
    return ` and passed ${passedChecks} of ${totalChecks} generated checks`;
  }

  if (generated) return ' against generated assertions';

  return '';
}

/**
 * The environment's one-sentence reply to a proposal, or null when it never ran; fed back into the
 * child's trajectory and the post-mortem as LATS §5.2 does.
 */
export function executionObservation(execution: BranchEvaluation['execution']): string | null {
  if (!execution) return null;
  const { passedChecks, totalChecks } = execution;

  const tally = checkTally(passedChecks, totalChecks, execution.assertionsGenerated);

  if (execution.passed) return `the proposed code ran${tally || ''} and PASSED.`;

  const error = execution.error
    ? evidenceWindow(execution.error, EVIDENCE_BUDGETS.judgeExecutionError)
    : 'no error text was reported';

  return totalChecks !== undefined && passedChecks !== undefined
    ? `the proposed code ran and passed ${passedChecks} of ${totalChecks} generated checks; the first failure was: ${error}`
    : `the proposed code ran and FAILED: ${error}`;
}

/** Measured share of generated checks passed, or null when no suite ran (LATS's backpropagated numerator). */
export function checkFraction(execution: BranchEvaluation['execution']): number | null {
  const total = execution?.totalChecks;
  const passed = execution?.passedChecks;

  if (total === undefined || passed === undefined || total === 0) return null;

  return passed / total;
}

/** JavaScript-engine parse-failure phrases; anything unrecognised falls through to judging. */
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

export function isParseFailure(error: string): boolean {
  const text = error.toLowerCase();

  return PARSE_FAILURE_SIGNATURES.some((sig) => text.includes(sig));
}

/**
 * Cascade stage 0: did this branch's own code fail to parse? With appended assertions the code is
 * re-run alone so a bad assertion's parse error is not charged to the branch.
 */
async function codeFailedToParse(
  executor: Executor,
  execution: NonNullable<BranchEvaluation['execution']>,
  code: string,
  language: string,
): Promise<boolean> {
  if (execution.passed || !execution.error || !isParseFailure(execution.error)) return false;

  if (!execution.assertionsGenerated) return true;
  const bare = await runForVerdict(executor, code, [], language);

  return !bare.passed && bare.error !== undefined && isParseFailure(bare.error);
}

export interface JudgeCallBudget {
  readonly ensemble: number;
  readonly generatesChecks: boolean;
}

/**
 * Split one evaluation's LLM-call budget and decide the realised judge ensemble. A code branch spends
 * one call on the check suite; a budget of 1 buys no suite. Shared by evaluator, engine and read model.
 */
export function judgeCallBudget(opts: {
  judgeSamples: number;
  maxLLMCalls: number;
  offersRunnableCode: boolean;
}): JudgeCallBudget {
  const budget = Math.max(1, opts.maxLLMCalls);
  const generatesChecks = opts.offersRunnableCode && budget >= 2;

  return {
    ensemble: Math.min(Math.max(1, opts.judgeSamples), budget - (generatesChecks ? 1 : 0)),
    generatesChecks,
  };
}

export async function evaluateWithMultiModelJudging(
  opts: EvaluateBranchOptions,
): Promise<BranchEvaluation> {
  const trajectory = opts.trajectory.trim();

  // A branch that produced nothing is dead; spend no judge calls on it.
  if (trajectory.length === 0) {
    return { score: 0, grounding: 'judge', judgeSamplesAttempted: 0, judgeSamplesUsed: 0 };
  }

  const defaults = DEFAULT_CONFIG.mcts;
  const maxLLMCalls = Math.max(1, opts.maxLLMCalls ?? defaults.maxEvalLLMCalls);
  const judge = opts.judge ?? opts.explorer;

  const proposal = opts.executionPolicy === 'judge-only'
    ? null
    : readProposalCode(trajectory, opts.executor.languages);

  const { ensemble: k, generatesChecks } = judgeCallBudget({
    judgeSamples: opts.judgeSamples ?? defaults.judgeSamples,
    maxLLMCalls,
    offersRunnableCode: proposal?.kind === 'runnable',
  });

  let execution: BranchEvaluation['execution'];

  if (proposal?.kind === 'runnable') {
    const { code, language } = proposal;
    let checks: readonly string[] = [];

    if (generatesChecks) {
      checks = await generateAssertionSuite(judge, opts.task, code, language);
    }

    execution = await runForVerdict(opts.executor, code, checks, language);

    // Cascade stage 0: unparsed source has decided its verdict; skip the judge.
    if (await codeFailedToParse(opts.executor, execution, code, language)) {
      return {
        score: FAIL_FLOOR, grounding: 'execution', execution,
        judgeSamplesAttempted: 0, judgeSamplesUsed: 0,
      };
    }
  }

  const prompt = buildJudgePrompt(opts.task, trajectory, opts.siblings ?? [], execution);

  const samples = await Promise.all(
    Array.from({ length: k }, () => sampleJudgeScore(judge, prompt)),
  );

  const parsed = samples.filter((s): s is number => s !== null);
  const judgeScore = parsed.length > 0 ? median(parsed) : null;

  if (execution) {
    // In the fail band the measured check share positions the branch, not the judge; the judge places
    // within the pass band, and within the fail band only when no suite ran (test-utils/src/eval-outcome.ts).
    const fraction = checkFraction(execution);

    const score = execution.passed
      ? PASS_FLOOR + PASS_SPAN * (judgeScore ?? 0)
      : FAIL_FLOOR + FAIL_SPAN * (fraction ?? judgeScore ?? 0);

    return {
      score, grounding: 'execution', execution,
      judgeSamplesAttempted: k, judgeSamplesUsed: parsed.length,
    };
  }

  if (proposal?.kind === 'unrunnable') {
    return {
      score: FAIL_CEIL * (judgeScore ?? 0),
      grounding: 'unrunnable',
      unrunnableLanguage: proposal.language,
      judgeSamplesAttempted: k,
      judgeSamplesUsed: parsed.length,
    };
  }

  // Prose-only: reduced confidence, capped at the fail ceiling when a sibling attempted code (WP-A5).
  const proseCap = opts.siblingsProducedCode ? FAIL_CEIL : PROSE_CONFIDENCE;

  return {
    score: proseCap * (judgeScore ?? 0),
    grounding: 'judge',
    judgeSamplesAttempted: k,
    judgeSamplesUsed: parsed.length,
  };
}

/** Independent checks requested per branch, matching LATS §5.2; bounds executor calls, not spend. */
export const MAX_GENERATED_CHECKS = 4;

/**
 * Ask the judge for independent checks, one fence each, so a measured pass fraction exists. Empty when
 * the judge declines or answers UNVERIFIABLE; a failing judge call propagates. Shared with test-selection.ts.
 */
export async function generateAssertionSuite(
  judge: LLM,
  task: string,
  code: string,
  language: string,
): Promise<readonly string[]> {
  const prompt = `You are writing a verification harness for code proposed by another agent.

Task the code is meant to solve:
${evidenceWindow(task, EVIDENCE_BUDGETS.judgeTask)}

Proposed ${language} code:
\`\`\`${language}
${evidenceWindow(code, EVIDENCE_BUDGETS.assertionCode)}
\`\`\`

Write up to ${MAX_GENERATED_CHECKS} INDEPENDENT checks of the code above. Reply
with one \`\`\`${language} code block per check, and nothing else.

Each block runs SEPARATELY, appended after the code above in the same scope, and
must raise or throw if that one aspect of the task is unsatisfied. Make them
independent: each block must stand alone, check a DIFFERENT property, and not
depend on another block having run. If the code defines functions, call them
with representative inputs and check the outputs. No imports, no network, no
printing — just exercise and fail loudly.

If the code cannot be meaningfully verified by assertions, reply with exactly:
UNVERIFIABLE`;

  const text = await judge.complete(prompt);

  if (/^\s*UNVERIFIABLE\s*$/.test(text)) return [];

  return fencedBlocks(text)
    .filter((block) => (block.language ?? language) === language)
    .map((block) => block.code)
    .slice(0, MAX_GENERATED_CHECKS);
}

/**
 * Run the branch's code against each check separately and count passes. With no checks the run is bare.
 * A throwing executor counts as failed. Known limit: a top-level `return` skips the appended check.
 */
export async function runForVerdict(
  executor: Executor,
  code: string,
  checks: readonly string[],
  language: string,
): Promise<NonNullable<BranchEvaluation['execution']>> {
  const run = async (source: string): Promise<string | null> => {
    try {
      const { error } = await executor.execute(source, [], { language });

      return error ?? null;
    } catch (e) {
      return renderThrownChain({ cause: e });
    }
  };

  if (checks.length === 0) {
    const error = await run(code);

    return error === null
      ? { passed: true, assertionsGenerated: false }
      : { passed: false, error, assertionsGenerated: false };
  }

  const errors = await Promise.all(checks.map((check) => run(`${code}\n\n${check}`)));
  const failures = errors.filter((error): error is string => error !== null);
  const passedChecks = errors.length - failures.length;

  const verdict: NonNullable<BranchEvaluation['execution']> = {
    passed: failures.length === 0,
    passedChecks,
    totalChecks: errors.length,
    assertionsGenerated: true,
  };

  if (failures[0] !== undefined) verdict.error = failures[0];

  return verdict;
}

function executionEvidence(execution: BranchEvaluation['execution']): string {
  if (!execution) return '';

  if (execution.passed) return '\nExecution evidence: the candidate\'s code was run and PASSED.\n';

  const why = evidenceWindow(execution.error ?? 'unknown error', EVIDENCE_BUDGETS.judgeExecutionError);

  return `\nExecution evidence: the candidate's code was run and FAILED: ${why}\n`;
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

  const executionBlock = executionEvidence(execution);

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

const JudgeScoreSchema = v.object({ score: v.union([v.number(), v.string()]) });

/** One judge sample; unparseable text is dropped (null), never scored 0. A failed call propagates. */
async function sampleJudgeScore(judge: LLM, prompt: string): Promise<number | null> {
  const text = await judge.complete(prompt);
  const json = tolerate(() => extractJsonObject(text), 'malformed-input');

  if (json === undefined) return null;
  const parsed = v.safeParse(JudgeScoreSchema, json);

  if (!parsed.success) return null;
  const score = Number(parsed.output.score);

  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : null;
}

/** Median of a non-empty list; shared with heads/controller.ts so both ensembles aggregate identically. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
