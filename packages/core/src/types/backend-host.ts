// BackendHost — the COMPLETE loop-level contract a backend fulfills so the
// shared core agent (AgentOrchestrator) hosts ALL of Proteus's functionality,
// regardless of platform. It pairs with AgentRuntime (the resource primitives):
//
//   AgentRuntime  → storage / memory / executor / llm / schedule / identity /
//                   craftStore / executionRouter / spawnBranch / shell
//   BackendHost   → the loop capabilities that are inherently platform-shaped:
//                   client fan-out, programmatic turns, head spawning, and
//                   user-level tool injection.
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

import type { ToolSet } from 'ai';
import type { HeadRuntime } from '../heads/controller.js';

/** A typed event fanned out to connected clients (mcts-progress, device_consent,
 *  workspace_renamed, background-event cards…). Fire-and-forget. */
export interface BroadcastEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A programmatic turn injected into the SAME serialized loop the user drives —
 *  the resume path for the event→turn reactor, background-job completion wakes,
 *  and device consent. `metadata.proteusEvent` makes the chat render it as an
 *  event card rather than a user bubble. */
export interface ProgrammaticTurn {
  readonly text: string;
  readonly metadata?: { proteusEvent?: string; [key: string]: unknown };
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
}

/** A drained event batch bound for the ACTIVE turn's next agentic step. The
 *  events are already consumed against `turnId` (EventLog markConsumed), so
 *  the backend dispatches the absorbing turn's answer to their reply channels
 *  by that id — the same id scheme the enqueued drain-turn path stamps as
 *  `metadata.drainTurnId`. */
export interface MidTurnEventBatch {
  readonly turnId: string;
  /** EventLog rows bound to `turnId`; required to compensate a failed or
   *  pre-empted fallback enqueue. */
  readonly ids: readonly string[];
  /** Rendered for the live turn's next step ("arrived while you were working"). */
  readonly stepText: string;
  /** Rendered for a standalone programmatic turn — the fallback when the live
   *  turn settles before another step boundary arrives. */
  readonly turnText: string;
}

export interface BackendHost {
  /** Fan-out to connected clients. CF: DurableObject.broadcast(JSON). CLI: push
   *  to the TUI store / print to stdout. Never throws. */
  broadcast(event: BroadcastEvent): void;

  /** Inject a programmatic turn, serialized behind any live turn. CF:
   *  Think.saveMessages (TurnQueue). CLI: enqueue into the local loop's queue. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;

  /** Splice a drained event batch into the ACTIVE turn's next agentic step
   *  ("injected mid turn if a turn is active"), returning false when no turn
   *  is live so the caller falls back to enqueueTurn. Synchronous by contract:
   *  the is-a-turn-active check and the buffer push must be one event-loop
   *  tick, atomic with the caller's markConsumed. CF: buffers for the
   *  event-injection extension's prepareStep drain. CLI: declines — the local
   *  steer-drain owns the live turn's injection channel with USER semantics
   *  (per-steer durable rows, composer restore on interrupt) that a platform
   *  event must not assume. */
  injectIntoActiveTurn(batch: MidTurnEventBatch): boolean;

  /** One-shot platform timer — the drain-debounce primitive (DrainScheduler).
   *  The implementation MUST keep the platform alive until `fn` settles and
   *  must swallow (log) `fn`'s rejection. CF: setTimeout inside keepAliveWhile
   *  so the DO survives the window + the drain. CLI: plain setTimeout. A lost
   *  timer (eviction) only delays work that is durable elsewhere. */
  setTimer(fn: () => Promise<void>, ms: number): void;

  /** Head spawner + merge LLM (HeadController's existing seam). CF:
   *  createCFHeadRuntime (Facet sub-agents). CLI: subprocess-backed. Required
   *  for full think({strategy:'heads'}) parity. */
  readonly headRuntime?: HeadRuntime;

  /** User-level tools beyond the builtins — connected MCP servers / per-user
   *  tools — merged into the turn's tool surface. CF: fetched from the UserDO.
   *  CLI: local MCP config. No extra tools when absent. */
  resolveExtraTools?(): Promise<ToolSet> | ToolSet;
}
