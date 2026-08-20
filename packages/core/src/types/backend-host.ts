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
// (via @cloudflare/think) and the local Bun CLI are then THIN adapters over one
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
  readonly jobId?: string;
}

/** A programmatic turn injected into the SAME serialized loop the user drives —
 *  the queued half of signal delivery (orchestrator/signals.ts).
 *  `metadata.proteusEvent` makes the chat render it as an event card rather
 *  than a user bubble. */
export interface ProgrammaticTurn {
  readonly text: string;
  readonly metadata?: JsonObject;
  /** Stable identity for a durable, retry-safe turn submission. Backends that
   * support durable admission must return the existing turn on a retry. */
  readonly idempotencyKey?: string;
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
   *  caller leaves a breadcrumb so a settled result isn't silently lost. */
  readonly status: 'queued' | 'skipped';
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
  broadcast<Event extends BroadcastEvent>(event: Event): void;

  /** Inject a programmatic turn, serialized behind any live turn. CF:
   *  Think.saveMessages (TurnQueue). CLI: enqueue into the local loop's queue.
   *  The core SignalDelivery seam (orchestrator/signals.ts) is its only caller
   *  — producers deliver a signal and never pick the mechanism. An explicit
   *  owner decision may also enqueue a new mode-boundary turn directly when
   *  splicing into the live turn would preserve the wrong tool surface. */
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

  /** Head spawner + merge LLM (HeadController's existing seam). CF:
   *  createCFHeadRuntime (Facet sub-agents). CLI: subprocess-backed. Required
   *  for full agents-fork parity. */
  readonly headRuntime?: HeadRuntime;

}
