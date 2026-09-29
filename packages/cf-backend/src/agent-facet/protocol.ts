/** What crosses between the workspace object and an agent's isolate: plain data, cloned per hop. */
import type { JSONSchema7, ModelMessage } from 'ai';
import type { CompletedTurn, DynamicContext, HeadCapture, HeadInput, JsonValue, ModelPricing, JsonObject, ProfileAuthorityInputs, ResolvedTurnProfile, WorkMode } from '@kinu.run/core';

export type StoredRow = Readonly<Record<string, SqlStorageValue>>;

export interface AgentSnapshot {
  readonly identity: StoredRow;
  readonly lineage: readonly StoredRow[];
  readonly workspaceName: string;
  readonly installedBuild: string | null;
  readonly artifactDirectory: string;
}

export interface AgentOpening {
  readonly id: string;
  readonly message: ModelMessage;
  readonly metadata: JsonObject;
}

export interface AgentTask {
  readonly sequenceId: string;
  readonly body: string;
  readonly mode: WorkMode;
}

export interface AgentToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema7;
}

export interface PreparedAgentTurn {
  readonly input: HeadInput;
  readonly birthContext: readonly ModelMessage[];
  readonly model: string;
  readonly pricing: ModelPricing | null;
  readonly framing: { readonly system: string; readonly messages: readonly ModelMessage[] };
  readonly tools: readonly AgentToolDescriptor[];
  readonly dynamic: DynamicContext;
}

export interface AgentTurnProfile {
  readonly profile: ResolvedTurnProfile;
  readonly inputs: ProfileAuthorityInputs;
  readonly dynamic: DynamicContext;
}

export interface AgentActivity {
  readonly event: string;
  readonly detail?: string;
}

export interface AgentToolCall {
  readonly activity: readonly AgentActivity[];
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
}

export interface AgentReview {
  readonly turnId: string;
  readonly turn: CompletedTurn;
  readonly reachable: readonly string[];
  readonly mode: WorkMode;
}

export interface AgentCaptureDelta {
  readonly evidence: HeadCapture['evidence'];
  readonly decisions: HeadCapture['decisions'];
  readonly artifacts: HeadCapture['artifacts'];
  readonly toolCalls: HeadCapture['toolCalls'];
  readonly childHeadIds: HeadCapture['childHeadIds'];
}

export interface AgentToolAnswer {
  readonly output: unknown;
  readonly captured: AgentCaptureDelta;
  readonly dynamic: DynamicContext;
}

export interface AgentTurnEnd {
  readonly activity: readonly AgentActivity[];
  readonly status: 'completed' | 'aborted' | 'budget_exceeded' | 'errored';
  readonly summary: string;
  readonly errorMessage: string | null;
  readonly narration: string;
}

export interface AgentRecovery {
  readonly stalled: readonly { readonly turnId: string; readonly runs: number; readonly workMode: WorkMode }[];
}
