/**
 * The scaffold evolution control plane — the drivers that turn the evolution
 * primitives into operations an agent can be asked to perform.
 *
 * Every piece this file calls (`runScaffold`, `modifyScaffold`,
 * `decidePromotion`, `applyPromotionDecision`, `buildOutcomeEvalSplit`,
 * `runScaffoldGepa`) was already core. Only the drivers were not — they were
 * written as Durable Object methods, so a capability with nothing
 * Cloudflare-shaped about it existed on exactly one backend. GEPA is the stark
 * case: the flagship self-optimisation pass could not be run from the CLI at
 * all, because its driver was a `@callable()` on OrchestratorAgent. Four more
 * (propose, shadow status, apply decision, list versions) existed twice, once
 * per backend, and had already drifted — the cf copy writes an
 * `evolution_events` row and emits a run event, the local copy did neither.
 *
 * What a backend supplies is a {@link ScaffoldSurface}: the four ports a
 * candidate loop runs against (inference, tools, history, default loop). That
 * is a genuine per-backend difference — cf resolves it from the actor's raw
 * ToolSet and Think's message stream, the CLI from the session's ToolSet and
 * its own history. Everything else is policy and lives here.
 */

import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import * as v from 'valibot';

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { LLM, SqlExecutor } from '../types/primitives.js';
import type { AgentConfigStore } from '../config/store.js';
import { clampGepaEvalBudget } from '../config/store.js';
import { effortFor } from '../strategy/effort.js';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window.js';
import { extractJsonObject, generateJson, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import {
  runScaffold, scaffoldEventText, SCAFFOLD_TURN_TIMEOUT_MS,
  type ScaffoldRunOptions, type ScaffoldRunResult,
} from '../scaffold/executor.js';
import { modifyScaffold } from '../scaffold/modify.js';
import { listScaffoldArchive, type ScaffoldArchiveEntry } from '../scaffold/archive.js';
import {
  DEFAULT_SHADOW_CONFIG, MAX_QUEUED_SHADOW_TRIALS, applyPromotionDecision, countQueuedShadowTrials,
  decidePromotion, dropQueuedShadowTrial, getPendingScaffold, listQueuedShadowTrials,
  purgeQueuedShadowTrials, queueShadowTrial, readScaffoldVersion,
} from '../scaffold/shadow.js';
import type { ShadowTrialDrain, ShadowTrialTurn } from './types.js';
import {
  DEFAULT_AUTO_JUDGE_CONFIG, runAutoShadowEval,
} from '../scaffold/auto-judge.js';
import { buildOutcomeEvalSplit, describeSplitDegeneracy, type OutcomeEvalExpectation } from './outcomes.js';
import { runScaffoldGepa } from './gepa/scaffold-bridge.js';
import {
  finishGepaRun, makePersistingHook, startGepaRun,
} from './gepa/persistence.js';
import type { EvalInstance, MetricOutcome } from './gepa/types.js';
import type { ScoreInterval } from '../utils/stats.js';
import { nanoid } from '../utils/nanoid.js';

/**
 * The inference surface a candidate scaffold runs against.
 *
 * The one genuine per-backend part of this plane: cf builds these over the
 * actor's raw ToolSet and Think's prepared messages, the CLI over the
 * session's ToolSet and its own history. All four ports are built by core
 * factories (`orchestrator/scaffold-host.ts`) on both sides.
 */
export interface ScaffoldSurface {
  readonly llmStream: ScaffoldRunOptions['llmStream'];
  readonly callTool?: ScaffoldRunOptions['callTool'];
  readonly history?: ScaffoldRunOptions['history'];
  /** What `host.defaultInference()` runs — the backend's ordinary turn loop.
   *  Absent means a scaffold that delegates gets the documented error. */
  readonly defaultInference?: ScaffoldRunOptions['defaultInference'];
}

/** The conversation a candidate's default loop replays. Empty means the caller
 *  has none, and the backend reconstructs one from the task alone. */
export type ScaffoldReplayContext = readonly ModelMessage[];

/** Structured output from a model, validated against a schema. */
export type JsonGenerator = <T>(opts: {
  schema: v.GenericSchema<unknown, T>;
  prompt: string;
}) => Promise<T>;

/** What the control plane needs from whichever backend is hosting it. */
export interface ScaffoldControl {
  readonly rt: AgentRuntime;
  readonly sql: SqlExecutor;
  readonly config: AgentConfigStore;
  /** Resolved per call against the task being run, so a control-plane
   *  operation issued mid-session runs the candidate against the tools the
   *  session has right now, and `defaultInference` delegates to the ordinary
   *  loop for THIS task. `context` is the conversation that task was asked in,
   *  which a delegating candidate must be given or it answers a
   *  context-dependent task from the task text alone; empty for the one-shot
   *  operations (preview, GEPA rollout, replay), which have none. */
  readonly surface: (task: string, context?: ScaffoldReplayContext) => ScaffoldSurface;
  /** The chat model — what a candidate loop and the reflection LM run on. */
  readonly model: () => LanguageModel | Promise<LanguageModel>;
  /**
   * The judge. Must NOT be the chat model: GEPA is the largest judge consumer
   * in the system, and letting a model grade its own candidates is exactly the
   * self-enhancement bias (arXiv:2306.05685) every other scorer here routes
   * around. Backends build this over their cross-family review model.
   */
  readonly judge: JsonGenerator;
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
    ...(surface.callTool ? { callTool: surface.callTool } : {}),
    ...(surface.history ? { history: surface.history } : {}),
    ...(surface.defaultInference ? { defaultInference: surface.defaultInference } : {}),
    ...extra,
  };
}

/**
 * Run a scaffold against a task and return the text it produced. With
 * `candidateCode` this is the GEPA metric's rollout; without it, it rolls the
 * LIVE scaffold — the replay-eval harness's current-config runner.
 *
 * The wall clock is the live turn budget, not a smaller one: this run IS the
 * candidate's score, and a candidate cut off early scores as a bad candidate.
 */
export async function runScaffoldCaptureText(
  control: ScaffoldControl,
  task: string,
  candidateCode?: string,
): Promise<string> {
  let text = '';
  const result = await runScaffold(scaffoldRunOptions(control, task, {
    emit: (ev) => { text += scaffoldEventText(ev) ?? ''; },
    ...(candidateCode !== undefined ? { scaffoldCodeOverride: candidateCode } : {}),
    timeoutMs: SCAFFOLD_TURN_TIMEOUT_MS,
  }));
  if (!result.ok && result.error) throw new Error(result.error);
  return text;
}

/**
 * Execute the current scaffold for a one-shot task and return everything it
 * emitted, injecting nothing back into the conversation — how a scaffold
 * mutation is tried without touching the live turn loop. `useShadowOverride`
 * runs the pending version instead, when one exists.
 */
export async function runScaffoldOnce(
  control: ScaffoldControl,
  task: string,
  opts?: { useShadowOverride?: boolean; timeoutMs?: number },
): Promise<ScaffoldRunResult> {
  const pending = opts?.useShadowOverride ? getPendingScaffold(control.sql) : null;
  const codeOverride = pending ? await readScaffoldVersion(control.rt, pending.version) : null;
  return runScaffold(scaffoldRunOptions(control, task, {
    ...(codeOverride != null ? { scaffoldCodeOverride: codeOverride } : {}),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  }));
}

/** What a completed turn offered the promotion gate. Every value except
 *  `'queued'` is a turn that contributed nothing — named, so a caller reporting
 *  the gate's state never has to guess which. */
export type ShadowTrialQueueOutcome = 'queued' | 'not_sampled' | 'no_pending' | 'queue_full' | 'failed';

/**
 * The turn-bound half of the shadow loop — and ALL of it that a turn pays for:
 * sample this turn, and if it is in the sample, write ONE row recording the
 * task, what the live turn answered, and the conversation it answered in.
 *
 * The trial itself — a whole candidate turn plus two judge calls, minutes of
 * wall clock — is NOT run here. It used to be, on the turn's own lane, which
 * meant the promotion gate resolved candidates against the user's clock: a
 * `proteus exec` process waited up to its settle bound for a rollout, and a
 * Durable Object ran a full extra inference beside the next request. What runs
 * the queue is the cadence lane ({@link runQueuedShadowTrials}), and until it
 * does the gate simply has less evidence — which `decidePromotion` already has
 * an honest answer for ('continue'), and which `getShadowStatus` reports as
 * queued rather than as trials.
 *
 * Synchronous and total: a lost trial must never fail the turn that produced
 * it, so every failure is absorbed and named in the return value.
 *
 * Whether this runs at all is not decided here: both halves of the loop are
 * reached through the EvolutionEngine, which holds the one auto-evolution gate
 * (`queueShadowTrial` / `runDueShadowTrials`).
 */
export function queueTurnShadowTrial(
  control: ScaffoldControl,
  turn: ShadowTrialTurn,
): ShadowTrialQueueOutcome {
  try {
    const sampleRate = control.config.getShadowSampleRate();
    if (sampleRate <= 0) return 'not_sampled';
    const pending = getPendingScaffold(control.sql);
    if (!pending) return 'no_pending';
    if (Math.random() >= sampleRate) return 'not_sampled';
    return queueShadowTrial(control.sql, {
      pendingVersion: pending.version,
      // Passed WHOLE. runAutoShadowEval owns the evidence budget and applies it
      // once, to the judge and the trial row together; a clamp here both
      // duplicates the policy and lies about it — windowing an already windowed
      // string reports the second pass's omission count, not the total. It also
      // matters beyond tidiness: `task` is what the PENDING scaffold is run on,
      // so a slice here would ask the pending to answer a truncated version of
      // the question the live turn answered in full, then judge the two against
      // each other.
      task: turn.task,
      currentOutput: turn.currentOutput,
      context: turn.context,
    });
  } catch (err) {
    console.warn('[proteus] shadow trial queue failed:', err instanceof Error ? err.message : err);
    return 'failed';
  }
}

/**
 * The offline half: run every trial queued for the pending scaffold, then let
 * the promotion gate read what has accumulated.
 *
 * Cadence-lane work by construction — minutes of wall clock per trial, so only
 * a host that can afford to finish it ever starts it (the Durable Object under
 * keepAlive, a long-lived CLI session, the local scheduler daemon). A host that
 * exits first leaves the rows where they are; the queue is durable and the next
 * capable host runs them.
 *
 * Trials for any version that is no longer pending are discarded rather than
 * run: a trial is evidence about ONE candidate, and once that candidate is
 * resolved its remaining trials would score a version nobody is deciding on.
 * The same reason stops the loop the moment a decision is applied.
 */
export async function runQueuedShadowTrials(control: ScaffoldControl): Promise<ShadowTrialDrain> {
  const pending = getPendingScaffold(control.sql);
  purgeQueuedShadowTrials(control.sql, pending?.version ?? null);
  if (!pending) return { trials: 0, applied: null };

  let trials = 0;
  let processed = 0;
  // Re-read between laps: a turn can queue a trial while the previous lap is
  // running, and a drain that only ever saw its opening snapshot would leave
  // the newest evidence for a pass that may never come. A lap that finds
  // nothing ends the drain; the ceiling bounds the pathological case, and past
  // it one drain has already run more trials than the gate can consume.
  while (processed < MAX_QUEUED_SHADOW_TRIALS) {
    const batch = listQueuedShadowTrials(control.sql, pending.version);
    if (batch.length === 0) break;
    for (const trial of batch) {
      if (processed >= MAX_QUEUED_SHADOW_TRIALS) break;
      processed++;
      const surface = control.surface(trial.task, trial.context);
      let applied: 'promote' | 'rollback' | null = null;
      try {
        const result = await runAutoShadowEval({
          rt: control.rt,
          task: trial.task,
          currentOutput: trial.currentOutput,
          judge: (prompt, schema) => control.judge({ schema, prompt }),
          llmStream: surface.llmStream,
          ...(surface.callTool ? { callTool: surface.callTool } : {}),
          ...(surface.history ? { history: surface.history } : {}),
          ...(surface.defaultInference ? { defaultInference: surface.defaultInference } : {}),
          config: { ...DEFAULT_AUTO_JUDGE_CONFIG, autoApply: control.config.getAutoPromoteScaffold() },
        });
        applied = result.applied ?? null;
        if (!result.skipped) trials++;
      } catch (err) {
        // A trial that throws is a trial we cannot score, not a queue we should
        // wedge on: drop it below and carry on with the rest.
        console.warn('[proteus] shadow trial failed:', err instanceof Error ? err.message : err);
      }
      dropQueuedShadowTrial(control.sql, trial.id);
      if (applied) {
        purgeQueuedShadowTrials(control.sql, null);
        console.log(`[proteus] promotion gate chose ${applied} for scaffold v${pending.version} after ${trials} trial(s)`);
        return { trials, applied };
      }
    }
  }
  return { trials, applied: null };
}

/**
 * Run an arbitrary scaffold version against a task — previewing a candidate
 * live before promoting it. Reads the version's source from the VFS
 * `agent.js.vN` backup.
 */
export async function previewScaffoldLive(
  control: ScaffoldControl,
  version: number,
  task: string,
  opts?: { timeoutMs?: number },
): Promise<ScaffoldRunResult> {
  const codeOverride = await readScaffoldVersion(control.rt, version);
  if (codeOverride == null) {
    throw new Error(`previewScaffoldLive: no scaffold code found for v${version}`);
  }
  return runScaffold(scaffoldRunOptions(control, task, {
    scaffoldCodeOverride: codeOverride,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  }));
}

/**
 * Propose a new version of the agent's own inference loop, through the
 * existing modifyScaffold 4-gate pipeline. An accepted proposal lands as
 * `pending` and is scored by the sampled shadow eval + promotion gate like any
 * other — no new safety surface.
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
    try {
      control.sql`INSERT INTO evolution_events (id, type, message, data, created_at)
        VALUES (${nanoid()}, 'scaffold_proposed',
                ${`Agent proposed scaffold v${result.version}: ${rationale.slice(0, 80)}`},
                ${null}, ${Date.now()})`;
    } catch { /* the ledger may not exist on a workspace this old */ }
  }
  return result;
}

/** The scaffold variant archive: recent versions with status, DGM lineage and
 *  aggregated shadow-eval record. snake_case keys are the wire shape the web
 *  surface has always read (ScaffoldLineage.tsx reads `written_at`). */
export interface ScaffoldVersionView {
  version: number;
  written_at: number;
  rationale: string;
  status: ScaffoldArchiveEntry['status'];
  parent_version: number | null;
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  win_rate: number | null;
}

export function listScaffoldVersions(sql: SqlExecutor, limit = 20): ScaffoldVersionView[] {
  return listScaffoldArchive(sql, limit).map((e) => ({
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
      /** Trials sampled but not yet executed. Reported separately from
       *  `pending.trialsSoFar` and never folded into it: this is evidence the
       *  candidate is OWED, and the gate has not seen a single bit of it. */
      queuedTrials: number;
    };

/** The pending scaffold's rollout state — trials so far and what the promotion
 *  gate currently says. With nothing pending, the recent archive instead. */
export function getShadowStatus(sql: SqlExecutor): ShadowStatus {
  const pending = getPendingScaffold(sql);
  if (!pending) return { hasPending: false, versions: listScaffoldVersions(sql, 10) };
  return {
    hasPending: true,
    pending,
    decision: decidePromotion(pending, DEFAULT_SHADOW_CONFIG),
    config: DEFAULT_SHADOW_CONFIG,
    queuedTrials: countQueuedShadowTrials(sql, pending.version),
  };
}

export type ScaffoldDecisionResult =
  | { ok: false; error: string }
  | (Awaited<ReturnType<typeof applyPromotionDecision>> & { ok: true; fromVersion: number });

/**
 * Apply the pending rollout decision by hand. `auto` acts only on a conclusive
 * promotion gate; `promote`/`rollback` force the corresponding action — though
 * the misevolution recheck inside applyPromotionDecision can still convert a
 * requested promote into a rollback, which is why the result reports the
 * action ACTUALLY applied.
 */
export async function applyScaffoldDecision(
  control: ScaffoldControl,
  mode: 'auto' | 'promote' | 'rollback',
): Promise<ScaffoldDecisionResult> {
  const pending = getPendingScaffold(control.sql);
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
  const result = await applyPromotionDecision(control.rt, pending, decision);
  return { ok: true, fromVersion, ...result };
}

// ── GEPA offline scaffold optimisation ──────────────────────────────────────

const GepaScoreSchema = v.object({
  score: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  feedback: v.pipe(v.string(), v.minLength(1)),
});

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
  /** What the winner was selected on: failures it never trained on, plus
   *  accepted regression guards. */
  selection?: { heldOutNegatives: number; guards: number };
  /** Present when the split could not support an out-of-sample selection —
   *  the result is exploratory, not evidence. */
  selectionWarning?: string;
}

/**
 * Run a GEPA (Genetic-Pareto) optimisation pass over the agent's scaffold.
 *
 * Offline and batch: draws a budgeted, DISJOINT train/val split from the
 * turn-outcome ledger (older corrected/frustrated turns are the train set
 * reflection must fix; the newest failures held out, plus accepted turns, are
 * the val set the winner is selected on), runs the current scaffold and
 * reflection-mutated candidates against them, scores each with an
 * outcome-aware judge, and — if a strictly better candidate is found — hands
 * the winner to modifyScaffold so it enters the normal shadow-eval → promote
 * pipeline. Persisted to gepa_runs/gepa_candidates for lineage.
 *
 * Cost-bounded: the instance budget comes from agent_config gepa_eval_budget
 * unless `evalSize` overrides it, and each metric call is a full scaffold run
 * plus a judge call. Scores come back as intervals — with a val set this size,
 * a winner inside the seed's interval is not evidence of anything.
 */
export async function runScaffoldGepaOptimization(
  control: ScaffoldControl,
  opts?: { maxIterations?: number; evalSize?: number; maxMetricCalls?: number },
): Promise<GepaOptimizationResult> {
  const evalSize = clampGepaEvalBudget(opts?.evalSize ?? control.config.getGepaEvalBudget());

  // 1. Train/val split from outcome-labeled turns (the turn_outcomes ledger).
  const split = buildOutcomeEvalSplit(control.sql, evalSize);
  const { train: trainSet, val: evalSet } = split;
  // Without a failure to optimise toward there is nothing to select on but
  // judge noise over already-accepted turns — and an empty train set would
  // hand the eval set straight back to reflection as its minibatch source.
  if (split.degeneracy === 'no_labeled_turns' || split.degeneracy === 'no_negatives') {
    return { ok: false, error: describeSplitDegeneracy(split.degeneracy) };
  }

  const budget = {
    maxIterations: Math.max(1, Math.min(opts?.maxIterations ?? 4, 20)),
    // Seed scoring (|val|) plus one minibatch and one full scoring per
    // iteration; the default covers the default 4 iterations over a
    // default-budget split with headroom.
    maxMetricCalls: Math.max(10, Math.min(opts?.maxMetricCalls ?? 120, 400)),
    // The paper's 3 — reflection reads three failures per proposal. The engine
    // caps it at the (disjoint) train set when fewer exist.
    minibatchSize: 3,
  };

  const model = await control.model();

  // 2. Metric: run the candidate scaffold against the task, then judge against
  // the recorded outcome — accepted turns are regression checks against the
  // response the user approved; corrected/frustrated turns are scored on
  // whether the candidate already addresses the user's correction.
  const metric = async (
    candidate: string, instance: EvalInstance<string, OutcomeEvalExpectation>,
  ): Promise<MetricOutcome> => {
    let output: string;
    try {
      output = await runScaffoldCaptureText(control, instance.input, candidate);
    } catch (err) {
      return { score: 0, feedback: `scaffold execution failed: ${(err as Error).message}` };
    }
    const exp = instance.expected;
    const criterion = exp && exp.outcome === 'accepted'
      ? `The reference response below was ACCEPTED by the user. Score 1.0 when the new response ` +
        `is at least as good, 0.0 when it regresses.\n\nReference response:\n${evidenceWindow(exp.recordedResponse, EVIDENCE_BUDGETS.replayReferenceResponse)}`
      : `The agent's previous response to this task FAILED — the user had to correct it. Score 1.0 when ` +
        `the new response already addresses the correction, 0.0 when it repeats the failure.\n\n` +
        `Previous (failed) response:\n${evidenceWindow(exp?.recordedResponse ?? '', EVIDENCE_BUDGETS.replayFailedResponse)}\n\n` +
        `User's correction:\n${evidenceWindow(exp?.followup ?? '(not recorded)', EVIDENCE_BUDGETS.replayCorrection)}`;
    try {
      const obj = await control.judge({
        schema: GepaScoreSchema,
        prompt:
          `Score this agent response on a 0..1 scale and give one sentence of specific, ` +
          `actionable feedback on how the agent's behaviour could improve.\n\n` +
          `Task:\n${instance.input}\n\nNew response:\n${evidenceWindow(output, EVIDENCE_BUDGETS.replayFreshResponse)}\n\n` +
          `${criterion}\n\n` +
          `JSON shape: {"score": <number 0..1>, "feedback": "<one sentence>"}.`,
      });
      return { score: obj.score, feedback: obj.feedback };
    } catch (err) {
      return { score: 0.5, feedback: `judge unavailable: ${(err as Error).message}` };
    }
  };

  // 3. Reflection LM — rewrites the scaffold from the failure feedback.
  const reflectionLm = async (prompt: string): Promise<string> => {
    const { text } = await generateText({ model, prompt, ...effortFor('scaffold_mutation') });
    return text;
  };

  // 4. Run GEPA, persisting every candidate + Pareto snapshot.
  const runId = startGepaRun(control.sql, { target: 'scaffold', budget });
  const persisted = new Set<string>();
  let result;
  try {
    result = await runScaffoldGepa({
      rt: control.rt,
      evalSet,
      trainSet,
      metric,
      reflectionLm,
      budget,
      onIteration: makePersistingHook({ sql: control.sql, runId, evalSet, persisted }),
    });
  } catch (err) {
    finishGepaRun(control.sql, {
      runId, status: 'aborted', stopReason: 'aborted', winnerId: null, metricCalls: 0, iterations: 0,
    });
    return { ok: false, error: (err as Error).message, runId };
  }

  finishGepaRun(control.sql, {
    runId,
    status: 'completed',
    stopReason: result.gepa.stopReason,
    winnerId: result.gepa.winner.id,
    metricCalls: result.gepa.metricCallsUsed,
    iterations: result.gepa.iterationsRun,
  });

  return {
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
    ...(split.degeneracy ? { selectionWarning: describeSplitDegeneracy(split.degeneracy) } : {}),
  };
}

/** Structured output over a review LanguageModel at the judge stage's
 *  reasoning effort — what the cf actor builds over its cross-family review
 *  model. */
export function createJsonJudge(model: () => LanguageModel | Promise<LanguageModel>): JsonGenerator {
  return async (opts) => generateJson({
    model: await model(),
    schema: opts.schema,
    prompt: opts.prompt,
    providerOptions: effortFor('judge').providerOptions,
  });
}

/** Structured output over core's `LLM` primitive — the same ask-for-JSON,
 *  extract, validate idiom `createStructuredJudge` uses, for a backend whose
 *  judge is an LLM rather than an ai-SDK LanguageModel. */
export function createLlmJsonJudge(llm: LLM): JsonGenerator {
  return async (opts) =>
    v.parse(opts.schema, extractJsonObject(await llm.complete(`${opts.prompt}\n\n${jsonObjectOnlyInstruction()}`)));
}
