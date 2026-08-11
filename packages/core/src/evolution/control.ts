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

import { generateText, type LanguageModel } from 'ai';
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
  DEFAULT_SHADOW_CONFIG, applyPromotionDecision, decidePromotion, getPendingScaffold,
  readScaffoldVersion,
} from '../scaffold/shadow.js';
import {
  DEFAULT_AUTO_JUDGE_CONFIG, runAutoShadowEval, type AutoShadowEvalResult,
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
   *  loop for THIS task. */
  readonly surface: (task: string) => ScaffoldSurface;
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

/**
 * The turn-bound half of the shadow loop: sample this turn, run the pending
 * scaffold against the same task the live answer answered, judge the two, and
 * promote or roll back.
 *
 * Written twice until now — once per backend — because it is the only
 * control-plane operation with a LIVE TURN in it, and each backend holds the
 * turn's prepared inference differently (a `_lastTurnOpts` stash on the DO, a
 * `liveTurnOpts` local on the CLI). That is the whole of the difference, and it
 * arrives here as `replayLiveTurn`: a candidate that delegates to the default
 * loop must replay the turn's OWN inference — same system prompt, same tool
 * surface, same conversational history — or it is judged on a handicap rather
 * than on the scaffold delta. Everything else (the sampling gate, the four
 * ports, the judge, swallowing failures so a shadow eval can never fail a turn)
 * is policy, and both copies had already drifted on the judge: cf sent
 * reasoning options derived from the CHAT model's provider family to a
 * cross-family REVIEW model, where they cannot apply.
 *
 * Returns the result for the caller's telemetry, or null when sampling is off
 * or the eval failed.
 */
export async function runTurnShadowEval(
  control: ScaffoldControl,
  turn: {
    task: string;
    /** What the live turn actually answered — the shadow run's comparand. */
    currentOutput: string;
    /** Replay of the live turn's prepared inference, captured synchronously by
     *  the caller so a later turn's state can never bleed into this one.
     *  Omitted when the host no longer holds it — a DO restarted between the
     *  live turn and this eval — and then the surface's own default loop
     *  stands in, under the live loop's full step envelope: a candidate judged
     *  against the live answer has to be allowed to reach one. */
    replayLiveTurn?: ScaffoldSurface['defaultInference'];
  },
): Promise<AutoShadowEvalResult | null> {
  try {
    const sampleRate = control.config.getShadowSampleRate();
    if (sampleRate <= 0) return null;
    const surface = control.surface(turn.task);
    const defaultInference = turn.replayLiveTurn ?? surface.defaultInference;
    return await runAutoShadowEval({
      rt: control.rt,
      // Passed WHOLE. runAutoShadowEval owns the evidence budget and applies it
      // once, to the judge and the trial row together; a second clamp here both
      // duplicated the policy and lied about it — windowing an already windowed
      // string reports the second pass's omission count, not the total. It also
      // mattered beyond tidiness: `task` is what the PENDING scaffold is run on,
      // so a slice here would ask the pending to answer a truncated version of
      // the question the live turn answered in full, then judge the two against
      // each other.
      task: turn.task,
      currentOutput: turn.currentOutput,
      judge: (prompt, schema) => control.judge({ schema, prompt }),
      llmStream: surface.llmStream,
      ...(surface.callTool ? { callTool: surface.callTool } : {}),
      ...(surface.history ? { history: surface.history } : {}),
      ...(defaultInference ? { defaultInference } : {}),
      config: {
        ...DEFAULT_AUTO_JUDGE_CONFIG,
        sampleRate,
        autoApply: control.config.getAutoPromoteScaffold(),
      },
    });
  } catch (err) {
    console.warn('[proteus] shadow eval failed:', err instanceof Error ? err.message : err);
    return null;
  }
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
