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

import type { AgentRuntime } from '../types/agent-runtime';
import type { LLM, SqlExecutor } from '../types/primitives';
import type { AgentConfigStore } from '../config/store';
import { clampGepaEvalBudget } from '../config/store';
import { beginModelOperation, type ModelCallSink, type ModelOperationSink } from '../events/model-call';
import { normalizeUsage } from '../usage';
import { effortFor } from '../strategy/effort';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { extractJsonObject, generateJson, jsonObjectOnlyInstruction } from '../prompts/structured';
import {
  runScaffold, scaffoldEventText,
  type ScaffoldRunOptions, type ScaffoldRunResult,
} from '../scaffold/executor';
import { modifyScaffold } from '../scaffold/modify';
import { listScaffoldArchive, type ScaffoldArchiveEntry } from '../scaffold/archive';
import {
  DEFAULT_SHADOW_CONFIG, MAX_QUEUED_SHADOW_TRIALS, applyPromotionDecision, countQueuedShadowTrials,
  decidePromotion, dropQueuedShadowTrial, getPendingScaffold, listQueuedShadowTrials,
  purgeQueuedShadowTrials, queueShadowTrial, readScaffoldVersion,
} from '../scaffold/shadow';
import type { ShadowTrialDrain, ShadowTrialQueueOutcome, ShadowTrialTurn } from './types';
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
  finishGepaRun, lastGepaRunPerTarget, makePersistingHook, startGepaRun,
} from './gepa/persistence';
import type { EvalInstance, MetricOutcome, ReflectionLM } from './gepa/types';
import { scoreInterval, type ScoreInterval } from '../utils/stats';
import { nanoid } from '../utils/nanoid';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

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
  readonly config: Pick<
    AgentConfigStore,
    'getShadowSampleRate' | 'getAutoPromoteScaffold' | 'getGepaEvalBudget'
  >;
  /** Resolved per call against the task being run, so a control-plane
   *  operation issued mid-session runs the candidate against the tools the
   *  session has right now, and `defaultInference` delegates to the ordinary
   *  loop for THIS task. `context` is the conversation that task was asked in,
   *  which a delegating candidate must be given or it answers a
   *  context-dependent task from the task text alone; empty for the one-shot
   *  operations (preview, GEPA rollout, replay), which have none. */
  /** `callScope`, when the caller can be re-driven: it makes the rollout's tool
   *  call ids reproducible so the effect claim can dedupe a replay. Omitted by
   *  callers with no durable identity — a live preview, a GEPA candidate. */
  readonly surface: (
    task: string, context?: ScaffoldReplayContext, callScope?: string,
  ) => ScaffoldSurface;
  /** The chat model — what a candidate loop and the reflection LM run on. */
  readonly model: () => LanguageModel | Promise<LanguageModel>;
  /**
   * The judge. Must NOT be the chat model: GEPA is the largest judge consumer
   * in the system, and letting a model grade its own candidates is exactly the
   * self-enhancement bias (arXiv:2306.05685) every other scorer here routes
   * around. Backends build this over their cross-family review model.
   */
  readonly judge: JsonGenerator;
  /**
   * Where this plane's own model calls are reported, as `reflection` spend.
   *
   * Evolution is the largest non-turn producer in the system — a GEPA pass runs
   * one candidate rollout plus one judge call per metric evaluation, times the
   * eval budget, and none of it is a turn step. The rollout reports itself
   * through the scaffold stream and the judge through whichever model the
   * backend built it over; this field is for the piece that has no other seam,
   * the reflection LM that rewrites the scaffold.
   *
   * Optional: a backend that wires no sink runs the plane exactly as before.
   */
  readonly reportModelCall?: ModelCallSink;
  /**
   * Where this plane's operation lifecycle goes — the start/end pair that
   * names what was in flight when a process died. Same optional contract as
   * the sink above: absent means the plane's in-flight work is unattributable,
   * which the ledger states rather than hides. Backends build both from one
   * recorder through {@link recordModelOperations}.
   */
  readonly operations?: ModelOperationSink;
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
 * Run a scaffold against a task and return the text it produced. With
 * `candidateCode` this is the GEPA metric's rollout; without it, it rolls the
 * LIVE scaffold — the replay-eval harness's current-config runner.
 *
 * The rollout carries no elapsed deadline, like the live turn: this run IS
 * the candidate's score, and a candidate cut off early would score as a bad
 * candidate rather than be measured.
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
 * Execute the current scaffold for a one-shot task and return everything it
 * emitted, injecting nothing back into the conversation — how a scaffold
 * mutation is tried without touching the live turn loop. `useShadowOverride`
 * runs the pending version instead, when one exists.
 */
export async function runScaffoldOnce(
  control: ScaffoldControl,
  task: string,
  opts?: { useShadowOverride?: boolean },
): Promise<ScaffoldRunResult> {
  const pending = opts?.useShadowOverride ? getPendingScaffold(control.sql) : null;
  const codeOverride = pending ? await readScaffoldVersion(control.rt, pending.version) : null;
  return runScaffold(scaffoldRunOptions(control, task, {
    scaffoldCodeOverride: codeOverride ?? undefined,
  }));
}

/**
 * The turn-bound half of the shadow loop — and ALL of it that a turn pays for:
 * sample this turn, and if it is in the sample, write ONE row recording the
 * task, what the live turn answered, and the conversation it answered in.
 *
 * The trial itself — a whole candidate turn plus two judge calls, minutes of
 * wall clock — is NOT run here. It used to be, on the turn's own lane, which
 * meant the promotion gate resolved candidates against the user's clock: a
 * `kinu exec` process waited up to its settle bound for a rollout, and a
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
/**
 * WHICH candidate this turn is sampled against, or null for a turn that is not
 * sampled — the whole decision half of {@link queueTurnShadowTrial}, split out so
 * a caller that owes the queueing can make it ONCE and record it.
 *
 * Both halves move: the rate is a coin flip, and the pending candidate is
 * promoted and replaced. Re-asking on a replay therefore performs a DIFFERENT
 * obligation than the one that was owed — a turn the first attempt declined gets
 * enqueued, and a sampled one gets scored against a candidate that was not under
 * trial when it ran. The version travels with the answer for that second reason.
 */
export function shadowTrialPlan(control: ScaffoldControl, turnKey: string): number | null {
  // An empty key is every unkeyed turn's key. Hashing it answers the same way for
  // all of them — permanently in or permanently out of the evidence, depending on
  // the rate — which is a stable BIAS, not a stable decision. Such a turn has no
  // durable identity to record a trial under either, so it offers none.
  if (turnKey === '') return null;
  const sampleRate = control.config.getShadowSampleRate();
  if (sampleRate <= 0) return null;
  const pending = getPendingScaffold(control.sql);
  if (!pending) return null;
  if (sampleFraction(turnKey) >= sampleRate) return null;
  return pending.version;
}

/**
 * A stable fraction in [0, 1) for one turn — the coin flip, made reproducible.
 *
 * A caller that OWES this decision may be asked for it more than once: a
 * duplicate callback rebuilds the whole declaration before the ledger recognises
 * it. A fresh `Math.random()` there answers differently and the sequence claims a
 * different set of rows than the one already on record. Derived from the turn's
 * own id instead, the answer is the same every time it is asked, while remaining
 * uniform across turns.
 */
function sampleFraction(turnKey: string): number {
  // FNV-1a, 32-bit. Not a security hash — it needs to spread short, similar ids
  // evenly, and it needs to be the same three lines on every backend.
  let hash = 0x811c9dc5;
  for (let i = 0; i < turnKey.length; i++) {
    hash ^= turnKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

export function queueTurnShadowTrial(
  control: ScaffoldControl,
  turn: ShadowTrialTurn,
  /** The stable row identity for a caller that owes this queueing — see
   *  `queueShadowTrial` — and the RECORDED plan a replaying caller made the first
   *  time. Without the plan this call decides afresh, which is right for a live
   *  caller and wrong for one replaying a recorded obligation. */
  opts?: { readonly id?: string; readonly pendingVersion?: number },
): ShadowTrialQueueOutcome {
  try {
    // A RECORDED plan skips the policy entirely — that decision was made and
    // written when the turn ended, and re-deciding here is what a replay must not
    // do. Without one this is a live caller, and it decides now.
    let pendingVersion = opts?.pendingVersion;
    if (pendingVersion === undefined) {
      const sampleRate = control.config.getShadowSampleRate();
      if (sampleRate <= 0) return 'not_sampled';
      const pending = getPendingScaffold(control.sql);
      if (!pending) return 'no_pending';
      if (Math.random() >= sampleRate) return 'not_sampled';
      pendingVersion = pending.version;
    }
    const trial = {
      pendingVersion,
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
    };
    return queueShadowTrial(
      control.sql,
      opts?.id === undefined ? trial : { ...trial, id: opts.id },
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
      // Scoped on the QUEUE ROW: a re-drive after an interruption reproduces the
      // same call ids, so the tool-effect claim recognises the rollout's external
      // work instead of running it a second time.
      const surface = control.surface(trial.task, trial.context, trial.id);
      let applied: 'promote' | 'rollback' | null = null;
      try {
        const result = await runAutoShadowEval({
          rt: control.rt,
          task: trial.task,
          currentOutput: trial.currentOutput,
          judge: (prompt, schema) => control.judge({ schema, prompt }),
          llmStream: surface.llmStream,
          callTool: surface.callTool,
          history: surface.history,
          defaultInference: surface.defaultInference,
          config: { ...DEFAULT_AUTO_JUDGE_CONFIG, autoApply: control.config.getAutoPromoteScaffold() },
          // The queue row's identity. It keys the evaluation AND gates the
          // rollout: an interruption between the score and the delete below must
          // not run the pending scaffold's tool calls a second time.
          trialId: trial.id,
        });
        applied = result.applied ?? null;
        if (!result.skipped) trials++;
      } catch (err) {
        // A trial that throws is a trial we cannot score, not a queue we should
        // wedge on: drop it below and carry on with the rest.
        diagnostics.failure(
          'evolution.shadow_trial_failed',
          toKinuError({ doing: 'run a queued shadow trial', cause: err, otherwise: 'unavailable' }),
          { trialId: trial.id },
        );
      }
      dropQueuedShadowTrial(control.sql, trial.id);
      if (applied) {
        purgeQueuedShadowTrials(control.sql, null);
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
    void control.sql`INSERT INTO evolution_events (id, type, message, data, created_at)
      VALUES (${nanoid()}, 'scaffold_proposed',
              ${`Agent proposed scaffold v${result.version}: ${rationale.slice(0, 80)}`},
              ${null}, ${Date.now()})`;
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

/**
 * GEPA's reflection LM, over the chat model, reporting as `reflection` spend.
 *
 * One for both targets. The reasoning effort is `scaffold_mutation` for a
 * prompt section too: the job is the same — read the failures, rewrite the
 * artifact — and a second effort key would be a second knob for one decision.
 */
function reflectionLmFor(control: ScaffoldControl, model: LanguageModel): ReflectionLM {
  return async (prompt) => {
    // The frame opens before the request: a GEPA pass killed mid-rewrite is
    // exactly the operation §9.1's start row exists to name.
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
    control.reportModelCall?.({ source: 'reflection', usage, modelId });
    return result.text;
  };
}

// ── GEPA offline scaffold optimisation ──────────────────────────────────────

const GepaScoreSchema = v.object({
  score: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  feedback: v.pipe(v.string(), v.minLength(1)),
});

/**
 * One judge call for every GEPA metric, with the one answer an unavailable
 * judge gets: a neutral 0.5. A 0 would read as "this candidate is bad" on
 * evidence nobody gathered.
 */
async function judgeScore(control: ScaffoldControl, prompt: string): Promise<MetricOutcome> {
  try {
    const scored = await control.judge({
      schema: GepaScoreSchema,
      prompt: `${prompt}\n\nJSON shape: {"score": <number 0..1>, "feedback": "<one sentence>"}.`,
    });
    return { score: scored.score, feedback: scored.feedback };
  } catch (err) {
    return { score: 0.5, feedback: `judge unavailable: ${renderThrownChain({ cause: err })}` };
  }
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
  // response the user approved; negatives are scored on whether the candidate
  // already addresses the complaint, whoever made it.
  const metric = async (
    candidate: string, instance: EvalInstance<string, OutcomeEvalExpectation>,
  ): Promise<MetricOutcome> => {
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

  // 3. Reflection LM — rewrites the artifact from the failure feedback.
  const reflectionLm = reflectionLmFor(control, model);

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
      onIteration: makePersistingHook({ sql: control.sql, runId, persisted }),
    });
  } catch (err) {
    const message = renderThrownChain({ cause: err });
    finishGepaRun(control.sql, {
      runId, status: 'aborted', stopReason: 'aborted', winnerId: null, metricCalls: 0, iterations: 0,
    });
    return { ok: false, error: message, runId };
  }

  finishGepaRun(control.sql, {
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

// ── GEPA offline prompt-section optimisation ────────────────────────────────

const SECTION_WORDING_RULE: OutcomeScoringRule = {
  accepted: 'Score 1.0 when the candidate wording would still have produced a response at least '
    + 'this good, 0.0 when it would have pushed the agent off it.',
  failed: 'Score 1.0 when the candidate wording would have prevented that failure, 0.0 when it '
    + 'would have changed nothing.',
};

/**
 * Score one candidate SECTION against one outcome-labeled turn.
 *
 * No rollout, and the omission is the point. A scaffold is code, so the only
 * way to know what it does is to run it; a prompt section is guidance the model
 * reads, and the question a labeled turn answers about it is counterfactual:
 * would this wording have prevented the correction the user wrote, or kept the
 * answer they accepted? Re-running a whole turn per instance would cost the
 * eval budget many times over to answer the same question with a sampled loop
 * in the way.
 *
 * That makes the score weaker evidence than a scaffold rollout, which is why
 * nothing here promotes: a winner lands PENDING and earns its way live through
 * held-out trials and the same calibrated rule (`prompting/section-store.ts`).
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
  /** Present when the gate refused — `size_rule` is the anti-bloat rule, not a
   *  fault, and callers report it as such. */
  refusal?: string;
  bestScore?: ScoreInterval;
  incumbentScore?: ScoreInterval;
  iterations?: number;
  /** Bytes the winner would add to every turn if promoted. Negative is the
   *  outcome worth celebrating. */
  byteDelta?: number;
  selectionWarning?: string;
}

/**
 * Run a GEPA pass over ONE prompt section.
 *
 * The scaffold sibling of this driver (`runScaffoldGepaOptimization`) draws the
 * same DISJOINT train/val split from the turn-outcome ledger, and for the same
 * reason: older corrected/frustrated turns are what reflection must fix, the
 * newest failures plus accepted-turn regression guards are what the winner is
 * SELECTED on. A section optimised against the turns it was selected on has
 * learned those turns, not the job.
 */
async function runPromptSectionGepaOptimization(
  control: ScaffoldControl,
  opts: { sectionId: string; maxIterations?: number; evalSize?: number; maxMetricCalls?: number },
): Promise<PromptSectionOptimizationResult> {
  const evalSize = clampGepaEvalBudget(opts.evalSize ?? control.config.getGepaEvalBudget());
  const split = buildOutcomeEvalSplit(control.sql, evalSize);
  if (split.degeneracy === 'no_labeled_turns' || split.degeneracy === 'no_negatives') {
    return { ok: false, error: describeSplitDegeneracy(split.degeneracy) };
  }

  const budget = {
    maxIterations: Math.max(1, Math.min(opts.maxIterations ?? 4, 20)),
    // A section metric call is ONE judge call, where a scaffold's is a whole
    // rollout plus a judge call, so the same iteration count buys more here.
    maxMetricCalls: Math.max(10, Math.min(opts.maxMetricCalls ?? 120, 400)),
    minibatchSize: 3,
  };
  const reflectionLm = reflectionLmFor(control, await control.model());

  const runId = startGepaRun(control.sql, {
    target: 'prompt_section', targetRef: opts.sectionId, budget,
  });
  const persisted = new Set<string>();
  let result;
  try {
    result = await runSectionGepa({
      sql: control.sql,
      sectionId: opts.sectionId,
      evalSet: split.val,
      trainSet: split.train,
      metric: sectionMetric(control, opts.sectionId),
      reflectionLm,
      budget,
      onIteration: makePersistingHook({ sql: control.sql, runId, persisted }),
    });
  } catch (err) {
    finishGepaRun(control.sql, {
      runId, status: 'aborted', stopReason: 'aborted', winnerId: null, metricCalls: 0, iterations: 0,
    });
    return { ok: false, error: renderThrownChain({ cause: err }), runId };
  }
  const gepa = result.gepa;
  finishGepaRun(control.sql, {
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
  /** No pending candidate for this section — nothing to trial. */
  pending: boolean;
  trialsRun: number;
  decision?: 'promote' | 'rollback' | 'continue';
  winRate?: number;
  action?: 'promote' | 'rollback';
  vetoReason?: string;
}

/**
 * The offline half: score the pending section against the incumbent on turns it
 * was never selected on, then let the calibrated rule decide.
 *
 * The shadow loop's discipline, kept: a trial is EXPENSIVE (two judge calls),
 * so it runs on the cadence lane and never on a user's turn; the two sources
 * are scored on the SAME instance so the comparison is paired; a tie is
 * recorded as a tie. What differs from the scaffold's loop is only what a trial
 * IS — no queue, because a section trial needs no live turn to ride on. It
 * needs a labeled turn, and the ledger already has those.
 */
async function runPromptSectionTrials(
  control: ScaffoldControl,
  sectionId: string,
  opts?: { trials?: number },
): Promise<PromptSectionTrialResult> {
  const pending = getPendingPromptSection(control.sql, sectionId);
  if (!pending) return { sectionId, pending: false, trialsRun: 0 };
  const section = findPromptSectionTarget(sectionId);
  if (!section) return { sectionId, pending: false, trialsRun: 0 };

  const incumbent = incumbentSectionSource(control.sql, section);
  const metric = sectionMetric(control, sectionId);
  // Drawn fresh each pass, so consecutive passes see the turns that happened in
  // between: the newest failures plus the accepted-turn guards, and never the
  // train half the candidate was written against.
  const split = buildOutcomeEvalSplit(control.sql, control.config.getGepaEvalBudget());
  const instances = split.val.slice(0, Math.max(1, opts?.trials ?? 3));

  let trialsRun = 0;
  for (const instance of instances) {
    const [current, candidate] = await Promise.all([
      metric(incumbent, instance),
      metric(pending.source, instance),
    ]);
    recordPromptSectionTrial(control.sql, {
      sectionId,
      pendingVersion: pending.version,
      instanceId: instance.id,
      currentScore: current.score,
      pendingScore: candidate.score,
      winner: candidate.score > current.score ? 'pending'
        : candidate.score < current.score ? 'current' : 'tie',
      feedback: candidate.feedback,
    });
    trialsRun += 1;
  }

  const settled = getPendingPromptSection(control.sql, sectionId);
  if (!settled) return { sectionId, pending: true, trialsRun };
  const verdict = decidePromptSectionPromotion(settled);
  const result: PromptSectionTrialResult = {
    sectionId, pending: true, trialsRun,
    decision: verdict.decision, winRate: verdict.winRate,
  };
  if (verdict.decision === 'continue') return result;
  const applied = applyPromptSectionDecision(control.sql, settled, verdict.decision);
  result.action = applied.action;
  if (applied.vetoReason) result.vetoReason = applied.vetoReason;
  return result;
}

/** What a measured proposal did. `code` names the bar rather than numbering it,
 *  for the same reason `ProposeSectionRefusal` does: a caller that must tell
 *  anti-bloat from a safety veto cannot branch on prose. */
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
 * Hand ONE externally authored section candidate to the proposal gate, having
 * first measured it.
 *
 * The sibling of `runPromptSectionGepaOptimization`, minus the search: GEPA
 * writes its own candidates and this takes one it was given, but both owe the
 * gate the same thing — a candidate and the incumbent scored on the SAME
 * held-out labeled turns, so `proposePromptSection`'s size rule is deciding on
 * measurement rather than on a proposer's confidence in itself.
 *
 * That is what makes an LLM-authored refinement unable to move the live prompt:
 * a candidate nobody could score never becomes a proposal, and a candidate that
 * becomes one lands PENDING and needs `advancePromptSectionLane`'s trials.
 *
 * A degenerate split is a REFUSAL and not a neutral score. Scoring a
 * counterfactual about a failure against a ledger holding no failures would
 * produce a number with nothing behind it, and the size rule would then trade
 * real bytes for it.
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
  const split = buildOutcomeEvalSplit(control.sql, clampGepaEvalBudget(control.config.getGepaEvalBudget()));
  if (split.degeneracy !== null) {
    return {
      ok: false, sectionId: section.id, code: 'degenerate_split',
      error: describeSplitDegeneracy(split.degeneracy),
    };
  }

  const incumbent = incumbentSectionSource(control.sql, section);
  const metric = sectionMetric(control, section.id);
  // The held-out half, exactly as the trials use it: a candidate measured on the
  // turns whoever wrote it was shown has learned those turns.
  const instances = split.val.slice(0, Math.max(1, input.trials ?? 3));
  const scored = await Promise.all(instances.map(async (instance) => Promise.all([
    metric(incumbent, instance),
    metric(input.source, instance),
  ])));
  const incumbentScore = scoreInterval(scored.map(([current]) => current.score));
  const candidateScore = scoreInterval(scored.map(([, candidate]) => candidate.score));

  const proposal = proposePromptSection(control.sql, {
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
 * Which section the next optimisation pass targets: the one whose last pass is
 * oldest, and a section never passed before any that has.
 *
 * DERIVED from `gepa_runs`, not stored. It used to be a Durable Object field
 * (`orchestrator.ts` `_nextPromptSection`) whose comment reasoned that an
 * eviction "costs one repeated section". Measured, it costs the rotation: the
 * cadence only reaches this decision on the tick where its own in-memory
 * counter hits `autoGepaEveryNTurns`, both counters live in the same
 * activation, so index k is reachable only inside an activation that already
 * served (k+1) x 25 qualifying turns. A probe over the real actor confirmed it —
 * the cursor advanced on ticks 25, 50 and 75 and appears in no durable table,
 * `agent_config` holding one key, the cadence. Against a joint idle-eviction
 * window measured at 2-5 minutes (`platform-catalog.ts`
 * `do.facet.eviction_joint`), the first section received every pass and the
 * other eight needed 225 consecutive turns with no pause.
 *
 * A stored cursor would fix it. Deriving it needs no new state at all: every
 * pass already writes its own `gepa_runs` row under `target_ref`, and a section
 * with no row has plainly never had a turn. The ordering is stable — ties break
 * on the registry's own order, so two never-passed sections resolve the way
 * `PROMPT_SECTIONS` declares them.
 */
function nextPromptSectionTarget(sql: SqlExecutor): PromptSection<string> | null {
  const lastPass = lastGepaRunPerTarget(sql, 'prompt_section');
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

/** What one turn of the prompt-section lane did. */
export type PromptSectionLaneStep =
  /** A candidate was under trial and got its trials. */
  | { readonly step: 'trials'; readonly sectionId: string; readonly trials: PromptSectionTrialResult }
  /** Nothing was pending, so the least-recently-passed section got a pass. */
  | { readonly step: 'pass'; readonly sectionId: string; readonly pass: PromptSectionOptimizationResult }
  /** No sections are registered. */
  | { readonly step: 'idle' };

/**
 * Advance the evolved-prompt-section loop by one step.
 *
 * A section under trial is FINISHED first, always: trials are what turn a
 * proposal into evidence, and a proposal nobody trials never lands. With
 * nothing pending, the next section in the rotation gets an optimisation pass,
 * so over nine cadence ticks every section has had one.
 *
 * Core rather than per backend because both halves of this — the order and the
 * selection — are policy over a `ScaffoldControl` with nothing platform-shaped
 * in them, and the order is exactly what a second backend would have to copy.
 * Two copies of "trials before a new pass" is one copy that eventually says
 * something else. What legitimately stays with the caller is the LIFECYCLE: how
 * a Durable Object gets this off its turn's critical path, and what it does with
 * a fault.
 */
export async function advancePromptSectionLane(
  control: ScaffoldControl,
): Promise<PromptSectionLaneStep> {
  const pending = firstPendingPromptSection(control.sql);
  if (pending !== null) {
    return { step: 'trials', sectionId: pending, trials: await runPromptSectionTrials(control, pending) };
  }
  const section = nextPromptSectionTarget(control.sql);
  if (!section) return { step: 'idle' };
  return {
    step: 'pass',
    sectionId: section.id,
    pass: await runPromptSectionGepaOptimization(control, { sectionId: section.id }),
  };
}

/** Structured output over a review LanguageModel at the judge stage's
 *  reasoning effort — what the cf actor builds over its cross-family review
 *  model. A bare sink rather than a `ModelCallSpend`: this factory IS one
 *  producer, so it supplies the `judge` label itself, and `generateJson` below
 *  is the substrate that needs telling. GEPA is the largest judge consumer in
 *  the system, which is why this seam's silence hid a whole producer. */
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

/** Structured output over core's `LLM` primitive — the same ask-for-JSON,
 *  extract, validate idiom `createStructuredJudge` uses, for a backend whose
 *  judge is an LLM rather than an ai-SDK LanguageModel.
 *
 *  No sink here, deliberately: `LLM.complete` returns text, so this side of the
 *  seam never sees a usage report to forward. The `LLM` it is handed is the one
 *  place that does, and it reports from its own construction
 *  (`createCompletionLLM({ spend: { source: 'judge', report } })`). A second
 *  channel here could only guess, or double-count. */
export function createLlmJsonJudge(llm: LLM): JsonGenerator {
  return async (opts) =>
    v.parse(opts.schema, extractJsonObject(await llm.complete(`${opts.prompt}\n\n${jsonObjectOnlyInstruction()}`)));
}
