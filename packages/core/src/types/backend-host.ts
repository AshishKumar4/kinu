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

export interface BackendHost {
  /** Fan-out to connected clients. CF: DurableObject.broadcast(JSON). CLI: push
   *  to the TUI store / print to stdout. Never throws. */
  broadcast(event: BroadcastEvent): void;

  /** Inject a programmatic turn, serialized behind any live turn. CF:
   *  Think.saveMessages (TurnQueue). CLI: enqueue into the local loop's queue. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;

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
