/**
 * Evolution engine types — the three timescales of self-evolution.
 */

/** A tool call as reported by the AI SDK's structured result */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

/** A completed turn — input + output + metadata for the evolution engine */
export interface CompletedTurn {
  userMessage: string;
  assistantResponse: string;
  /** Structured tool calls from AI SDK (result.toolCalls + result.toolResults) */
  toolCalls: ToolCallRecord[];
  /** Total number of agentic steps (from AI SDK maxSteps) */
  steps: number;
  durationMs: number;
  /** User signal: thumbs up/down, explicit feedback, or null (no signal) */
  feedback: 'positive' | 'negative' | null;
  /** Did the agent hit an error during this turn? */
  hadError: boolean;
}

/** A completed session — sequence of turns */
export interface CompletedSession {
  sessionId: string;
  turns: CompletedTurn[];
  startedAt: number;
  endedAt: number;
}

/** Evolution event emitted during auto-evolution (for UI display) */
export interface EvolutionEvent {
  type: 'reflection' | 'craft_discovered' | 'scaffold_proposed' | 'consolidation' | 'mcts_started' | 'mcts_complete' | 'turn_complete';
  message: string;
  data?: unknown;
}

/** Callback for evolution events — CLI/web can hook into this */
export type EvolutionListener = (event: EvolutionEvent) => void;

/** Evolution engine configuration */
export interface EvolutionConfig {
  enabled: boolean;
  turnReflectionThreshold: number;
  turnCraftThreshold: number;
  sessionReflectionInterval: number;
  lifetimeEvolutionInterval: number;
  lifetimeMCTSBudget: number;
  lifetimeMCTSBranches: number;
  /** Called after each MCTS iteration — for real-time UI broadcasting */
  onMctsProgress?: (iteration: number, remainingBudget: number) => void;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  turnReflectionThreshold: 0.4,
  turnCraftThreshold: 0.8,
  sessionReflectionInterval: 10,
  lifetimeEvolutionInterval: 5,
  lifetimeMCTSBudget: 2,
  lifetimeMCTSBranches: 2,
};
