// Loop-level contract a backend fulfils beside AgentRuntime: client fan-out, programmatic turns,
// head spawning. Only capabilities that differ per backend and have no AgentRuntime home belong here.

import type { HeadRuntime } from '../heads/controller';
import type { JsonObject } from '../utils/json';
import type { PlanReview } from './plans';

/** A typed event fanned out to connected clients. Fire-and-forget. */
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
  /** `plan_updated`: the review as it now stands. */
  readonly plan?: PlanReview;
}

/** A programmatic turn in the same serialized loop the user drives; `metadata.kinuEvent` renders
 *  it as an event card. */
export interface ProgrammaticTurn {
  readonly text: string;
  readonly metadata?: JsonObject;
  /** Durable admission must return the existing turn on a retry with the same key. */
  readonly idempotencyKey?: string;
  /** Yields to an operator message admitted by the time this turn takes its slot (read inside the
     *  slot, never before): the host runs nothing and answers 'yielded'. */
  readonly yieldsToUserMessage?: boolean;
  /** The operator's own words (a steer rerun). CLI queues it at the front with `files`; CF stamps it
     *  as operator and deletes the `pending_steers` rows named by `steerIds` once admitted. */
  readonly origin?: 'user';
  readonly files?: readonly PromptFile[];
  readonly steerIds?: readonly string[];
}

/** ai-sdk FileUIPart payload; `url` is a data: URL so it crosses every transport unfetched. */
export interface PromptFile {
  readonly filename: string;
  readonly mediaType: string;
  readonly url: string;
}

export interface EnqueueTurnResult {
  /** 'skipped': pre-empted by a newer turn generation (caller leaves a breadcrumb). 'yielded': an
     *  operator message took the slot; consumed, never retried. */
  readonly status: 'queued' | 'skipped' | 'yielded';
}

export interface BackendHost {
  /** Never throws. */
  broadcast(event: BroadcastEvent): void;

  /** Only caller is the core Inbox (orchestrator/inbox.ts). */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult>;

  /** Whether a turn is running, i.e. a next step exists for a signal to land on. Synchronous: the
     *  answer and buffer push must share one tick with the producer's durable bookkeeping. */
  turnInFlight(): boolean;

  /** One-shot timer for drain debounce. Must keep the platform alive until `fn` settles and must
     *  swallow (log) its rejection. */
  setTimer(fn: () => Promise<void>, ms: number): void;

  /** Re-derive and arm the durable wake over every deadline the host owns. null declares a host that
     *  re-derives each pass (CLI `runPass`); a no-op would claim an alarm it never arms. */
  reconcileDurableWake?: (() => void) | null;

  /** Head spawner + merge LLM for HeadController. */
  readonly headRuntime?: HeadRuntime;

}
