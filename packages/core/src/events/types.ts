/**
 * Run events — Flue-style discriminated union for everything that happens
 * during an agent run.
 *
 * Persisted in run_events table; queried via /api/runs/<runId>/events;
 * streamed via /api/runs/<runId>/stream (SSE w/ Last-Event-ID resume).
 *
 * Each event carries `runId` + `eventIndex` (monotonic per run) + `timestamp`.
 * Consumers may filter by `type` and slice by index.
 */

import type { ContextBudgetSnapshot } from '../context-budget.js';
import type { ContextComposition } from '../context-meter.js';
import type { FileEditSnapshot } from '../tools/file-ledger.js';
import type { MissionBudgetRefusal } from '../mission-budget.js';

/**
 * What the provider said one request cost. Every field is reported by the API,
 * never inferred — `cached` is the cache-read subset of `input`, and `usd` is
 * present only when the model carried a models.dev catalog rate at the time of
 * the call. An absent `usd` means unpriced, never free.
 */
export interface StepUsage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly reasoning: number;
  readonly usd?: number;
  readonly modelId?: string;
}

export type RunEventType =
  | 'run_start'
  | 'turn_start'
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'step_finish'
  | 'head_split'
  | 'head_merge'
  | 'scaffold_promotion'
  | 'scaffold_rollback'
  | 'memory_write'
  | 'context_budget'
  | 'file_edit'
  | 'turn_steering'
  | 'completion_gate'
  | 'craft_cycle'
  | 'budget_exhausted'
  | 'fiber_recovered'
  | 'error'
  | 'turn_end'
  | 'run_end';

export interface RunEventBase {
  /** Unique within a single run; monotonically increasing. */
  readonly eventIndex: number;
  /** Unique run identifier (typically the chat turn id or a fresh nanoid). */
  readonly runId: string;
  readonly type: RunEventType;
  /** ISO timestamp at emission time. */
  readonly timestamp: string;
}

export type RunEvent =
  | (RunEventBase & { type: 'run_start'; agentId: string; userMessage?: string;
      /** What kicked off this run: 'chat' | 'webhook' | 'timer' | 'peer' | … */
      caused_by?: string;
      /** Ingress descriptor kind for event-triggered runs (webhook_hmac, …). */
      ingress_kind?: string;
      /** The trigger that fired this run, when event-driven. */
      trigger_id?: string })
  | (RunEventBase & { type: 'turn_start'; turnIndex: number })
  | (RunEventBase & { type: 'text_delta'; text: string })
  | (RunEventBase & { type: 'tool_call_start'; name: string; args: Record<string, unknown>; toolCallId: string })
  | (RunEventBase & { type: 'tool_call_end'; name: string; toolCallId: string; result?: unknown; error?: string; durationMs?: number })
  /** One model request completed. `usage` is the provider's own report of that
   *  request — the authority on what it cost. `context` is what the request
   *  was locally measured to be made of; the two do not reconcile exactly and
   *  are carried side by side so a reader can see the gap. Both are absent
   *  when the step produced no such report. */
  | (RunEventBase & {
      type: 'step_finish';
      stepIndex: number;
      reason?: string;
      usage?: StepUsage;
      context?: ContextComposition;
    })
  | (RunEventBase & { type: 'head_split'; rootId: string; headIds: string[]; rationale: string })
  /** A split settled. `headsWithFindings` vs `headCount` is how many forks came
   *  back with something against how many returned empty, and `totalTokens` is
   *  what the whole split cost — so the productivity of delegation is a query
   *  over the ledger instead of a hand-read of trajectories. */
  | (RunEventBase & { type: 'head_merge'; rootId: string; headCount: number;
      headsWithFindings: number; totalTokens: number; mergedNarrative: string })
  | (RunEventBase & { type: 'scaffold_promotion'; fromVersion: number; toVersion: number })
  | (RunEventBase & { type: 'scaffold_rollback'; fromVersion: number; toVersion: number })
  | (RunEventBase & { type: 'memory_write'; path: string; bytes: number })
  /** The turn's bulk-ingestion ledger — how much tool output the root actually
   *  admitted, what every producer spilled instead, and whether the agent read
   *  any of it back. Written once per turn by the settle spine (M1 trip
   *  counters); `turn_end` is the denominator. */
  | (RunEventBase & { type: 'context_budget' } & ContextBudgetSnapshot)
  /** What this turn's `file` edits did: how many were attempted, how many
   *  landed, which exact-match failures they hit, and whether the model came
   *  back and got the file right. Written once per turn by the settle spine
   *  like `context_budget`, only for turns that attempted an edit. Shell-based
   *  edits could not produce this row at all — `sed -i` exits 0 whether or not
   *  it matched anything — which is why the primitive is what makes edit
   *  success a gradable signal. */
  | (RunEventBase & { type: 'file_edit' } & FileEditSnapshot)
  /** The harness mechanically steered the turn, and whether the model then did
   *  what the steer asked. At most one per turn, written by the settle spine
   *  like `context_budget`; `turn_end` is the denominator, `converted` the
   *  conversion numerator. Declared here rather than imported from the producer
   *  (orchestrator/turn-steering.ts): this union is reachable from most of the
   *  turn pipeline, and the producer holds mid-turn injection machinery no
   *  other layer may reach. */
  | (RunEventBase & { type: 'turn_steering';
      /** Which mechanical trigger fired. */
      trigger: 'repeated_call' | 'repeated_failure' | 'long_turn_no_delegation';
      /** Step boundary the steer was spliced into. */
      step: number;
      /** The tool that kept repeating or failing (not the long-turn trigger). */
      tool?: string;
      /** The model did what the steer asked: reached for `agents` after a
       *  delegation steer, or called something other than the repeating call
       *  after a repeat steer. */
      converted: boolean })
  /** The one-shot completion gate fired: the harness refused to let the run end
   *  on the model's own say-so and handed it freshly observed state first.
   *  At most one per one-shot run, written by the settle spine when the
   *  confirming turn closes — `converted` says the re-look found real work to
   *  do rather than confirming a claim. */
  | (RunEventBase & { type: 'completion_gate';
      /** The agent made tool calls after seeing the observed state. */
      converted: boolean })
  /** The in-episode craft loop's turn record — did the agent build itself a
   *  tool mid-episode, did it reach for that tool again, and did the reach
   *  work. Written once per turn by the settle spine like `turn_steering`,
   *  with `turn_end` as the denominator: the durable trail an analysis can read
   *  without asking the model anything. Declared here rather than imported from
   *  the producer (orchestrator/craft-cycle.ts) for the same reason the steering
   *  record is: this union is reachable from most of the turn pipeline, the
   *  producer is not. */
  | (RunEventBase & { type: 'craft_cycle';
      /** Crafted tools that came into existence during this turn. */
      crafted: string[];
      /** Crafted tools whose call sites appeared in a settled execute call. */
      invoked: string[];
      /** Crafted THIS turn and then called by a LATER execute call — the
       *  in-episode loop actually closing, and the numerator to report. */
      reused: string[];
      /** Observations recorded: invocations that returned, and invocations
       *  that raised and were attributed to the tool itself. */
      returned: number;
      raised: number;
      /** Crafted tools this turn's execution evidence pushed below the
       *  injection floor — retirement, in-episode. */
      dropped: string[] })
  /** A mission budget ran out and a host seam declined the work. Written once
   *  per label by the governor (mission-budget.ts), so the durable trail says
   *  which cap stopped which run rather than leaving an unexplained short turn. */
  | (RunEventBase & { type: 'budget_exhausted' } & Omit<MissionBudgetRefusal, 'error'>)
  | (RunEventBase & { type: 'fiber_recovered'; fiberName: string; fiberId: string; snapshot?: unknown })
  | (RunEventBase & { type: 'error'; message: string; details?: unknown })
  | (RunEventBase & { type: 'turn_end'; turnIndex: number; tokenUsage?: { input: number; output: number; cached?: number } })
  | (RunEventBase & { type: 'run_end'; reason?: string;
      /** The provider/stream error text (truncated) when the run ended in
       *  status 'error' — the durable evidence a post-hoc investigation needs
       *  (Think persists only the LAST terminal error, which a later failure
       *  overwrites). */
      error?: string });

/** One turn's mechanical steer — what the steering object reports and what the
 *  settle spine writes, derived from the durable schema so there is one
 *  declaration. */
export type TurnSteeringRecord =
  Omit<Extract<RunEvent, { type: 'turn_steering' }>, keyof RunEventBase | 'type'>;

export type TurnSteeringTrigger = TurnSteeringRecord['trigger'];

/** One run's completion gate — derived from the durable schema for the same
 *  reason as the steering record: one declaration, no drift. */
export type CompletionGateRecord =
  Omit<Extract<RunEvent, { type: 'completion_gate' }>, keyof RunEventBase | 'type'>;

/** One turn's in-episode craft loop — what the cycle reports and what the
 *  settle spine writes, derived from the durable schema so there is one
 *  declaration. */
export type CraftCycleRecord =
  Omit<Extract<RunEvent, { type: 'craft_cycle' }>, keyof RunEventBase | 'type'>;

/** A new event payload sans the base fields the recorder fills in. */
export type RunEventInput = {
  [K in RunEvent['type']]: Omit<Extract<RunEvent, { type: K }>, keyof RunEventBase> & { type: K }
}[RunEvent['type']];
