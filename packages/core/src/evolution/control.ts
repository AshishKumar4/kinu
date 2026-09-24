/**
 * The scaffold evolution control plane: backend-neutral drivers over the evolution
 * primitives. A backend supplies only a {@link ScaffoldSurface}; everything else is
 * policy and lives here.
 */

import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import * as v from 'valibot';

import type { AgentRuntime } from '../types/agent-runtime';
import type { LLM, SqlExecutor } from '../types/primitives';
import type { AgentConfigStore } from '../config/store';
import { clampGepaEvalBudget } from '../config/store';
import { beginModelOperation, type ModelCallSink, type ModelOperationSink } from '../events/model-call';
import { normalizeUsage } from '../usage';
import { callAccountOf } from '../providers/quota';
import { effortFor } from '../strategy/effort';
import { evidenceWindow } from '../prompts/evidence-window';
import { EVIDENCE_BUDGETS } from '../types/evidence';
import { extractJsonObject, generateJson, jsonObjectOnlyInstruction } from '../prompts/structured';
import {
  runScaffold, scaffoldEventText,
  type ScaffoldRunOptions, type ScaffoldRunResult,
} from '../scaffold/executor';
import { modifyScaffold } from '../scaffold/modify';
import type { ScaffoldVersionView } from '../types/scaffold';
import type { ActorHandle } from '../identity/actor-handle';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import type { SessionHistory } from '../session/history';
import type { SessionTranscriptReader } from '../session/transcript';
import { listScaffoldArchive } from '../scaffold/archive';
import {
  DEFAULT_SHADOW_CONFIG, MAX_QUEUED_SHADOW_TRIALS, applyPromotionDecision, countQueuedShadowTrials,
  decidePromotion, dropQueuedShadowTrial, getPendingScaffold, listQueuedShadowTrials,
  purgeQueuedShadowTrials, queueShadowTrial, readScaffoldVersion,
  type ScaffoldDecisionEvents,
} from '../scaffold/shadow';
import type {
  ShadowTrialDrain, ShadowTrialPlan, ShadowTrialQueueOutcome, ShadowTrialTurn,
} from './types';
import {
  DEFAULT_AUTO_JUDGE_CONFIG, runAutoShadowEval,
} from '../scaffold/auto-judge';
import { buildOutcomeEvalSplit } from './eval-split';
import {
  describeSplitDegeneracy, renderOutcomeCriterion, FRESH_RESPONSE_RULE,
  type OutcomeEvalExpectation, type OutcomeScoringRule,
} from './outcomes';
import { runScaffoldGepa } from './gepa/scaffold-bridge';
import {
  runSectionGepa, findPromptSectionTarget, PROMPT_SECTION_TARGETS,
} from './gepa/section-bridge';
import {
  applyPromptSectionDecision, decidePromptSectionPromotion, firstPendingPromptSection,
  getPendingPromptSection, incumbentSectionSource, proposePromptSection, recordPromptSectionTrial,
  type ProposeSectionRefusal,
} from '../prompting/section-store';
import type { PromptSection } from '../prompting/template';
import {
  finishGepaRun, lastGepaRunPerTarget, makePersistingHooks, startGepaRun,
} from './gepa/persistence';
import { MetricScoreSchema, type EvalInstance, type MetricOutcome, type ReflectionLM } from './gepa/types';
import { scoreInterval, type ScoreInterval } from '../utils/stats';
import { nanoid } from '../utils/nanoid';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

export type { ScaffoldVersionView } from '../types/scaffold';

/**
 * The one per-backend part of this plane. Both sides build the ports with core
 * factories (`orchestrator/scaffold-host.ts`).
 */
export interface ScaffoldSurface {
  readonly llmStream: ScaffoldRunOptions['llmStream'];
  readonly callTool?: ScaffoldRunOptions['callTool'];
  readonly history?: ScaffoldRunOptions['history'];
  /** Absent means a scaffold that delegates gets the documented error. */
  readonly defaultInference?: ScaffoldRunOptions['defaultInference'];
}

/** The conversation a candidate's default loop replays. Empty means the backend
 *  reconstructs one from the task alone. */
export type ScaffoldReplayContext = readonly ModelMessage[];

export type JsonGenerator = <T>(opts: {
  schema: v.GenericSchema<unknown, T>;
  prompt: string;
}) => Promise<T>;

export interface ScaffoldControl {
  readonly rt: AgentRuntime;
  readonly events: ScaffoldDecisionEvents;
  readonly sql: SqlExecutor;
  /** The host's conversation store; eval splits read graded turns' text from it. */
  readonly history: SessionHistory;
  readonly config: Pick<
    AgentConfigStore,
    'getShadowSampleRate' | 'getAutoPromoteScaffold' | 'getGepaEvalBudget'
  >;
  /** Resolved per call against the task being run. `context` is the conversation the
     *  task was asked in, empty for one-shot operations. */
  /** `callScope` makes the rollout's tool call ids reproducible so the effect claim
     *  can dedupe a replay; omitted by callers with no durable identity. */
  readonly surface: (
    task: string, context?: ScaffoldReplayContext, callScope?: string,
  ) => ScaffoldSurface;
  readonly model: () => LanguageModel | Promise<LanguageModel>;
  /**
     * Must not be the chat model: a model grading its own candidates is
     * self-enhancement bias (arXiv:2306.05685).
     */
  readonly judge: JsonGenerator;
  /** Reports the reflection LM's calls as `reflection` spend; rollouts and judge report elsewhere. */
  readonly reportModelCall?: ModelCallSink;
  /** Operation lifecycle sink. Absent means in-flight work is unattributable. */
  readonly operations?: ModelOperationSink;
}

/** The graded turns all live in the default conversation. */
export function controlTranscript(control: ScaffoldControl): SessionTranscriptReader {
  return control.history.transcript(CHAT_SESSION_ID);
}

function scaffoldRunOptions(
  control: ScaffoldControl,
  task: string,
  extra: Partial<ScaffoldRunOptions>,
): ScaffoldRunOptions {
  const surface = control.surface(task);

  return {
    rt: control.rt,
    task,
    emit: () => undefined,
    llmStream: surface.llmStream,
    callTool: surface.callTool,
    history: surface.history,
    defaultInference: surface.defaultInference,
    ...extra,
  };
}

/**
 * Run a scaffold and return its text: with `candidateCode`, the GEPA metric's
 * rollout; without it, the live scaffold. No deadline: a candidate cut off early
 * would score as a bad candidate rather than be measured.
 */
export async function runScaffoldCaptureText(
  control: ScaffoldControl,
  task: string,
  candidateCode?: string,
): Promise<string> {
  let text = '';

  const result = await runScaffold(scaffoldRunOptions(control, task, {
    emit: (ev) => { text += scaffoldEventText(ev) ?? ''; },
    scaffoldCodeOverride: candidateCode,
  }));

  if (!result.ok && result.error) throw new Error(result.error);

  return text;
}

/**
 * Run the current scaffold for a one-shot task without injecting into the
 * conversation. `useShadowOverride` runs the pending version instead.
 */
export async function runScaffoldOnce(
  control: ScaffoldControl,
  task: string,
  opts?: { useShadowOverride?: boolean },
): Promise<ScaffoldRunResult> {
  const pending = opts?.useShadowOverride ? getPendingScaffold(control.sql, control.rt.actor) : null;
  const codeOverride = pending ? await readScaffoldVersion(control.rt, pending.version) : null;

  return runScaffold(scaffoldRunOptions(control, task, {
    scaffoldCodeOverride: codeOverride ?? undefined,
  }));
}

/**
 * {@link shadowTrialPlan} decides which candidate a turn is sampled against;
 * {@link queueTurnShadowTrial} records that plan. Split so a replay records the
 * same plan instead of deciding again against a moved rate or candidate.
 * The trial itself runs on the cadence lane ({@link runQueuedShadowTrials}), never
 * on the user's turn. The auto-evolution gate lives in EvolutionEngine.
 */
export function shadowTrialPlan(control: ScaffoldControl, turnKey: string): number | null {
  // An empty key would hash to a stable bias, and has no durable identity to record under.
  if (turnKey === '') return null;
  const sampleRate = control.config.getShadowSampleRate();

  if (sampleRate <= 0) return null;
  const pending = getPendingScaffold(control.sql, control.rt.actor);

  if (!pending) return null;

  if (sampleFraction(turnKey) >= sampleRate) return null;

  return pending.version;
}

/**
 * A stable fraction in [0, 1) from the turn id, so a repeated ask for an owed
 * decision answers the same while staying uniform across turns.
 */
function sampleFraction(turnKey: string): number {
  // FNV-1a, 32-bit: spreads short similar ids evenly; identical on every backend.
  let hash = 0x811c9dc5;

  for (let i = 0; i < turnKey.length; i++) {
    hash ^= turnKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash / 0x1_0000_0000;
}

/**
 * Synchronous and total: a lost trial must never fail its turn, so failures are
 * absorbed and named in the return value.
 */
export function queueTurnShadowTrial(
  control: ScaffoldControl,
  turn: ShadowTrialTurn,
  plan: ShadowTrialPlan,
): ShadowTrialQueueOutcome {
  try {
    const trial = {
      pendingVersion: plan.pendingVersion,
      // Passed whole: runAutoShadowEval applies the evidence budget once, and the pending
      // scaffold must answer the same question the live turn did.
      task: turn.task,
      currentOutput: turn.currentOutput,
      context: turn.context,
    };

    return queueShadowTrial(
      control.sql,
      control.rt.actor,
      plan.id === undefined ? trial : { ...trial, id: plan.id },
    );
  } catch (err) {
    diagnostics.failure(
      'evolution.shadow_trial_queue_failed',
      toKinuError({ doing: 'queue a shadow trial', cause: err, otherwise: 'io' }),
    );

    return 'failed';
  }
}

/**
 * Run every trial queued for the pending scaffold, then let the promotion gate read
 * the result. Cadence-lane only; the queue is durable across hosts. Trials for a
 * version no longer pending are discarded, and the loop stops once a decision applies.
 */
export async function runQueuedShadowTrials(control: ScaffoldControl): Promise<ShadowTrialDrain> {
  const pending = getPendingScaffold(control.sql, control.rt.actor);
  purgeQueuedShadowTrials(control.sql, control.rt.actor, pending?.version ?? null);

  if (!pending) return { trials: 0, applied: null };

  let trials = 0;
  let processed = 0;

  // Re-read between laps so trials queued mid-drain are included; the ceiling bounds
  // the pathological case.
  while (processed < MAX_QUEUED_SHADOW_TRIALS) {
    const batch = listQueuedShadowTrials(control.sql, control.rt.actor, pending.version);

    if (batch.length === 0) break;

    for (const trial of batch) {
      if (processed >= MAX_QUEUED_SHADOW_TRIALS) break;
      processed++;
      // Scoped on the queue row so a re-drive reproduces call ids and the effect claim
      // does not repeat external work.
      const surface = control.surface(trial.task, trial.context, trial.id);
      let applied: 'promote' | 'rollback' | null = null;

      try {
        const result = await runAutoShadowEval({
          rt: control.rt,
          events: control.events,
          task: trial.task,
          currentOutput: trial.currentOutput,
          judge: (prompt, schema) => control.judge({ schema, prompt }),
          llmStream: surface.llmStream,
          callTool: surface.callTool,
          history: surface.history,
          defaultInference: surface.defaultInference,
          config: { ...DEFAULT_AUTO_JUDGE_CONFIG, autoApply: control.config.getAutoPromoteScaffold() },
          // Keys the evaluation and gates the rollout, so an interruption before the delete
          // does not rerun the pending scaffold's tool calls.
          trialId: trial.id,
        });

        applied = result.applied ?? null;

        if (!result.skipped) trials++;
      } catch (err) {
        // An unscorable trial is dropped, not a reason to wedge the queue.
        diagnostics.failure(
          'evolution.shadow_trial_failed',
          toKinuError({ doing: 'run a queued shadow trial', cause: err, otherwise: 'unavailable' }),
          { trialId: trial.id },
        );
      }

      dropQueuedShadowTrial(control.sql, control.rt.actor, trial.id);

      if (applied) {
        purgeQueuedShadowTrials(control.sql, control.rt.actor, null);

        return { trials, applied };
      }
    }
  }

  return { trials, applied: null };
}

/** Preview a scaffold version from its VFS `agent.js.vN` backup. */
export async function previewScaffoldLive(
  control: ScaffoldControl,
  version: number,
  task: string,
): Promise<ScaffoldRunResult> {
  const codeOverride = await readScaffoldVersion(control.rt, version);

  if (codeOverride == null) {
    throw new Error(`previewScaffoldLive: no scaffold code found for v${version}`);
  }

  return runScaffold(scaffoldRunOptions(control, task, {
    scaffoldCodeOverride: codeOverride,
  }));
}

/**
 * Propose a new scaffold version through modifyScaffold's gates. It lands
 * `pending` and goes through shadow eval and the promotion gate like any other.
 */
export async function proposeScaffold(
  control: ScaffoldControl,
  rationale: string,
  code: string,
  baseVersion?: number,
): Promise<Awaited<ReturnType<typeof modifyScaffold>>> {
  const result = await modifyScaffold(
    control.rt, rationale, code,
    baseVersion !== undefined ? { baseVersion } : undefined,
  );

  if (result.ok) {
    void control.sql`INSERT INTO evolution_events (actor_id, id, type, message, data, created_at)
      VALUES (${control.rt.actor.actorId}, ${nanoid()}, 'scaffold_proposed',
              ${`Agent proposed scaffold v${result.version}: ${rationale.slice(0, 80)}`},
              ${null}, ${Date.now()})`;
  }

  return result;
}

export function listScaffoldVersions(
  sql: SqlExecutor, actor: ActorHandle, limit = 20,
): ScaffoldVersionView[] {
  return listScaffoldArchive(sql, actor, limit).map((e) => ({
    version: e.version,
    written_at: e.writtenAt,
    rationale: e.rationale,
    status: e.status,
    parent_version: e.parentVersion,
    trials: e.trials,
    wins: e.wins,
    losses: e.losses,
    ties: e.ties,
    win_rate: e.winRate,
  }));
}

export type ShadowStatus =
  | { hasPending: false; versions: ScaffoldVersionView[] }
  | {
      hasPending: true;
      pending: NonNullable<ReturnType<typeof getPendingScaffold>>;
      decision: ReturnType<typeof decidePromotion>;
      config: typeof DEFAULT_SHADOW_CONFIG;
      /** Sampled but unexecuted trials; never folded into `pending.trialsSoFar`. */
      queuedTrials: number;
    };

/** With nothing pending, the recent archive instead. */
export function getShadowStatus(sql: SqlExecutor, actor: ActorHandle): ShadowStatus {
  const pending = getPendingScaffold(sql, actor);

  if (!pending) return { hasPending: false, versions: listScaffoldVersions(sql, actor, 10) };

  return {
    hasPending: true,
    pending,
    decision: decidePromotion(pending, DEFAULT_SHADOW_CONFIG),
    config: DEFAULT_SHADOW_CONFIG,
    queuedTrials: countQueuedShadowTrials(sql, actor, pending.version),
  };
}

export type ScaffoldDecisionResult =
  | { ok: false; error: string }
  | (Awaited<ReturnType<typeof applyPromotionDecision>> & { ok: true; fromVersion: number });

/**
 * `auto` acts only on a conclusive gate; `promote`/`rollback` force it. The
 * misevolution recheck can still turn a promote into a rollback, so the result
 * reports the action actually applied.
 */
export async function applyScaffoldDecision(
  control: ScaffoldControl,
  mode: 'auto' | 'promote' | 'rollback',
): Promise<ScaffoldDecisionResult> {
  const pending = getPendingScaffold(control.sql, control.rt.actor);

  if (!pending) return { ok: false, error: 'no pending scaffold' };
  let decision: 'promote' | 'rollback';

  if (mode === 'auto') {
    const auto = decidePromotion(pending, DEFAULT_SHADOW_CONFIG).decision;

    if (auto === 'continue') return { ok: false, error: 'inconclusive; need more trials' };
    decision = auto;
  } else {
    decision = mode;
  }

  const fromVersion = pending.version - (decision === 'promote' ? 1 : 0);
  const result = await applyPromotionDecision(control.rt, pending, decision, control.events);

  return { ok: true, fromVersion, ...result };
}

/** Uses the `scaffold_mutation` effort for prompt sections too: the job is the same. */
function reflectionLmFor(control: ScaffoldControl, model: LanguageModel): ReflectionLM {
  return async (prompt) => {
    // Opens before the request so a pass killed mid-rewrite is named.
    const operation = beginModelOperation(
      { source: 'reflection', operations: control.operations },
      'complete',
    );

    let result;

    try {
      result = await generateText({ model, prompt, ...effortFor('scaffold_mutation') });
    } catch (err) {
      operation.failed({ cause: err });
      throw err;
    }

    const usage = normalizeUsage(result.totalUsage);
    const modelId = result.response.modelId;
    operation.completed({ usage, modelId });
    control.reportModelCall?.({ source: 'reflection', usage, modelId, account: callAccountOf(result.response) });

    return result.text;
  };
}

const GepaScoreSchema = v.object({
  score: MetricScoreSchema,
  feedback: v.pipe(v.string(), v.minLength(1)),
});

/** Judge failure aborts the measurement via the failed-run path, never as a score. */
async function judgeScore(control: ScaffoldControl, prompt: string): Promise<MetricOutcome> {
  const scored = await control.judge({
    schema: GepaScoreSchema,
    prompt: `${prompt}\n\nJSON shape: {"score": <number 0..1>, "feedback": "<one sentence>"}.`,
  });

  return { score: scored.score, feedback: scored.feedback };
}

export interface GepaOptimizationResult {
  ok: boolean;
  error?: string;
  runId?: string;
  proposed?: boolean;
  pendingVersion?: number | null;
  skipReason?: string;
  bestScore?: ScoreInterval;
  seedScore?: ScoreInterval;
  iterations?: number;
  selection?: { heldOutNegatives: number; guards: number };
  /** Present when the split could not support an out-of-sample selection. */
  selectionWarning?: string;
}

/**
 * GEPA (Genetic-Pareto) pass over the scaffold. Draws a disjoint train/val split
 * from the outcome ledger: older negatives train reflection; held-out newest
 * negatives plus accepted guards select the winner. A strictly better winner goes
 * to modifyScaffold and the normal shadow-eval pipeline. Budget from
 * `gepa_eval_budget` unless `evalSize` overrides it.
 */
export async function runScaffoldGepaOptimization(
  control: ScaffoldControl,
  opts?: { maxIterations?: number; evalSize?: number; maxMetricCalls?: number },
): Promise<GepaOptimizationResult> {
  const evalSize = clampGepaEvalBudget(opts?.evalSize ?? control.config.getGepaEvalBudget());

  const split = await buildOutcomeEvalSplit(control.sql, control.rt.actor, controlTranscript(control), evalSize);
  const { train: trainSet, val: evalSet } = split;

  // Without a failure there is nothing to select on but judge noise, and an empty
  // train set would hand val back to reflection.
  if (split.degeneracy === 'no_labeled_turns' || split.degeneracy === 'no_negatives') {
    return { ok: false, error: describeSplitDegeneracy(split.degeneracy) };
  }

  const budget = {
    maxIterations: Math.max(1, Math.min(opts?.maxIterations ?? 4, 20)),
    // Seed scoring plus one minibatch and one full scoring per iteration.
    maxMetricCalls: Math.max(10, Math.min(opts?.maxMetricCalls ?? 120, 400)),
    // The paper's 3; the engine caps it at the train set size.
    minibatchSize: 3,
  };

  const model = await control.model();

  // Accepted turns are regression checks against the approved response; negatives
  // score on whether the candidate addresses the complaint.
  let metricCalls = 0;

  const metric = async (
    candidate: string, instance: EvalInstance<string, OutcomeEvalExpectation>,
  ): Promise<MetricOutcome> => {
    metricCalls++;
    let output: string;

    try {
      output = await runScaffoldCaptureText(control, instance.input, candidate);
    } catch (err) {
      const message = renderThrownChain({ cause: err });

      return { score: 0, feedback: `scaffold execution failed: ${message}` };
    }

    return judgeScore(
      control,
      `Score this agent response on a 0..1 scale and give one sentence of specific, ` +
        `actionable feedback on how the agent's behaviour could improve.\n\n` +
        `Task:\n${instance.input}\n\nNew response:\n${evidenceWindow(output, EVIDENCE_BUDGETS.replayFreshResponse)}\n\n` +
        renderOutcomeCriterion(instance.expected, FRESH_RESPONSE_RULE),
    );
  };

  const reflectionLm = reflectionLmFor(control, model);

  const runId = startGepaRun(control.sql, control.rt.actor, { target: 'scaffold', budget });
  const persist = makePersistingHooks({ sql: control.sql, actor: control.rt.actor, runId });
  let iterations = 0;
  let result;

  try {
    result = await runScaffoldGepa({
      rt: control.rt,
      evalSet,
      trainSet,
      metric,
      reflectionLm,
      budget,
      onCandidate: persist.onCandidate,
      onIteration: state => {
        iterations = state.iteration + 1;

        return persist.onIteration(state);
      },
    });
  } catch (err) {
    const message = renderThrownChain({ cause: err });
    finishGepaRun(control.sql, control.rt.actor, {
      runId, status: 'aborted', stopReason: 'aborted', winnerId: null, metricCalls, iterations,
    });

    return { ok: false, error: message, runId };
  }

  finishGepaRun(control.sql, control.rt.actor, {
    runId,
    status: 'completed',
    stopReason: result.gepa.stopReason,
    winnerId: result.gepa.winner.id,
    metricCalls: result.gepa.metricCallsUsed,
    iterations: result.gepa.iterationsRun,
  });

  const output: GepaOptimizationResult = {
    ok: true,
    runId,
    proposed: result.proposed,
    pendingVersion: result.pendingVersion,
    skipReason: result.skipReason,
    bestScore: result.winnerScore,
    seedScore: result.seedScore,
    iterations: result.gepa.iterationsRun,
    selection: {
      heldOutNegatives: split.heldOutNegatives,
      guards: evalSet.length - split.heldOutNegatives,
    },
  };

  if (split.degeneracy) output.selectionWarning = describeSplitDegeneracy(split.degeneracy);

  return output;
}

const SECTION_WORDING_RULE: OutcomeScoringRule = {
  accepted: 'Score 1.0 when the candidate wording would still have produced a response at least '
    + 'this good, 0.0 when it would have pushed the agent off it.',
  failed: 'Score 1.0 when the candidate wording would have prevented that failure, 0.0 when it '
    + 'would have changed nothing.',
};

/**
 * Scores a section counterfactually with no rollout: would this wording have
 * prevented the correction or kept the accepted answer? Weaker evidence, so a winner
 * only lands pending (`prompting/section-store.ts`).
 */
function renderSectionScorePrompt(
  sectionId: string,
  candidate: string,
  instance: EvalInstance<string, OutcomeEvalExpectation>,
): string {
  return `Score a candidate revision of one section of an agent's system prompt on a 0..1 scale, `
    + `and give one sentence of specific feedback naming what in the WORDING is responsible.\n\n`
    + `Section: ${sectionId}\n\nCandidate wording:\n${evidenceWindow(candidate, EVIDENCE_BUDGETS.gepaParentSource)}\n\n`
    + `The agent was asked:\n${evidenceWindow(instance.input, EVIDENCE_BUDGETS.replayTask)}\n\n`
    + renderOutcomeCriterion(instance.expected, SECTION_WORDING_RULE);
}

function sectionMetric(control: ScaffoldControl, sectionId: string) {
  return (
    candidate: string, instance: EvalInstance<string, OutcomeEvalExpectation>,
  ): Promise<MetricOutcome> => judgeScore(control, renderSectionScorePrompt(sectionId, candidate, instance));
}

export interface PromptSectionOptimizationResult {
  ok: boolean;
  error?: string;
  runId?: string;
  sectionId?: string;
  proposed?: boolean;
  pendingVersion?: number | null;
  skipReason?: string;
  /** `size_rule` is the anti-bloat rule, not a fault. */
  refusal?: string;
  bestScore?: ScoreInterval;
  incumbentScore?: ScoreInterval;
  iterations?: number;
  /** Bytes the winner would add to every turn if promoted. */
  byteDelta?: number;
  selectionWarning?: string;
}

/** GEPA over one prompt section, with the same disjoint train/val split as the scaffold pass. */
async function runPromptSectionGepaOptimization(
  control: ScaffoldControl,
  opts: { sectionId: string; maxIterations?: number; evalSize?: number; maxMetricCalls?: number },
): Promise<PromptSectionOptimizationResult> {
  const evalSize = clampGepaEvalBudget(opts.evalSize ?? control.config.getGepaEvalBudget());
  const split = await buildOutcomeEvalSplit(control.sql, control.rt.actor, controlTranscript(control), evalSize);

  if (split.degeneracy === 'no_labeled_turns' || split.degeneracy === 'no_negatives') {
    return { ok: false, error: describeSplitDegeneracy(split.degeneracy) };
  }

  const budget = {
    maxIterations: Math.max(1, Math.min(opts.maxIterations ?? 4, 20)),
    // A section metric call is one judge call, not a rollout plus judge.
    maxMetricCalls: Math.max(10, Math.min(opts.maxMetricCalls ?? 120, 400)),
    minibatchSize: 3,
  };

  const reflectionLm = reflectionLmFor(control, await control.model());

  const runId = startGepaRun(control.sql, control.rt.actor, {
    target: 'prompt_section', targetRef: opts.sectionId, budget,
  });

  const persist = makePersistingHooks({ sql: control.sql, actor: control.rt.actor, runId });
  const metric = sectionMetric(control, opts.sectionId);
  let metricCalls = 0;
  let iterations = 0;
  let result;

  try {
    result = await runSectionGepa({
      sql: control.sql,
      actor: control.rt.actor,
      sectionId: opts.sectionId,
      evalSet: split.val,
      trainSet: split.train,
      metric: (candidate, instance) => {
        metricCalls++;

        return metric(candidate, instance);
      },
      reflectionLm,
      budget,
      onCandidate: persist.onCandidate,
      onIteration: state => {
        iterations = state.iteration + 1;

        return persist.onIteration(state);
      },
    });
  } catch (err) {
    finishGepaRun(control.sql, control.rt.actor, {
      runId, status: 'aborted', stopReason: 'aborted', winnerId: null, metricCalls, iterations,
    });

    return { ok: false, error: renderThrownChain({ cause: err }), runId };
  }

  const gepa = result.gepa;
  finishGepaRun(control.sql, control.rt.actor, {
    runId,
    status: 'completed',
    stopReason: gepa?.stopReason ?? 'no_improvement_possible',
    winnerId: gepa?.winner.id ?? null,
    metricCalls: gepa?.metricCallsUsed ?? 0,
    iterations: gepa?.iterationsRun ?? 0,
  });

  const seedBytes = Buffer.byteLength(gepa?.history[0]?.source ?? '', 'utf8');

  const output: PromptSectionOptimizationResult = {
    ok: true,
    runId,
    sectionId: result.sectionId,
    proposed: result.proposed,
    pendingVersion: result.pendingVersion,
    skipReason: result.skipReason,
    bestScore: result.winnerScore,
    incumbentScore: result.incumbentScore,
    iterations: gepa?.iterationsRun ?? 0,
    byteDelta: Buffer.byteLength(gepa?.winner.source ?? '', 'utf8') - seedBytes,
  };

  if (result.proposeError) output.refusal = result.proposeError.error;

  if (split.degeneracy) output.selectionWarning = describeSplitDegeneracy(split.degeneracy);

  return output;
}

export interface PromptSectionTrialResult {
  sectionId: string;
  pending: boolean;
  trialsRun: number;
  decision?: 'promote' | 'rollback' | 'continue';
  winRate?: number;
  action?: 'promote' | 'rollback';
  vetoReason?: string;
}

function trialWinner(pendingScore: number, currentScore: number): 'current' | 'pending' | 'tie' {
  if (pendingScore > currentScore) return 'pending';

  if (pendingScore < currentScore) return 'current';

  return 'tie';
}

/**
 * Score the pending section against the incumbent on held-out turns, paired per
 * instance, on the cadence lane only. No queue: a section trial needs no live turn.
 */
async function runPromptSectionTrials(
  control: ScaffoldControl,
  sectionId: string,
  opts?: { trials?: number },
): Promise<PromptSectionTrialResult> {
  const pending = getPendingPromptSection(control.sql, control.rt.actor, sectionId);

  if (!pending) return { sectionId, pending: false, trialsRun: 0 };
  const section = findPromptSectionTarget(sectionId);

  if (!section) return { sectionId, pending: false, trialsRun: 0 };

  const incumbent = incumbentSectionSource(control.sql, control.rt.actor, section);
  const metric = sectionMetric(control, sectionId);
  // Drawn fresh each pass, never including the train half.
  const split = await buildOutcomeEvalSplit(control.sql, control.rt.actor, controlTranscript(control), control.config.getGepaEvalBudget());
  const instances = split.val.slice(0, Math.max(1, opts?.trials ?? 3));

  let trialsRun = 0;

  for (const instance of instances) {
    const [current, candidate] = await Promise.all([
      metric(incumbent, instance),
      metric(pending.source, instance),
    ]);

    recordPromptSectionTrial(control.sql, control.rt.actor, {
      sectionId,
      pendingVersion: pending.version,
      instanceId: instance.id,
      currentScore: current.score,
      pendingScore: candidate.score,
      winner: trialWinner(candidate.score, current.score),
      feedback: candidate.feedback,
    });
    trialsRun += 1;
  }

  const settled = getPendingPromptSection(control.sql, control.rt.actor, sectionId);

  if (!settled) return { sectionId, pending: true, trialsRun };
  const verdict = decidePromptSectionPromotion(settled);

  const result: PromptSectionTrialResult = {
    sectionId, pending: true, trialsRun,
    decision: verdict.decision, winRate: verdict.winRate,
  };

  if (verdict.decision === 'continue') return result;
  const applied = applyPromptSectionDecision(control.sql, control.rt.actor, settled, verdict.decision);
  result.action = applied.action;

  if (applied.vetoReason) result.vetoReason = applied.vetoReason;

  return result;
}

/** `code` names the bar so callers can branch without parsing prose. */
export type MeasuredSectionProposal =
  | {
    readonly ok: true;
    readonly sectionId: string;
    readonly version: number;
    readonly incumbentScore: ScoreInterval;
    readonly candidateScore: ScoreInterval;
  }
  | {
    readonly ok: false;
    readonly sectionId: string;
    readonly code: ProposeSectionRefusal | 'unknown_section' | 'degenerate_split';
    readonly error: string;
  };

/**
 * Measure one externally authored section candidate against the incumbent on
 * held-out labeled turns, then hand it to the proposal gate. It lands pending and
 * needs `advancePromptSectionLane`'s trials. A degenerate split is a refusal.
 */
export async function proposeMeasuredPromptSection(
  control: ScaffoldControl,
  input: { sectionId: string; source: string; rationale: string; trials?: number },
): Promise<MeasuredSectionProposal> {
  const section = findPromptSectionTarget(input.sectionId);

  if (!section) {
    return {
      ok: false, sectionId: input.sectionId, code: 'unknown_section',
      error: `"${input.sectionId}" is not a registered prompt section`,
    };
  }

  const split = await buildOutcomeEvalSplit(
    control.sql, control.rt.actor, controlTranscript(control), clampGepaEvalBudget(control.config.getGepaEvalBudget()),
  );

  if (split.degeneracy !== null) {
    return {
      ok: false, sectionId: section.id, code: 'degenerate_split',
      error: describeSplitDegeneracy(split.degeneracy),
    };
  }

  const incumbent = incumbentSectionSource(control.sql, control.rt.actor, section);
  const metric = sectionMetric(control, section.id);
  // Held-out turns only: a candidate measured on turns its author saw has learned them.
  const instances = split.val.slice(0, Math.max(1, input.trials ?? 3));

  const scored = await Promise.all(instances.map(async (instance) => Promise.all([
    metric(incumbent, instance),
    metric(input.source, instance),
  ])));

  const incumbentScore = scoreInterval(scored.map(([current]) => current.score));
  const candidateScore = scoreInterval(scored.map(([, candidate]) => candidate.score));

  const proposal = proposePromptSection(control.sql, control.rt.actor, {
    section,
    source: input.source,
    rationale: input.rationale,
    incumbentScore,
    candidateScore,
  });

  if (!proposal.ok) {
    return { ok: false, sectionId: section.id, code: proposal.code, error: proposal.error };
  }

  return {
    ok: true, sectionId: section.id, version: proposal.version, incumbentScore, candidateScore,
  };
}

/**
 * The section whose last pass is oldest; never-passed first, ties by registry order.
 * Derived from `gepa_runs` because an in-memory cursor is reset by Durable Object eviction.
 */
function nextPromptSectionTarget(sql: SqlExecutor, actor: ActorHandle): PromptSection<string> | null {
  const lastPass = lastGepaRunPerTarget(sql, actor, 'prompt_section');
  let next: PromptSection<string> | null = null;
  let nextAt = Number.POSITIVE_INFINITY;

  for (const section of PROMPT_SECTION_TARGETS) {
    const at = lastPass.get(section.id) ?? Number.NEGATIVE_INFINITY;

    if (at < nextAt) {
      next = section;
      nextAt = at;
    }
  }

  return next;
}

export type PromptSectionLaneStep =
  | { readonly step: 'trials'; readonly sectionId: string; readonly trials: PromptSectionTrialResult }
  | { readonly step: 'pass'; readonly sectionId: string; readonly pass: PromptSectionOptimizationResult }
  | { readonly step: 'idle' };

/**
 * A section under trial is finished first; with nothing pending, the next section
 * in rotation gets a pass. Scheduling and fault handling stay with the caller.
 */
export async function advancePromptSectionLane(
  control: ScaffoldControl,
): Promise<PromptSectionLaneStep> {
  const pending = firstPendingPromptSection(control.sql, control.rt.actor);

  if (pending !== null) {
    return { step: 'trials', sectionId: pending, trials: await runPromptSectionTrials(control, pending) };
  }

  const section = nextPromptSectionTarget(control.sql, control.rt.actor);

  if (!section) return { step: 'idle' };

  return {
    step: 'pass',
    sectionId: section.id,
    pass: await runPromptSectionGepaOptimization(control, { sectionId: section.id }),
  };
}

/** Structured output over a review model at the judge stage's reasoning effort.
 *  Supplies its own `judge` spend label. */
export function createJsonJudge(
  model: () => LanguageModel | Promise<LanguageModel>,
  reportModelCall?: ModelCallSink,
  operations?: ModelOperationSink,
): JsonGenerator {
  return async (opts) => generateJson({
    model: await model(),
    schema: opts.schema,
    prompt: opts.prompt,
    providerOptions: effortFor('judge').providerOptions,
    spend: reportModelCall || operations
      ? { source: 'judge', report: reportModelCall ?? (() => {}), operations }
      : undefined,
  });
}

/** Structured output over core's `LLM`. No sink: the `LLM` reports its own spend,
 *  and a second channel would double-count. */
export function createLlmJsonJudge(llm: LLM): JsonGenerator {
  return async (opts) =>
    v.parse(opts.schema, extractJsonObject(await llm.complete(`${opts.prompt}\n\n${jsonObjectOnlyInstruction()}`)));
}
