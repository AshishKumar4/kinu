/**
 * Evolution engine types — the three timescales of self-evolution.
 */

import type { ModelMessage } from 'ai';

import type { MCTSProgressEvent } from '../types/mcts';
import type { Usage } from '../usage';
import type { JsonObject, JsonValue } from '../utils/json';
import type { MissionGovernor } from '../mission-budget';

/** A tool call as reported by the AI SDK's structured result */
export interface ToolCallRecord {
  name: string;
  args: JsonObject;
  result?: JsonValue;
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
  usage?: Usage;
  /**
   * The mission labels the turn ran under, stamped by the orchestrator from the
   * governor's active scope at the moment the turn ended.
   *
   * Carried BY THE TURN rather than read from a governor at review time,
   * because a review need not run in the process — or the decade — the turn ran
   * in: a one-shot host defers it to a durable row and the next capable host
   * drains it, by which point no scope is active and the wrong one may be.
   * This is the only thing that lets the review's own model calls debit the
   * mission that caused them.
   *
   * Absent on an unbudgeted turn, which is every ordinary session. Absent means
   * ungoverned: a review must never invent a label.
   */
  missionLabels?: readonly string[];
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
  type: 'reflection' | 'craft_discovered' | 'scaffold_proposed' | 'consolidation' | 'mcts_started' | 'mcts_complete' | 'turn_complete' | 'replay_eval' | 'changelog_digest' | 'experience_import' | 'advisor_note';
  message: string;
  data?: unknown;
}

/** Callback for evolution events — CLI/web can hook into this */
export type EvolutionListener = (event: EvolutionEvent) => void;

/** What one drain of the shadow trial queue did. `applied` is the action the
 *  promotion gate ACTUALLY took (the misevolution recheck can turn a promote
 *  into a rollback), or null when the evidence stayed inconclusive — which is
 *  the honest state, not a pass. */
export interface ShadowTrialDrain {
  readonly trials: number;
  readonly applied: 'promote' | 'rollback' | null;
}

/** What a completed turn offers the promotion gate. */
/** What a completed turn offered the promotion gate. Every value except
 *  `'queued'` is a turn that contributed nothing — named, so a caller reporting
 *  the gate's state never has to guess which, and so a durable effect that OWED
 *  the queueing can tell a refusal from a failure. */
export type ShadowTrialQueueOutcome = 'queued' | 'not_sampled' | 'no_pending' | 'queue_full' | 'failed';

export interface ShadowTrialTurn {
  readonly task: string;
  /** What the live turn actually answered — the trial's comparand. */
  readonly currentOutput: string;
  /** The live turn's prepared conversation, read synchronously by the caller
   *  so a later turn's state can never bleed into this one. A delegating
   *  candidate replays it as its own default loop; empty when the host held
   *  none, and then the surface reconstructs one from the task. */
  readonly context: readonly ModelMessage[];
}

/** Evolution engine configuration. The every-N-turns session-reflection
 *  cadence is NOT here — AgentOrchestrator owns it (sessionReflectionInterval
 *  on its deps) and calls onSessionComplete. Turn-level reflection/extraction
 *  is gated by real outcomes (reviewTurn), not score thresholds. */
export interface EvolutionConfig {
  enabled: boolean;
  /**
   * Commit a group of writes as ONE durable unit.
   *
   * The grading pass uses it: the verdict row, the cumulative craft scores, the
   * tombstone that records both and the announcement are one fact. A synchronous
   * run is already atomic inside a Durable Object, so the identity default is
   * honest there; a backend whose process can be killed between two statements
   * must supply a real transaction or a retry appends a second verdict and moves
   * the EMA twice.
   */
  transaction?: (body: () => void) => void;
  lifetimeEvolutionInterval: number;
  lifetimeMCTSBudget: number;
  lifetimeMCTSBranches: number;
  /** Called as the lifetime MCTS search progresses — for real-time UI broadcasting */
  onMctsProgress?: (event: MCTSProgressEvent) => void;
  /** Re-run a task against the CURRENT config (scaffold/prompt/tools) — the
   *  backend seam the replay-eval harness rolls out through. Absent = the
   *  periodic replay eval is skipped. */
  replayTaskRunner?: (task: string) => Promise<string>;
  /** Record a completed turn as evidence the promotion gate may draw on — one
   *  row, no inference (evolution/control.ts `queueTurnShadowTrial`). Absent =
   *  this host queues none. */
  /** `opts.id` is the stable row identity a caller that OWES this queueing
   *  supplies, so a replay writes the same trial rather than a second one. */
  shadowTrialQueue?: (
    turn: ShadowTrialTurn, opts?: { readonly id?: string; readonly pendingVersion?: number },
  ) => ShadowTrialQueueOutcome;
  /** Run the shadow trials a turn queued for the pending scaffold — the
   *  promotion gate's evidence, gathered on the cadence lane instead of on the
   *  user's turn (evolution/control.ts `runQueuedShadowTrials`). Absent = this
   *  host runs no trials; the queue is durable, so the next host that can
   *  afford them runs the same rows. */
  shadowTrialRunner?: () => Promise<ShadowTrialDrain>;
  /**
   * The actor's mission budget governor — the same object the swarm's model-call
   * seam holds, so a turn review is bounded by exactly the cap that bounds the
   * work it reviews.
   *
   * Reached only for a turn that carries {@link CompletedTurn.missionLabels}, so
   * an ordinary unbudgeted session never queries the ledger and never sees a
   * refusal. Absent = this host wires no governor and every review is
   * ungoverned, which is what every backend did before this field existed.
   */
  governor?: MissionGovernor;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  lifetimeEvolutionInterval: 5,
  lifetimeMCTSBudget: 2,
  lifetimeMCTSBranches: 2,
};
