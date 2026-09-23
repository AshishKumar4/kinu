/** Run events: persisted in run_events, served by /api/runs/<runId>/events and /stream (SSE). */

import type { ModelMessage } from 'ai';
import type { ContextBudgetSnapshot } from '../context-budget';
import type { JsonObject, JsonValue } from '../utils/json';
import type { ContextComposition } from '../context-meter';
import type { FileEditSnapshot } from '../types/file-edits';
import type { DbOpRecord } from '../types/app-store';
import type { EscalationSnapshot } from '../execution/escalation';
import type { MissionBudgetRefusal } from '../mission-budget';
import type { HeadFileChangeSet } from '../types/heads';
import type { Usage } from '../usage';
import type { ToolOutcome } from '../types/tool-outcome';
import type { WorkMode } from '../types/turn';
import type {
  SpendSource, ModelOperationKind, ModelOperationOutcome, ModelOperationPhase,
} from './model-call';

/** `usd` is present only when the model had a catalog rate; absent means unpriced, never free. */
export type StepCost = Pick<
  Extract<RunEvent, { type: 'step_finish' }>, 'usage' | 'usd' | 'modelId'
>;

/** Explicit list: `RunEventBase` carries `type`, so deriving it from the union is circular. */
export type RunEventType =
  | 'run_start'
  | 'turn_start'
  | 'tool_call_end'
  | 'step_finish'
  | 'step_partial'
  | 'model_call'
  | 'provider_wait'
  | 'model_fallback'
  | 'model_operation'
  | 'head_split'
  | 'head_merge'
  | 'head_abandoned'
  | 'scaffold_promotion'
  | 'scaffold_rollback'
  | 'memory_write'
  | 'db_op'
  | 'context_edit'
  | 'context_budget'
  | 'file_edit'
  | 'turn_steering'
  | 'profile_resolution'
  | 'completion_gate'
  | 'craft_cycle'
  | 'execution_recovery'
  | 'approval_consumed'
  | 'execution_escalation'
  | 'budget_exhausted'
  | 'fiber_recovered'
  | 'error'
  | 'turn_end'
  | 'run_end';

/** `owner` is a human editing through the UI, a different authority from the agent. */
export const CONTEXT_EDIT_VIA = ['file', 'session', 'owner'] as const;

export type ContextEditVia = (typeof CONTEXT_EDIT_VIA)[number];

export const CONTEXT_EDIT_STATUSES = ['staged', 'activated'] as const;

export type ContextEditStatus = (typeof CONTEXT_EDIT_STATUSES)[number];

export const CONTEXT_EDIT_BOUNDARIES = ['step', 'turn'] as const;

export type ContextEditBoundary = (typeof CONTEXT_EDIT_BOUNDARIES)[number];

export interface RunEventBase {
  readonly eventIndex: number;
  readonly runId: string;
  readonly type: RunEventType;
  readonly timestamp: string;
}

/** What the loop needs to re-open a turn after its process died. Only on turn-loop runs. */
export interface OpenTurnIdentity {
  readonly turnId: string;
  readonly messageId: string;
  readonly kind: 'user' | 'programmatic';
  readonly text: string;
  readonly metadata?: JsonObject;
  readonly pendingSendId?: string;
  readonly steerIds?: readonly string[];
}

export interface PartialToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly result?: string;
  readonly error?: string;
}

export type RunEvent =
  | (RunEventBase & { type: 'run_start'; agentId: string; userMessage?: string;
      caused_by?: string;
      ingress_kind?: string;
      trigger_id?: string;
      turn?: OpenTurnIdentity })
  | (RunEventBase & { type: 'turn_start'; turnIndex: number })
  /** There is no `tool_call_start`; this row carries identity, input and outcome. `args` is a
   *  digest (`digestJsonValue`). Rows lacking `outcome` are unmeasured. */
  | (RunEventBase & { type: 'tool_call_end'; name: string; toolCallId: string;
      args?: JsonValue; result?: JsonValue; error?: string; durationMs?: number; outcome?: ToolOutcome })
  /** The durable record of one step's output; pairing holds within a row, so a run's rows
   *  concatenate into a valid request. `usdFloorTokens` is present only when `usd` is a floor. */
  | (RunEventBase & {
      type: 'step_finish';
      stepIndex: number;
      reason?: string;
      /** In the session codec's durable form (`session/message-codec.ts`); the recorder encodes. */
      messages?: JsonValue[];
      usage?: Usage;
      usd?: number;
      usdFloorTokens?: number;
      modelId?: string;
      context?: ContextComposition;
    })
  /** Superseded by the step's `step_finish`; the newest row of an unfinished step is where a
   *  continuation resumes. */
  | (RunEventBase & { type: 'step_partial'; stepIndex: number; text: string; toolCalls: readonly PartialToolCall[] })
  /** A model call that is not a turn step; separate from `step_finish` so it stays out of the
   *  prefix-cache EMA. `usage` is always written (`{}` = unmeasured); `usd` uses the call's own model. */
  | (RunEventBase & {
      type: 'model_call';
      source: SpendSource;
      usage?: Usage;
      usd?: number;
      usdFloorTokens?: number;
      spec?: string;
      modelId?: string;
    })
  /** Start/end pair: a start without an end marks a dead process
   *  (`RunEventRecorder.unterminatedModelOperations`). The census reads `model_call`, not this. */
  | (RunEventBase & {
      type: 'model_operation';
      operationId: string;
      source: SpendSource;
      op: ModelOperationKind;
      phase: ModelOperationPhase;
      outcome?: ModelOperationOutcome;
      usage?: Usage;
      spec?: string;
      modelId?: string;
      error?: string;
    })
  /** One row per declared transport sleep (Retry-After, backoff, or pacer cooldown join). */
  | (RunEventBase & {
      type: 'provider_wait';
      provider: string;
      modelId?: string;
      waitMs: number;
      /** 1-based; 0 for a pacer cooldown join before the first attempt. */
      attempt: number;
      status?: number;
      source: 'header' | 'backoff' | 'cooldown';
    })
  | (RunEventBase & { type: 'model_fallback'; from: string; to: string; reason: string })
  | (RunEventBase & { type: 'head_split'; rootId: string; headIds: string[]; rationale: string })
  /** `totalTokens` is absent when no head reported usage: unknown, not zero. */
  | (RunEventBase & { type: 'head_merge'; rootId: string; headCount: number;
      headsWithFindings: number; totalTokens?: number; mergedNarrative: string;
      fileChanges: HeadFileChangeSet[];
      /** Empty on the deterministic empty-split and merge-fallback paths. */
      blindSpots: string[] })
  /** Terminal counterpart to `head_split` when `head_merge` never arrives (heads/reconcile.ts). */
  | (RunEventBase & { type: 'head_abandoned'; rootId: string; headCount: number;
      abandoned: number; rationale: string; reason: string })
  | (RunEventBase & { type: 'scaffold_promotion'; fromVersion: number; toVersion: number })
  | (RunEventBase & { type: 'scaffold_rollback'; fromVersion: number; toVersion: number })
  | (RunEventBase & { type: 'memory_write'; path: string; bytes: number })
  /** Written inside the mutation's transaction, so a row proves the write committed. */
  | (RunEventBase & { type: 'db_op' } & DbOpRecord)
  /** Two per landed edit: `staged` (accepted, `stepIndex` null) and `activated` (consumed by a
   *  boundary). A refused edit writes neither. */
  | (RunEventBase & { type: 'context_edit'; contextId: string; proposalId: string; revision: number; baseRevision: number;
      messageCount: number; author: string;
      via: ContextEditVia; status: ContextEditStatus; effectiveAt: ContextEditBoundary;
      turnId: string | null; stepIndex: number | null })
  | (RunEventBase & { type: 'context_budget' } & ContextBudgetSnapshot)
  | (RunEventBase & { type: 'file_edit' } & FileEditSnapshot)
  /** Declared here rather than imported from orchestrator/turn-steering.ts to keep the producer's
   *  mid-turn machinery out of this widely reachable union. */
  | (RunEventBase & { type: 'turn_steering';
      trigger: 'repeated_call' | 'repeated_failure' | 'no_progress';
      step: number;
      /** Not set for the stall trigger. */
      tool?: string;
      converted: boolean })
  | (RunEventBase & { type: 'profile_resolution';
      durationMs: number;
      providerCache: 'hit' | 'joined' | 'miss';
      providerRevision: string;
      unavailableProviders: number;
      catalogVersion: number;
      authority: 'local' | 'account' })
  | (RunEventBase & { type: 'completion_gate';
      converted: boolean })
  | (RunEventBase & { type: 'craft_cycle';
      crafted: string[];
      invoked: string[];
      /** Crafted this turn and called by a later execute call. */
      reused: string[];
      returned: number;
      raised: number;
      /** Pushed below the injection floor this turn. */
      dropped: string[] })
  | (RunEventBase & { type: 'execution_recovery';
      recoveries: Array<{
        tool: string;
        failures: number;
        failedSignature: string }> })
  | (RunEventBase & { type: 'execution_escalation' } & EscalationSnapshot)
  | (RunEventBase & { type: 'budget_exhausted' } & Omit<MissionBudgetRefusal, 'error'>)
  | (RunEventBase & { type: 'fiber_recovered'; fiberName: string; fiberId: string; snapshot?: unknown })
  /** The only durable consumption record; safety/deferred-approval.ts spends by deleting. */
  | (RunEventBase & { type: 'approval_consumed'; approvalId: string;
      command: string; executor: string })
  | (RunEventBase & { type: 'error'; message: string; details?: unknown })
  | (RunEventBase & { type: 'turn_end'; turnIndex: number;
      /** Absent on older rows; absence means before the denominator started, never build. */
      workMode?: WorkMode; usage?: Usage })
  | (RunEventBase & { type: 'run_end'; reason?: string;
      error?: string });

export type TurnSteeringRecord =
  Omit<Extract<RunEvent, { type: 'turn_steering' }>, keyof RunEventBase | 'type'>;

export type TurnSteeringTrigger = TurnSteeringRecord['trigger'];

export type CompletionGateRecord =
  Omit<Extract<RunEvent, { type: 'completion_gate' }>, keyof RunEventBase | 'type'>;

export type CraftCycleRecord =
  Omit<Extract<RunEvent, { type: 'craft_cycle' }>, keyof RunEventBase | 'type'>;

export type ExecutionRecoveryRecord =
  Omit<Extract<RunEvent, { type: 'execution_recovery' }>, keyof RunEventBase | 'type'>;

export type ApprovalConsumedRecord =
  Omit<Extract<RunEvent, { type: 'approval_consumed' }>, keyof RunEventBase | 'type'>;

export type RunEventInput = {
  [K in RunEvent['type']]: Omit<Extract<RunEvent, { type: K }>, keyof RunEventBase | (K extends 'step_finish' ? 'messages' : never)> & { type: K }
    & (K extends 'tool_call_end' ? { outcome: ToolOutcome } : object)
    & (K extends 'step_finish' ? { messages?: ModelMessage[] } : object)
}[RunEvent['type']];

/** Sentinel so a failed call with a nullish error still reads as an error; producer and census
 *  both match it. */
export const FAILURE_WITHOUT_ERROR = 'the tool reported failure without an error';
