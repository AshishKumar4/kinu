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
import type { LLM, Executor } from '../types/primitives';
import type { EvaluationGrounding } from '../types/evaluation';
import { fencedBlocks, readProposalCode } from '../execution/code-fence';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { renderThrownChain, tolerate } from '../obs/index';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { DEFAULT_CONFIG, TURN_WALL_CLOCK_ENVELOPE_MS } from '../config';

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
 * A timed-out judge is DROPPED (see sampleJudgeScore / generateAssertionSuite), so
 * the ensemble degrades to the samples that did answer instead of the search
 * dying. That is exactly why the number has to be generous rather than prudent: a
 * bound under a real completion's latency does not error, it shrinks the ensemble
 * invisibly, and a median over the two samples that answered is not the ensemble
 * the caller asked for. A judge that FAILS is not the same thing and is not
 * dropped: it propagates to the engine's allSettled, which reports branch-failed
 * with the reason and scores the branch 0.
 *
 * So one completion gets the same envelope as the whole turn it is part of —
 * {@link TURN_WALL_CLOCK_ENVELOPE_MS}, whose 509 s longest measured turn is an
 * upper bound on any single call inside one. This was 120_000, which is under
 * every turn in that measurement and was never checked against a completion's
 * latency at all. Override per-evaluation via
 * EvaluateBranchOptions.judgeCallTimeoutMs.
 */
export const DEFAULT_JUDGE_CALL_TIMEOUT_MS = TURN_WALL_CLOCK_ENVELOPE_MS;

/** `judge.complete`, bounded. Returns null when the provider does not answer
 *  within `timeoutMs` — the timeout is the ensemble's own envelope, so it is a
 *  value here rather than a throw nobody can tell from a broken provider. The
 *  underlying call cannot be cancelled without an abort signal the LLM seam
 *  does not carry, but losing the race unblocks the evaluator, which is the
 *  freeze this fixes. */
async function completeWithinTimeout(judge: LLM, prompt: string, timeoutMs: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([judge.complete(prompt), timeout]);
  } finally {
    clearTimeout(timer);
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
  /** REQUESTED judge ensemble size (median-aggregated). Default 3. Not what the
   *  branch necessarily gets: `maxLLMCalls` clamps it, and the realised size
   *  comes back as `judgeSamplesAttempted`. See {@link judgeCallBudget}. */
  judgeSamples?: number;
  /** Per-evaluation LLM-call budget: check generation + judge samples, sharing
   *  ONE pool. The operator's spend dial — see
   *  DEFAULT_CONFIG.mcts.maxEvalLLMCalls — and the ceiling on `judgeSamples`. */
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
  /** Execution verdict when grounding === 'execution'. `passedChecks` /
   *  `totalChecks` are present only when a check suite was generated and run —
   *  absent means no fraction was measured, which is not the same claim as a
   *  fraction of zero, so the caller falls back to the judge for position
   *  inside the band. */
  execution?: {
    passed: boolean;
    passedChecks?: number;
    totalChecks?: number;
    error?: string;
    assertionsGenerated: boolean;
  };
  /** Present when the branch offered code this executor cannot run. */
  unrunnableLanguage?: string;
  /** The ensemble size actually SAMPLED — the caller's request after the
   *  per-evaluation call budget clamped it (see {@link judgeEnsembleSize}).
   *  Zero only when the cascade short-circuited before the ensemble was
   *  reached, which is why it sits beside the next field: `judgeSamplesUsed: 0`
   *  with a non-zero `judgeSamplesAttempted` is an ensemble that answered
   *  nothing usable, and "never asked" is not the same fact as "asked and got
   *  nothing back". */
  judgeSamplesAttempted: number;
  /** Judge samples that parsed successfully, out of those attempted. */
  judgeSamplesUsed: number;
}

/**
 * The environment's reply to a branch's proposal, in one sentence — or null
 * when the branch never reached the environment (prose, plan mode, a language
 * this executor cannot run).
 *
 * LATS's expansion step is `action → environment → observation`, and the
 * observation is fed BACK: §5.2 runs each candidate solution against a
 * generated assert suite and adds "successful and failed tests and compiler
 * output ... to the context as an observation". This verdict was already
 * computed to pick the score band; rendering it is what lets the engine put it
 * where the paper puts it — into the trajectory a child expansion inherits and
 * into the post-mortem a failed branch writes — for no extra model call.
 */
export function executionObservation(execution: BranchEvaluation['execution']): string | null {
  if (!execution) return null;
  const { passedChecks, totalChecks } = execution;
  const tally = totalChecks !== undefined && passedChecks !== undefined
    ? ` and passed ${passedChecks} of ${totalChecks} generated checks`
    : execution.assertionsGenerated ? ' against generated assertions' : '';
  if (execution.passed) return `the proposed code ran${tally || ''} and PASSED.`;
  const error = execution.error
    ? evidenceWindow(execution.error, EVIDENCE_BUDGETS.judgeExecutionError)
    : 'no error text was reported';
  return totalChecks !== undefined && passedChecks !== undefined
    ? `the proposed code ran and passed ${passedChecks} of ${totalChecks} generated checks; the first failure was: ${error}`
    : `the proposed code ran and FAILED: ${error}`;
}

/** The measured share of generated checks a branch's code satisfied, or null
 *  when no suite ran. This is LATS's backpropagated numerator
 *  (`passed_test_count / len(tests)`, programming/mcts.py) and the only
 *  within-band signal here that is not a model's opinion. */
export function checkFraction(execution: BranchEvaluation['execution']): number | null {
  const total = execution?.totalChecks;
  const passed = execution?.passedChecks;
  if (total === undefined || passed === undefined || total === 0) return null;
  return passed / total;
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
  const bare = await runForVerdict(executor, code, [], language);
  return !bare.passed && !!bare.error && isParseFailure(bare.error);
}

/** How an evaluation's LLM-call budget divides between check generation and the
 *  judge ensemble. */
export interface JudgeCallBudget {
  /** Samples the ensemble is actually asked for — the caller's REQUEST after the
   *  budget clamped it. */
  readonly ensemble: number;
  /** True when one call goes to generating the check suite before the ensemble. */
  readonly generatesChecks: boolean;
}

/**
 * Split one evaluation's LLM-call budget — and with it, decide the judge
 * ensemble a branch actually gets.
 *
 * `judgeSamples` and `maxEvalLLMCalls` are not independent knobs. The second is
 * the WHOLE per-evaluation budget, and on a code-bearing branch one of those
 * calls buys the generated check suite, so the ensemble is bounded by what is
 * left. A budget of 1 buys no suite: an unjudged branch is worse than an
 * unchecked one.
 *
 * On shipped defaults (judgeSamples 3, maxEvalLLMCalls 4) a code branch realises
 * `min(3, 4 - 1) = 3` and a prose branch `min(3, 4) = 3` — the clamp already
 * sits flush against the default request, so it binds the instant the request
 * rises. A caller asking for 20 is answered by 3, and until this function
 * existed that happened with no field anywhere carrying the 3.
 *
 * Exported because three seams must agree on the split: the evaluator, which
 * spends the calls; the engine, which discloses the realised ensemble on the
 * run; and the run read model, which states it without re-running the search.
 */
export function judgeCallBudget(opts: {
  judgeSamples: number;
  maxLLMCalls: number;
  /** True when the branch offers code this executor can run, so its evaluation
   *  spends a call on check generation before the ensemble. */
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
  // A branch that produced nothing (failed exploration) is dead — spend no
  // judge calls on it.
  if (trajectory.length === 0) {
    return { score: 0, grounding: 'judge', judgeSamplesAttempted: 0, judgeSamplesUsed: 0 };
  }

  const defaults = DEFAULT_CONFIG.mcts;
  const maxLLMCalls = Math.max(1, opts.maxLLMCalls ?? defaults.maxEvalLLMCalls);
  const judge = opts.judge ?? opts.explorer;
  const judgeTimeoutMs = opts.judgeCallTimeoutMs ?? DEFAULT_JUDGE_CALL_TIMEOUT_MS;

  const proposal = opts.executionPolicy === 'judge-only'
    ? null
    : readProposalCode(trajectory, opts.executor.languages);
  // Decided before a call is spent, and reported on every return below, so the
  // clamp cannot bind in silence.
  const { ensemble: k, generatesChecks } = judgeCallBudget({
    judgeSamples: opts.judgeSamples ?? defaults.judgeSamples,
    maxLLMCalls,
    offersRunnableCode: proposal?.kind === 'runnable',
  });

  // Layer 1: execution grounding.
  let execution: BranchEvaluation['execution'];
  if (proposal?.kind === 'runnable') {
    const { code, language } = proposal;
    let checks: readonly string[] = [];
    if (generatesChecks) {
      checks = await generateAssertionSuite(judge, opts.task, code, language, judgeTimeoutMs);
    }
    execution = await runForVerdict(opts.executor, code, checks, language);
    // Cascade stage 0: source that never parsed has decided its own verdict.
    // Spend no judge calls placing it inside a band it cannot leave.
    if (await codeFailedToParse(opts.executor, execution, code, language)) {
      return {
        score: FAIL_FLOOR, grounding: 'execution', execution,
        judgeSamplesAttempted: 0, judgeSamplesUsed: 0,
      };
    }
  }

  // Layer 2: judge ensemble (median, parse-failure-robust).
  const prompt = buildJudgePrompt(opts.task, trajectory, opts.siblings ?? [], execution);
  const samples = await Promise.all(
    Array.from({ length: k }, () => sampleJudgeScore(judge, prompt, judgeTimeoutMs)),
  );
  const parsed = samples.filter((s): s is number => s !== null);
  const judgeScore = parsed.length > 0 ? median(parsed) : null;

  if (execution) {
    // Inside the fail band the MEASURED share of checks that held positions the
    // branch, and the judge is not consulted for it. That share is LATS's
    // backpropagated reward, and it is the difference between a search with a
    // gradient and one without: every failing branch used to land at
    // FAIL_FLOOR + FAIL_SPAN·judge, so "three of four aspects correct" and
    // "nothing works" were separated only by judge noise — which is the binary
    // reward this repo already measured degenerates a search toward best-of-n
    // (test-utils/src/eval-outcome.ts). The judge still positions inside the
    // PASS band, where the fraction is 1 by construction and carries nothing,
    // and inside the fail band only when no suite ran.
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
  // Prose-only: reduced confidence, and capped at the FAIL ceiling when a
  // sibling actually attempted code (WP-A5) — dodging execution must not
  // outscore attempting-and-failing.
  const proseCap = opts.siblingsProducedCode ? FAIL_CEIL : PROSE_CONFIDENCE;
  return {
    score: proseCap * (judgeScore ?? 0),
    grounding: 'judge',
    judgeSamplesAttempted: k,
    judgeSamplesUsed: parsed.length,
  };
}

/**
 * How many independent checks the judge is asked for.
 *
 * Four, matching LATS's programming setup ("we set the number of generated
 * tests at 4", §5.2). Each check costs one executor call and no model call, so
 * this bounds sandbox round-trips per branch, not spend.
 */
export const MAX_GENERATED_CHECKS = 4;

/**
 * Ask the judge model for INDEPENDENT checks that exercise the code against the
 * task — one fence per check, so each can be run and scored on its own.
 *
 * Independence is the whole point. A single blob throws on its first failing
 * assertion, which makes every partial success indistinguishable from total
 * failure and leaves a judge as the only within-band signal. Separate checks
 * give a MEASURED fraction, which is what LATS backpropagates
 * (`passed_test_count / len(tests)`) and what this repo's own outcome contract
 * demands: a pass/fail bit gives a search nothing to climb
 * (test-utils/src/eval-outcome.ts).
 *
 * Empty when the judge declines, does not answer inside its envelope, or emits
 * no usable fence — generation is best-effort, never a hard dependency. A judge
 * that FAILS is a fault and propagates: a branch must not be run bare because
 * the provider is broken.
 *
 * Exported so the convergence tie-break (mcts/test-selection.ts) generates ONE
 * suite reused across the near-tied candidates.
 */
export async function generateAssertionSuite(
  judge: LLM,
  task: string,
  code: string,
  language: string,
  timeoutMs: number = DEFAULT_JUDGE_CALL_TIMEOUT_MS,
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

  const text = await completeWithinTimeout(judge, prompt, timeoutMs);
  if (text === null || /^\s*UNVERIFIABLE\s*$/.test(text)) return [];
  return fencedBlocks(text)
    .filter((block) => (block.language ?? language) === language)
    .map((block) => block.code)
    .slice(0, MAX_GENERATED_CHECKS);
}

/**
 * Run the branch's code against each generated check SEPARATELY and report how
 * many held.
 *
 * One execution per check rather than one execution of all of them: appended
 * together, the first throw hides every later check, so "one of four aspects is
 * wrong" and "nothing works" produce the identical observation. Executor calls
 * cost no tokens, so the fraction is bought with sandbox round-trips.
 *
 * With no checks the run is bare — syntax and runtime errors are still grounded,
 * but there is no fraction and the caller falls back to the judge for position
 * inside the band.
 *
 * Executors surface thrown errors and non-zero interpreter exits through
 * ExecuteResult.error; a throwing executor counts as a failed run, consistent
 * with "failures never look neutral". Known limit: a top-level `return` inside
 * the proposed code skips the appended check.
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
  // The first failure, not a join: the judge prompt and the child's inherited
  // observation both want one legible cause, and four copies of the same
  // TypeError is what a whole-suite join produces when the code is simply broken.
  if (failures[0] !== undefined) verdict.error = failures[0];
  return verdict;
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

const JudgeScoreSchema = v.object({ score: v.union([v.number(), v.string()]) });

/** One judge sample. A sample the judge did not answer inside its envelope, or
 *  whose text is not a score object, is DROPPED (null), never scored 0 — a
 *  single flaky parse must not crater the ensemble median. Anything else is a
 *  fault and propagates: the engine reports it as branch-failed. */
async function sampleJudgeScore(judge: LLM, prompt: string, timeoutMs: number): Promise<number | null> {
  const text = await completeWithinTimeout(judge, prompt, timeoutMs);
  if (text === null) return null;
  const json = tolerate(() => extractJsonObject(text), 'malformed-input');
  if (json === undefined) return null;
  const parsed = v.safeParse(JudgeScoreSchema, json);
  if (!parsed.success) return null;
  const score = Number(parsed.output.score);
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : null;
}

/** Median of a non-empty list. Shared with the heads k-sample merge
 *  (heads/controller.ts) so both ensembles aggregate identically. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
