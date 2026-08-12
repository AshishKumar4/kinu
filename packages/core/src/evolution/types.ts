/**
 * Evolution engine types — the three timescales of self-evolution.
 */

import type { MCTSProgressEvent } from '../types/mcts.js';

/** A tool call as reported by the AI SDK's structured result */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

/** Provider-reported token usage for one turn, summed over its steps.
 *  `cached` is the cache-read share of `input`, not an addition to it. */
export interface TurnUsage {
  input: number;
  output: number;
  cached: number;
}

/** A completed turn — input + output + metadata for the evolution engine */
export interface CompletedTurn {
  userMessage: string;
  assistantResponse: string;
  /** Structured tool calls from AI SDK (result.toolCalls + result.toolResults) */
  toolCalls: ToolCallRecord[];
  /**
   * The CRAFTED tools this turn actually called, as the in-episode craft clock
   * observed them (orchestrator/craft-cycle.ts).
   *
   * Not derivable from `toolCalls`: a crafted tool is codemode-only and never
   * appears as a native tool name, so "a call whose name is not built in" —
   * which is what this used to be inferred from — matches MCP and extension
   * tools and nothing else. Empty means observed and none (a run with
   * evolution off observes nothing, since a craft score is evolution state);
   * absent only on a turn persisted before this field existed.
   */
  craftedToolsUsed?: readonly string[];
  /** Total number of agentic steps (from AI SDK maxSteps) */
  steps: number;
  durationMs: number;
  /** User signal. Null at completion time (feedback is inherently later);
   *  populated by EvolutionEngine.reviewTurn from explicit thumbs or the
   *  follow-up outcome classifier. */
  feedback: 'positive' | 'negative' | null;
  /** Did the agent hit an error during this turn? */
  hadError: boolean;
  /** Durable id of the turn's assistant message — ties turn_outcomes rows,
   *  thumbs feedback, and lesson corroboration to this turn. */
  turnId?: string;
  /** Conversation/session key the turn belongs to. */
  sessionId?: string;
  /** Who initiated the turn. Outcome review only treats user follow-ups as
   *  verdicts on user-origin turns; programmatic turns (reactor / job wake)
   *  carry no user signal. */
  origin?: 'user' | 'programmatic';
  /** What the turn spent, as the provider reported it per step. Absent when
   *  the provider reported no usage at all. */
  usage?: TurnUsage;
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
  type: 'reflection' | 'craft_discovered' | 'scaffold_proposed' | 'consolidation' | 'mcts_started' | 'mcts_complete' | 'turn_complete' | 'replay_eval' | 'changelog_digest' | 'experience_import';
  message: string;
  data?: unknown;
}

/** Callback for evolution events — CLI/web can hook into this */
export type EvolutionListener = (event: EvolutionEvent) => void;

/** Evolution engine configuration. The every-N-turns session-reflection
 *  cadence is NOT here — AgentOrchestrator owns it (sessionReflectionInterval
 *  on its deps) and calls onSessionComplete. Turn-level reflection/extraction
 *  is gated by real outcomes (reviewTurn), not score thresholds. */
export interface EvolutionConfig {
  enabled: boolean;
  lifetimeEvolutionInterval: number;
  lifetimeMCTSBudget: number;
  lifetimeMCTSBranches: number;
  /** Called as the lifetime MCTS search progresses — for real-time UI broadcasting */
  onMctsProgress?: (event: MCTSProgressEvent) => void;
  /** Re-run a task against the CURRENT config (scaffold/prompt/tools) — the
   *  backend seam the replay-eval harness rolls out through. Absent = the
   *  periodic replay eval is skipped. */
  replayTaskRunner?: (task: string) => Promise<string>;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  lifetimeEvolutionInterval: 5,
  lifetimeMCTSBudget: 2,
  lifetimeMCTSBranches: 2,
};
