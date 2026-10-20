
import type { MissionGovernor } from '../mission-budget';
import type { InstructionApprovalStore } from '../safety/instruction-trust';
import type * as v from 'valibot';
import type { CompletedTurnSchema } from './session-window';

/** One completed turn, as `CompletedTurnSchema` (`session-window.ts`) stores and reads it. */
export type CompletedTurn = v.InferOutput<typeof CompletedTurnSchema>;

export type ToolCallRecord = CompletedTurn['toolCalls'][number];

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
  /** The trust authority a dream's skill lives by, so the rater is asked about one in effect; absent: none is. */
  approvals?: Pick<InstructionApprovalStore, 'get'>;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  lifetimeEvolutionInterval: 5,
};
