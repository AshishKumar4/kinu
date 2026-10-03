
import type { Usage } from '../usage';
import type { JsonObject, JsonValue } from '../utils/json';
import type { MissionGovernor } from '../mission-budget';
import type { ToolOutcome } from '../tools/outcome';
import type { Struggle } from './struggles';
import type { TrialTurn } from './trial-rules';

export interface ToolCallRecord {
  toolCallId?: string;
  name: string;
  args: JsonObject;
  result?: JsonValue;
  /** Absent on turns recorded before invocation outcomes were persisted. */
  outcome?: ToolOutcome;
}

export interface CompletedTurn {
  userMessage: string;
  assistantResponse: string;
  toolCalls: ToolCallRecord[];
  /** Crafted tools this turn called, per the craft clock. Not derivable from `toolCalls`:
     *  crafted tools are codemode-only. Empty = observed none; absent = not observed. */
  craftedToolsUsed?: readonly string[];
  steps: number;
  durationMs: number;
  /** Null at completion; set later by EvolutionEngine.reviewTurn. */
  feedback: 'positive' | 'negative' | null;
  hadError: boolean;
  /** Durable id of the turn's assistant message. */
  turnId?: string;
  sessionId?: string;
  /** Only user-origin turns treat user follow-ups as verdicts. */
  origin?: 'user' | 'programmatic';
  usage?: Usage;
  /** Mission labels stamped when the turn ended. Carried by the turn because a deferred
     *  review may run with no active scope. Absent = ungoverned; a review must never invent one. */
  missionLabels?: readonly string[];
  /** Where the turn fought its tools, from its steering detector; absent on turns recorded before. */
  struggles?: readonly Struggle[];
  /** The tool lessons its steps listed, at the revision each saw; only these does the turn score. */
  shownLessons?: readonly { readonly id: string; readonly revision: number }[];
  /** The live trial's arm the turn ran; its errors and steps are the trial's guardrails. */
  trial?: TrialTurn;
}

export interface CompletedSession {
  sessionId: string;
  turns: CompletedTurn[];
  startedAt: number;
  endedAt: number;
}

export interface EvolutionEvent {
  type: 'reflection' | 'craft_discovered' | 'scaffold_proposed' | 'consolidation' | 'turn_complete' | 'changelog_digest' | 'experience_import' | 'advisor_note';
  message: string;
  data?: unknown;
}

export type EvolutionListener = (event: EvolutionEvent) => void;

/** Session-reflection cadence lives on AgentOrchestrator, not here. */
export interface EvolutionConfig {
  /** False for a host whose engine never learns (a facet); elsewhere the agent's `learning` setting decides. */
  enabled: boolean;
  /** Commit a group of writes as one durable unit. The identity default is only atomic
     *  inside a Durable Object; other backends must supply a real transaction. */
  transaction?: (body: () => void) => void;
  lifetimeEvolutionInterval: number;
  /** Reached only for turns carrying {@link CompletedTurn.missionLabels}. Absent = every review is ungoverned. */
  governor?: MissionGovernor;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  lifetimeEvolutionInterval: 5,
};
