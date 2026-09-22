// BackendHost — the COMPLETE loop-level contract a backend fulfills so the
// shared core agent (AgentOrchestrator) hosts ALL of Kinu's functionality,
// regardless of platform. It pairs with AgentRuntime (the resource primitives):
//
//   AgentRuntime  → storage / memory / executor / llm / schedule / identity /
//                   craftStore / executionRouter / spawnBranch / shell
//   BackendHost   → the loop capabilities that are inherently platform-shaped:
//                   client fan-out, programmatic turns, and head spawning.
//
// Implement both, then drive the loop harness through AgentOrchestrator's
// lifecycle methods, and you have the whole agent. The Cloudflare Durable Object
// (via the Agents platform) and the local Bun CLI are thin adapters over one
// core agent — the DO is just one backend.
//
// Deliberately minimal: every member maps to exactly one capability that
// genuinely differs per backend AND has no home on AgentRuntime. Durable fibers
// (schedule.fiber), MCTS branch spawning (spawnBranch), and activity logging
// (storage.sql) are NOT here — each already has a home (deletion test).
//
// User-level tools (connected MCP servers) are NOT here either: the core never
// assembles a turn's ToolSet. Each backend builds its own tool surface where it
// builds the turn config — cf caches the UserDO's MCP descriptors against that
// DO's mcp_updated_at watermark, the CLI merges the tools its stdio clients
// returned at connect time — and hands the merged set straight to the model.
// A seam here would have no core caller to serve (deletion test).

import type { HeadRuntime } from '../heads/controller';
import type { JsonObject } from '../utils/json';

/** A typed event fanned out to connected clients (mcts-progress, device_consent,
 *  workspace_renamed, background-event cards…). Fire-and-forget. */
export interface BroadcastEvent {
  readonly type: string;
  readonly id?: string;
  readonly state?: string;
  readonly text?: string;
  readonly metadata?: JsonObject;
  readonly status?: string;
  readonly branchId?: string;
  readonly task?: string;
  readonly takeSetId?: string;
  readonly turnId?: string;
  readonly message?: string;
  /** `workspace_renamed`: the agent's new shown title. */
  readonly displayName?: string;
  /** `steer_status`: which steer this is about. */
  readonly steerId?: string;
  /** `steer_status`: the step index a landed steer was spliced into. */
  readonly atStep?: number;
  readonly jobId?: string;
  /** `head_activity` / `head_stream`: which exploration head is speaking. */
  readonly headId?: string;
}

/** A programmatic turn injected into the SAME serialized loop the user drives —
 *  the turn half of the inbox (orchestrator/inbox.ts).
 *  `metadata.kinuEvent` makes the chat render it as an event card rather
 *  than a user bubble. */
export interface ProgrammaticTurn {
  readonly text: string;
  readonly metadata?: JsonObject;
  /** Stable identity for a durable, retry-safe turn submission. Backends that
   * support durable admission must return the existing turn on a retry. */
  readonly idempotencyKey?: string;
  /** The turn is a move offered to an agent nobody has spoken to, not an event it must hear. If a message the operator wrote has been admitted by the time this turn takes its slot, the host runs nothing and answers 'yielded': that message is the turn now. Read inside the slot, never before it — the race this closes is a message landing between the enqueue and the start. */
  readonly yieldsToUserMessage?: boolean;
  /** 'user': this turn carries the operator's own words (a steer rerun). The host queues it as
   *  a user turn: CLI at the queue FRONT with kind 'user' and `files`; CF as an operator-stamped
   *  row and it deletes the `pending_steers` rows named by `steerIds` once admitted. */
  readonly origin?: 'user';
  readonly files?: readonly PromptFile[];
  readonly steerIds?: readonly string[];
}

/** A file attached to a user prompt — the ai-sdk FileUIPart payload (sans tag).
 *  `url` is a data: URL so the part crosses every transport (cloud UIMessage
 *  parts, local ModelMessage file content) without provider-side fetching. */
export interface PromptFile {
  readonly filename: string;
  readonly mediaType: string;
  readonly url: string;
}

export interface EnqueueTurnResult {
  /** 'skipped' when a newer turn generation pre-empted this injection — the
   *  caller leaves a breadcrumb so a settled result isn't silently lost.
   *  'yielded' when a `yieldsToUserMessage` turn found an operator message
   *  already admitted at its slot: the offer is consumed, never retried. */
  readonly status: 'queued' | 'skipped' | 'yielded';
  /** Durable-admission receipt when the backend has a submission ledger. */
  readonly durable?: {
    readonly submissionId: string;
    readonly accepted: boolean;
    readonly status: 'pending' | 'running' | 'completed' | 'aborted' | 'skipped' | 'error';
  };
}

export interface BackendHost {
  /** Fan-out to connected clients. CF: DurableObject.broadcast(JSON). CLI: push
   *  to the TUI store / print to stdout. Never throws. */
  broadcast(event: BroadcastEvent): void;

  /** Inject a programmatic turn through the backend's core ChatSession queue.
   *  The core Inbox (orchestrator/inbox.ts) is its only caller — producers
   *  send a message and never pick the mechanism. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;

  /** Is a turn running right now — i.e. will there BE a next agentic step for
   *  a signal to land on? A fact about the loop, not a policy: the one signal
   *  delivery time is the agent's next step, and this is what tells the seam
   *  whether it must start a turn to produce one. Synchronous by contract: the
   *  answer and the buffer push must be one event-loop tick, atomic with the
   *  producer's own durable bookkeeping. A false positive strands a signal
   *  until the turn settles (which re-delivers it), a false negative queues a
   *  turn behind the live one — so answer it exactly. */
  turnInFlight(): boolean;

  /** One-shot platform timer — the drain-debounce primitive (DrainScheduler).
   *  The implementation MUST keep the platform alive until `fn` settles and
   *  must swallow (log) `fn`'s rejection. CF: setTimeout inside keepAliveWhile
   *  so the DO survives the window + the drain. CLI: plain setTimeout. A lost
   *  timer (eviction) only delays work that is durable elsewhere. */
  setTimer(fn: () => Promise<void>, ms: number): void;

  /**
   * Re-derive and arm the host's own durable wake, because the set of work that
   * needs one just changed.
   *
   * The sibling of `setTimer`, and the difference is what survives the process.
   * `setTimer` holds THIS activation open across the drain debounce; a pending
   * reaction that outlives the activation needs something the platform will
   * deliver with nobody watching. Every caller of `scheduleDrain` therefore
   * reaches both: the fast path for the burst it is coalescing, and this for
   * the promise the durable rows represent.
   *
   * No argument: the host owns the fold over every deadline it can be asked to
   * wake for (triggers, outbox retries, pending reactions), so a caller that
   * passed a time could only disagree with it.
   *
   * null — not a no-op callback — declares a host that RE-DERIVES its next wake instead of
   * arming one. The CLI is that host, and the difference is a ticking process:
   * `agent-host/host.ts`'s `runPass` recomputes `nextTriggerAt(db)` from the
   * same durable rows on every pass, so there is nothing for a session to arm
   * and no moment at which the fold is stale. A Durable Object has no such
   * process, which is why the cf host arms explicitly (`durableWakeOwner`).
   * The null capability states that it does not arm a platform alarm; a no-op
   * implementation would claim a guarantee it has not made.
   */
  reconcileDurableWake?: (() => void) | null;

  /** Head spawner + merge LLM (HeadController's existing seam). CF:
   *  createCFHeadRuntime (Facet sub-agents). CLI: subprocess-backed. Required
   *  for full agents-fork parity. */
  readonly headRuntime?: HeadRuntime;

}
