/** The scaffold evolution control plane: backend-neutral drivers over the evolution primitives. A backend
 *  supplies only a {@link ScaffoldSurface}. */

import type { LanguageModel, ModelMessage } from 'ai';
import * as v from 'valibot';

import type { AgentRuntime } from '../types/agent-runtime';
import type { LLM, SqlExecutor } from '../types/primitives';
import type { ModelCallSink, ModelOperationSink } from '../events/model-call';
import { effortFor } from '../providers/effort';
import { extractJsonObject, generateJson, jsonObjectOnlyInstruction } from '../providers/structured';
import { runScaffold, type ScaffoldRunOptions, type ScaffoldRunResult } from '../scaffold/executor';
import { modifyScaffold } from '../scaffold/modify';
import type { ScaffoldVersionView } from '../types/scaffold';
import type { ActorHandle } from '../identity/actor-handle';
import type { SessionHistory } from '../session/history';
import { listScaffoldArchive } from '../scaffold/archive';
import {
  applyPromotionDecision, getPendingScaffold, readScaffoldVersion, type PendingScaffold, type ScaffoldDecisionEvents,
} from '../scaffold/versions';
import { listArtifactVersions, type ArtifactVersion } from './artifacts';
import { runningTrial } from './trials';
import type { LiveTrial } from './trial-rules';
import { runProposer, SCAFFOLD_ARTIFACT, type ProposerOutcome } from './proposer';
import { nanoid } from '../utils/nanoid';
import { KinuError, settle } from '../obs/index';
import { Effect } from 'effect';

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
  readonly reportModelCall: ModelCallSink;
  /** Operation lifecycle sink. Absent means in-flight work is unattributable. */
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

 * Run the current scaffold for a one-shot task without injecting into the
 * conversation. `useShadowOverride` runs the pending proposal instead.
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


/** Preview a scaffold version from its VFS `agent.js.vN` backup. */
export function previewScaffoldLive(
  control: ScaffoldControl,
  version: number,
  task: string,
): Promise<ScaffoldRunResult> {
  return settle(Effect.gen(function* () {
    const codeOverride = yield* Effect.promise(() => readScaffoldVersion(control.rt, version));

    if (codeOverride == null) {
      return yield* Effect.die(new Error(`previewScaffoldLive: no scaffold code found for v${version}`));
    }

    return yield* Effect.promise(() => runScaffold(scaffoldRunOptions(control, task, {
      scaffoldCodeOverride: codeOverride,
    })));
  }));
}

/** Propose a new scaffold version through modifyScaffold's gates. It lands `pending` for the owner's decision. */
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
  }));
}

/** What evolution has in flight: the scaffold proposal awaiting the owner, the live trial, and the edits waiting for one. */
export interface EvolutionStatus {
  readonly pendingScaffold: PendingScaffold | null;
  readonly trial: LiveTrial | null;
  readonly waiting: readonly ArtifactVersion[];
  readonly versions: readonly ScaffoldVersionView[];
}

export function getEvolutionStatus(sql: SqlExecutor, actor: ActorHandle): EvolutionStatus {
  return {
    pendingScaffold: getPendingScaffold(sql, actor),
    trial: runningTrial(sql, actor),
    waiting: listArtifactVersions(sql, actor).filter((version) => version.status === 'candidate'),
    versions: listScaffoldVersions(sql, actor, 10),
  };
}

export type ScaffoldDecisionResult = Awaited<ReturnType<typeof applyPromotionDecision>> & { readonly fromVersion: number };

/** The owner's decision on the pending scaffold. The misevolution recheck can still turn a promote into a rollback, so the result reports the action applied. */
export async function applyScaffoldDecision(control: ScaffoldControl, mode: 'promote' | 'rollback'): Promise<ScaffoldDecisionResult> {
  const pending = getPendingScaffold(control.sql, control.rt.actor);

  if (pending === null) return settle(Effect.fail(new KinuError('missing', 'no pending scaffold')));
  const result = await applyPromotionDecision(control.rt, pending, mode, control.events);

  return { fromVersion: pending.version - (mode === 'promote' ? 1 : 0), ...result };
}

/**
 * The manual optimisation RPCs: one search of the proposer on the named artifact (`scaffold`, or an
 * `artifact_versions` id), its bad set the recent low-rated turns. The edit waits like any other.
 */
export async function runOptimization(control: ScaffoldControl, target: string = SCAFFOLD_ARTIFACT): Promise<ProposerOutcome> {
  // Asked only once there are turns to judge: with none the search is idle and needs no model.
  const decide = control.rt.decide ?? (() => settle(Effect.fail(new KinuError('unavailable', 'no decision model is wired, so no edit can be judged'))));

  return runProposer({ rt: control.rt, decide, reflect: control.rt.judgeModel ?? control.rt.llm, now: Date.now() }, target);
}


export function createJsonJudge(
  model: () => LanguageModel | Promise<LanguageModel>,
  reportModelCall: ModelCallSink,
  operations?: ModelOperationSink,
): JsonGenerator {
  return async (opts) => generateJson({
    model: await model(),
    schema: opts.schema,
    prompt: opts.prompt,
    providerOptions: effortFor('judge').providerOptions,
    spend: { source: 'judge', report: reportModelCall, operations },
  });
}

/** Structured output over core's `LLM`. No sink: the `LLM` reports its own spend,
 *  and a second channel would double-count. */
export function createLlmJsonJudge(llm: LLM): JsonGenerator {
  return async (opts) =>
    v.parse(opts.schema, extractJsonObject(await llm.complete(`${opts.prompt}\n\n${jsonObjectOnlyInstruction()}`)));
}
