/** The public run-event contract is derived from its one canonical stored/RPC schema. */
import * as v from 'valibot';
import type { JsonObject } from '../utils/json';
import type { ToolOutcome } from '../types/tool-outcome';
import type { RunEventSchema } from './recorder';

export type RunEvent = v.InferOutput<typeof RunEventSchema>;

export type RunEventType = RunEvent['type'];

export type RunEventBase = Pick<RunEvent, 'eventIndex' | 'runId' | 'type' | 'timestamp'>;

/** `usd` is absent when the model had no catalog rate, not zero. */
export type StepCost = Pick<Extract<RunEvent, { type: 'step_finish' }>, 'usage' | 'usd' | 'modelId'>;

/** `owner` is the human editing through the UI, not the agent. */
export const CONTEXT_EDIT_VIA = v.picklist(['file', 'session', 'owner']).options;

export type ContextEditVia = (typeof CONTEXT_EDIT_VIA)[number];

export const CONTEXT_EDIT_STATUSES = v.picklist(['staged', 'activated']).options;

export type ContextEditStatus = (typeof CONTEXT_EDIT_STATUSES)[number];

export const CONTEXT_EDIT_BOUNDARIES = v.picklist(['step', 'turn']).options;

export type ContextEditBoundary = (typeof CONTEXT_EDIT_BOUNDARIES)[number];

/** Enough admission identity to reopen a turn without copying its canonical transcript into events. */
export interface OpenTurnIdentity {
  turnId: string;
  messageId: string;
  kind: 'user' | 'programmatic';
  text: string;
  metadata?: JsonObject;
  pendingSendId?: string;
  steerIds?: readonly string[];
}

export type TurnSteeringRecord = Omit<Extract<RunEvent, { type: 'turn_steering' }>, keyof RunEventBase | 'type'>;

export type TurnSteeringTrigger = TurnSteeringRecord['trigger'];

export type CompletionGateRecord = Omit<Extract<RunEvent, { type: 'completion_gate' }>, keyof RunEventBase | 'type'>;

export type CraftCycleRecord = Omit<Extract<RunEvent, { type: 'craft_cycle' }>, keyof RunEventBase | 'type'>;

export type ExecutionRecoveryRecord = Omit<Extract<RunEvent, { type: 'execution_recovery' }>, keyof RunEventBase | 'type'>;

export type ApprovalConsumedRecord = Omit<Extract<RunEvent, { type: 'approval_consumed' }>, keyof RunEventBase | 'type'>;

/** Producers must describe each tool's outcome; all other fields follow the canonical variant unchanged. */
export type RunEventInput = {
  [K in RunEvent['type']]: Omit<Extract<RunEvent, { type: K }>, keyof RunEventBase> & { type: K }
    & (K extends 'tool_call_end' ? { outcome: ToolOutcome } : object)
}[RunEvent['type']];

/** Producer and failure census match the same sentinel for a nullish failed-call error. */
export const FAILURE_WITHOUT_ERROR = 'the tool reported failure without an error';
