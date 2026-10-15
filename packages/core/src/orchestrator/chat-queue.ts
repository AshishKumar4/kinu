/**
 * What a chat session's queue holds: one turn input each (a person's words, a producer's turn, a delivered run, a
 * Retry's reopened turn), with its metadata parsed once. Shared by the session and its restart restore.
 */
import * as v from 'valibot';
import type { KinuError } from '../obs/index';
import type { AgentTurnTask } from '../subordinates/agent-isolate';
import type { OperatorSend, ProgrammaticTurn, PromptFile } from '../types/backend-host';
import { turnTags, type TurnTags } from '../types/turn-metadata';
import type { Usage } from '../usage';
import { JsonObjectSchema, type JsonObject } from '../utils/json';

export interface QueueItem {
  text: string;
  files?: ReadonlyArray<PromptFile>;
  metadata?: ProgrammaticTurn['metadata'];
  /** Its metadata as core reads it, parsed once as it entered the queue ({@link tagged}). */
  readonly tags: TurnTags;
  /** The durable row id derives from it, so a re-announcement collides with the first row (see `persist`). */
  idempotencyKey?: string;
  kind: 'user' | 'programmatic';
  /** Minted at admission, so a steer accepted while queued binds to it. */
  turnId?: string;
  /** Retired when its user row is durable. */
  pendingSendId?: string;
  /** Retired with the rerun's row, so a restart cannot re-deliver them. */
  steerIds?: readonly string[];
  /** The sends a rerun carries, each published under its own id when the turn first opens. */
  sends?: readonly OperatorSend[];
  /** Placed at the queue front, behind only earlier reruns of the same settle. */
  rerun?: true;
  /** An offer: an operator message admitted ahead settles it 'yielded' unrun. */
  yieldsToUserMessage?: boolean;
  /** Re-opened under its own ids, its prior output re-entered ahead of the remaining calls. */
  continuation?: TurnContinuation;
  /** A run delivered to the agent: a typed input of this queue, which its host runs (D2), never a turn of the
   *  conversation. Programmatic, keyed by its id, held durably as every programmatic input is. */
  run?: DeliveredRun;
  /** A Stop that came once the pump took it, before its execution was claimed: it ends unrun (`interrupt`). */
  cut?: KinuError;
  /** The row a Retry's intent held it under: its opening retires it, as its settle does if it never opens. */
  heldAs?: string;
  /** Exactly once, and told whether the turn ran: a failure must reach the producer, the only one who can put things back.
   *  `abandoned` names why an opened turn ended before it could answer. */
  settle: (failure: KinuError | null, yielded?: boolean, abandoned?: string) => void;
}

interface TurnContinuation {
  /** The continuation appends to it, so the open run is the run that closes. */
  readonly runId: string;
  readonly messageId: string;
  readonly finishedSteps: number;
  readonly usage: Usage;
  /** The outputs the cut step left open, named before a claim seals them. */
  readonly openOutputs: readonly string[];
  /** Not asked again before this instant ({@link ActorSession.reaskAt}). */
  readonly reaskAt: number | null;
}

/** A run delivered to the agent (design v2 §1, D2), keyed by its id. */
export interface DeliveredRun {
  readonly id: string;
  readonly task: AgentTurnTask;
}

/** Marks a held programmatic input as a delivered run, so a later process restores it as one. */
export const DELIVERED_RUN_EVENT = 'delivered_run';

/** Marks a held row as a Retry's reopened turn, so a later process runs it as that turn again. */
export const RETRIED_TURN_EVENT = 'retried_turn';

export const HeldRetrySchema = v.object({ kinuEvent: v.literal(RETRIED_TURN_EVENT), retryOf: v.string(), retried: v.nullable(JsonObjectSchema) });

export function runMetadata(task: AgentTurnTask): JsonObject {
  return { kinuEvent: DELIVERED_RUN_EVENT, kinuMode: task.mode, kinuRun: task.runId };
}

export function runItem(run: DeliveredRun): QueueItem {
  return tagged({ text: run.task.body, kind: 'programmatic', idempotencyKey: run.id, metadata: runMetadata(run.task), run, settle: () => {} });
}

/** A queue item, its metadata parsed once into its tags. */
export function tagged(item: Omit<QueueItem, 'tags'>): QueueItem {
  return { ...item, tags: turnTags(item) };
}
