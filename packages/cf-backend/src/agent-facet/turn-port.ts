/**
 * An execution's calls to its workspace, bound to its {@link TurnCapability} (design v2 §3): the workspace refuses each
 * once Stop, the execution's close or a later epoch of its key supersedes the capability. Receipts are read under its
 * close and never execute anything.
 */
import type { AgentToolAnswer, AgentTurnActivity, JsonValue, RemoteReceipt, TurnCapability } from '@kinu.run/core';

export interface TurnToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly activity: readonly AgentTurnActivity[];
}

export interface TurnPort {
  readonly capability: TurnCapability;
  executeTool(call: TurnToolCall): Promise<AgentToolAnswer>;
  /** The workspace's receipts for calls whose facet row is a pointer; a call with no receipt is absent. */
  receipts(callIds: readonly string[]): Promise<ReadonlyMap<string, RemoteReceipt>>;
}
