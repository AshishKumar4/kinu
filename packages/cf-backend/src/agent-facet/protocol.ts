/** Plain turn data crossing between the workspace and an agent's isolate. */
import type { JSONSchema7, ModelMessage } from 'ai';
import type { BindingFailure, CompletedTurn, DynamicContext, HeadCapture, HeadInput, HeadInferenceDeps, HeadReport, HeadStep, HeadStreamKind, JsonValue, ModelPricing, JsonObject, ProfileAuthorityInputs, ResolvedTurnProfile, WorkMode } from '@kinu.run/core';
import { Effect } from 'effect';
import { settleSync } from '@kinu.run/core/obs';

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
  readonly planAllowed: boolean;
}

export interface PreparedAgentTurn {
  readonly input: HeadInput;
  readonly runId: string;
  readonly birthContext?: readonly ModelMessage[];
  readonly model: string;
  readonly pricing: ModelPricing | null;
  readonly scaffold: StoredRow;
  readonly languages: readonly [string, ...string[]];
  readonly framing?: HeadInferenceDeps['framing'];
  readonly workspaceLayout: HeadInferenceDeps['workspaceLayout'];
  readonly tools: readonly AgentToolDescriptor[];
  readonly dynamic: DynamicContext;
  readonly missionLabels?: readonly string[];
  readonly trace: boolean;
  readonly resume: boolean;
  readonly reportMessages: boolean;
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
  readonly output?: unknown;
  readonly failure?: Omit<BindingFailure, 'tool' | 'action'>;
  readonly captured: AgentCaptureDelta;
  readonly dynamic: DynamicContext;
}

export function agentToolFailure(failure: NonNullable<AgentToolAnswer['failure']>): never {
  return settleSync(Effect.die(new Error(failure.error, { cause: failure })));
}

export type AgentTrace =
  | { readonly kind: 'step'; readonly sequence: number; readonly step: HeadStep }
  | { readonly kind: HeadStreamKind; readonly delta: string };

export interface AgentTurnEnd extends Omit<HeadReport, 'errorMessage'> {
  readonly activity: readonly AgentActivity[];
  readonly errorMessage: string | null;
  readonly narration: string;
  readonly produced?: readonly ModelMessage[];
}

export interface AgentRecovery {
  readonly stalled: readonly { readonly turnId: string; readonly runs: number; readonly workMode: WorkMode }[];
}
