import type { ModelMessage } from 'ai';

import type { MCTSProgressEvent } from '../types/mcts';
import type { Usage } from '../usage';
import type { JsonObject, JsonValue } from '../utils/json';
import type { MissionGovernor } from '../mission-budget';
import type { ToolOutcome } from '../tools/outcome';

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
}

export interface CompletedSession {
  sessionId: string;
  turns: CompletedTurn[];
  startedAt: number;
  endedAt: number;
}

export interface EvolutionEvent {
  type: 'reflection' | 'craft_discovered' | 'scaffold_proposed' | 'consolidation' | 'mcts_started' | 'mcts_complete' | 'turn_complete' | 'replay_eval' | 'changelog_digest' | 'experience_import' | 'advisor_note';
  message: string;
  data?: unknown;
}

export type EvolutionListener = (event: EvolutionEvent) => void;

/** `applied` is the action the gate actually took (a recheck can turn promote into rollback); null = inconclusive. */
export interface ShadowTrialDrain {
  readonly trials: number;
  readonly applied: 'promote' | 'rollback' | null;
}

/** Every value except `'queued'` is a turn that contributed nothing, named so a caller owing the queueing can tell refusal from failure. */
export type ShadowTrialQueueOutcome = 'queued' | 'not_sampled' | 'queue_full' | 'failed';

/** Sampling decision made when the turn ended; the stable row identity makes a replay write the same trial. */
export interface ShadowTrialPlan {
  readonly pendingVersion: number;
  readonly id?: string;
}

export interface ShadowTrialTurn {
  readonly task: string;
  readonly currentOutput: string;
  /** Read synchronously so a later turn's state cannot bleed in; empty when the host held none. */
  readonly context: readonly ModelMessage[];
}

/** Session-reflection cadence lives on AgentOrchestrator, not here. */
export interface EvolutionConfig {
  enabled: boolean;
  /** Commit a group of writes as one durable unit. The identity default is only atomic
     *  inside a Durable Object; other backends must supply a real transaction. */
  transaction?: (body: () => void) => void;
  lifetimeEvolutionInterval: number;
  lifetimeMCTSBudget: number;
  lifetimeMCTSBranches: number;
  onMctsProgress?: (event: MCTSProgressEvent) => void;
  /** Re-run a task against the current config. Absent = periodic replay eval is skipped. */
  replayTaskRunner?: (task: string) => Promise<string>;
  shadowTrialQueue?: (turn: ShadowTrialTurn, plan: ShadowTrialPlan) => ShadowTrialQueueOutcome;
  /** Absent = this host runs no trials; the durable queue lets another host run them. */
  shadowTrialRunner?: () => Promise<ShadowTrialDrain>;
  /** Reached only for turns carrying {@link CompletedTurn.missionLabels}. Absent = every review is ungoverned. */
  governor?: MissionGovernor;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  lifetimeEvolutionInterval: 5,
  lifetimeMCTSBudget: 2,
  lifetimeMCTSBranches: 2,
};
