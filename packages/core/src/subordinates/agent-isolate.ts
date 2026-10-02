import type { JSONSchema7, ModelMessage } from 'ai';
import type { CompletedTurn } from '../evolution/types';
import type { DynamicContext } from '../prompting/volatile-context';
import type { HeadCapture, HeadInferenceDeps } from '../heads/head-inference';
import type { HeadInput, HeadReport, HeadStep } from '../heads/types';
import type { HeadStreamKind } from '../heads/head-stream';
import type { JsonObject, JsonValue } from '../utils/json';
import type { ModelPricing } from '../providers/types';
import type { ProfileAuthorityInputs, ResolvedTurnProfile } from '../profiles/resolve';
import type { WorkMode } from '../types/turn';

export type StoredRow = Readonly<Record<string, string | number | ArrayBuffer | null>>;

export interface AgentSnapshot {
  readonly identity: StoredRow;
  readonly lineage: readonly StoredRow[];
  readonly config: readonly StoredRow[];
  readonly workspaceName: string;
  readonly installedBuild: string | null;
  readonly artifactDirectory: string;
}

export interface AgentTurnOpening {
  readonly id: string;
  readonly message: ModelMessage;
  readonly metadata: JsonObject;
}

export interface AgentTurnTask {
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
  readonly window: HeadInferenceDeps['window'];
  readonly pricing: ModelPricing | null;
  readonly accounts: Readonly<Record<string, string>>;
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

export interface AgentTurnActivity {
  readonly event: string;
  readonly detail?: string;
}

export interface AgentToolCall {
  readonly activity: readonly AgentTurnActivity[];
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

export interface AgentTrace {
  readonly kind: 'step';
  readonly sequence: number;
  readonly step: HeadStep;
}

export interface AgentHeadDelta {
  readonly kind: HeadStreamKind;
  readonly delta: string;
}

export interface AgentTurnEnd extends Omit<HeadReport, 'errorMessage'> {
  readonly activity: readonly AgentTurnActivity[];
  readonly errorMessage: string | null;
  readonly narration: string;
  readonly produced?: readonly ModelMessage[];
}

export interface TurnRequestAt {
  readonly turnId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly from?: number;
}

export interface AgentRecovery {
  readonly stalled: readonly { readonly turnId: string; readonly runs: number; readonly workMode: WorkMode }[];
}
