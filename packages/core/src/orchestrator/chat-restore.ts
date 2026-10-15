/**
 * What a chat session restores as it starts, from what the last process left durable, in this order: the turn it died
 * inside, re-opened first; the sends the operator was told were taken; then the programmatic turns a producer heard
 * queued. Each lands in the session's queue as its live counterpart would have.
 */
import * as v from 'valibot';
import type { RunEventRecorder } from '../events/recorder';
import type { OperatorSend } from '../types/backend-host';
import { turnTags } from '../types/turn-metadata';
import type { WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import { announcementOf } from '../utils/ui-message';
import type { ActorSession } from './actor-session';
import { DELIVERED_RUN_EVENT, HeldRetrySchema, RETRIED_TURN_EVENT, runItem, tagged, type QueueItem } from './chat-queue';
import type { PendingSendRow, PendingSendStore, UserSteer } from './inbox';

/** What restoring reads of its session, and the moves it makes on it. */
export interface ChatRestorePort {
  readonly recorder: Pick<RunEventRecorder, 'openTurn'>;
  readonly actor: Pick<ActorSession, 'canonical' | 'reaskAt'>;
  readonly pendingSends: PendingSendStore;
  /** Whether the turn a programmatic input announces is in flight here, or already on disk. */
  announcementInFlight(identity: string): boolean;
  announcementOnDisk(identity: string): boolean;
  /** A Retry's turn, run again under its own id: `heldAs`, the row its intent held. */
  retried(turnId: string, text: string, metadata: JsonObject | undefined, heldAs: string): QueueItem;
  /** Sends a turn left unanswered, rerun as one user turn. */
  leftover(sends: readonly OperatorSend[], metadata: JsonObject | undefined): QueueItem;
  /** Sends the re-opened turn's run held, handed to its inbox for its first step. */
  restoreMidTurn(steers: readonly (UserSteer & { readonly mode: WorkMode })[]): void;
  queue(item: QueueItem): void;
  /** A background notice to the session's surfaces. */
  notice(event: string, message: string): void;
  /** Not synchronous: the driver gate is installed after the constructor returns. */
  pumpSoon(): void;
  /** Tells the ends of delivered runs the last process kept and never told: their runs ran. */
  tellRunsSoon(): void;
}

/** The turn the last process died inside: the send it carried, and the ids its later accounting keys on. */
export interface ReopenedTurn {
  readonly pendingSendId: string | null;
  readonly turnId: string;
  readonly runId: string;
}

export function restoreChat(port: ChatRestorePort): ReopenedTurn | null {
  const reopened = restoreOpenTurn(port);

  restorePendingSends(port, reopened);
  restoreQueuedTurns(port);

  return reopened;
}

/** Re-queues first the turn the last process died inside, claiming its reservation so the sends' restore skips it. */
function restoreOpenTurn(port: ChatRestorePort): ReopenedTurn | null {
  const open = port.recorder.openTurn();

  if (open === null) return null;
  const { runId, turn, finishedSteps, usage } = open;
  const openOutputs = port.actor.canonical.openOutputs(runId);

  const item = tagged({
    text: turn.text,
    kind: turn.kind,
    turnId: turn.turnId,
    ...(turn.metadata !== undefined && { metadata: turn.metadata }),
    ...(turn.pendingSendId !== undefined && { pendingSendId: turn.pendingSendId, files: port.pendingSends.files(turn.pendingSendId) }),
    ...(turn.steerIds !== undefined && { steerIds: turn.steerIds }),
    rerun: true,
    continuation: {
      runId,
      messageId: turn.messageId,
      finishedSteps,
      usage,
      openOutputs,
      reaskAt: port.actor.reaskAt(turn.turnId),
    },
    settle: () => {},
  });

  if (turn.kind === 'programmatic') item.idempotencyKey = announcementOf(turn.turnId);
  port.queue(item);

  port.notice(
    'turn_reopened',
    `continuing the turn the last process left: ${String(finishedSteps)} step${finishedSteps === 1 ? '' : 's'} kept`
      + (openOutputs.length === 0 ? '' : `, resuming mid-step ${String(finishedSteps + 1)}`),
  );
  port.pumpSoon();

  return { pendingSendId: turn.pendingSendId ?? null, turnId: turn.turnId, runId };
}

/** Programmatic turns a producer heard queued and the last process never settled re-enter the queue behind the
 *  operator's own; one whose turn was admitted is the re-opened run's, or done. */
function restoreQueuedTurns(port: ChatRestorePort): void {
  let queued = 0;

  for (const row of port.pendingSends.restoreTurns()) {
    // The turn the last process left open re-opens under its announcement and retires the row as it settles.
    if (port.announcementInFlight(row.id)) continue;

    if (port.announcementOnDisk(row.id)) {
      port.pendingSends.retireTurn(row.id);
      continue;
    }

    const retried = row.metadata?.kinuEvent === RETRIED_TURN_EVENT ? v.safeParse(HeldRetrySchema, row.metadata) : null;

    // A Retry its intent held, whose turn never opened: it runs as that turn again.
    if (retried?.success === true) {
      const { retryOf, retried: metadata } = retried.output;

      port.queue(port.retried(retryOf, row.text, metadata ?? undefined, row.id));
      queued += 1;
      continue;
    }

    const tags = turnTags(row);
    const run = tags.event === DELIVERED_RUN_EVENT ? tags.run : undefined;

    port.queue(run !== undefined ? runItem({ id: row.id, task: { sequenceId: row.id, runId: run, body: row.text, mode: tags.mode } }) : tagged({
      text: row.text, kind: 'programmatic', idempotencyKey: row.id,
      ...(row.metadata !== undefined && { metadata: row.metadata }),
      ...(row.yieldsToUserMessage === true && { yieldsToUserMessage: true }),
      settle: () => {},
    }));
    queued += 1;
  }

  if (queued > 0) port.pumpSoon();

  if (port.pendingSends.runEnds().length > 0) port.tellRunsSoon();
}

/** Mid-turn rows re-enter the inbox; idle rows re-enter the pump in sequence order. */
function restorePendingSends(port: ChatRestorePort, reopened: ReopenedTurn | null): void {
  // Rows bound to the re-opened turn land in its first step.
  const rows = port.pendingSends.restore().filter((row) => row.id !== reopened?.pendingSendId);

  if (rows.length === 0) return;

  const midTurn: (UserSteer & { mode: WorkMode })[] = [];
  // Sends bound to a dead turn: one rerun per turn, in acceptance order, under the narrowest mode (plan).
  // Merging never widens a message's mode.
  const dead = new Map<string, PendingSendRow[]>();
  let queued = 0;

  for (const row of rows) {
    if (row.turnId === null) {
      port.queue(tagged({
        text: row.text, kind: 'user', turnId: row.id,
        // Kept ahead of anything the new session admits.
        rerun: true,
        pendingSendId: row.id,
        metadata: { ...port.pendingSends.metadata(row.id), kinuMode: row.mode },
        files: port.pendingSends.files(row.id),
        settle: () => {},
      }));
      queued += 1;
    } else if (row.turnId === reopened?.turnId) {
      midTurn.push({
        id: row.id, text: row.text, mode: row.mode,
        files: port.pendingSends.files(row.id),
      });
    } else {
      dead.set(row.turnId, [...(dead.get(row.turnId) ?? []), row]);
    }
  }

  for (const group of dead.values()) {
    const sends = group.map((row) => ({ id: row.id, text: row.text, files: port.pendingSends.files(row.id), mode: row.mode }));

    port.queue(port.leftover(sends, group[0] === undefined ? undefined : port.pendingSends.metadata(group[0].id)));
    queued += 1;
  }

  if (midTurn.length > 0) port.restoreMidTurn(midTurn);

  port.notice('pending_sends_restored', `restored ${rows.length} acknowledged send${rows.length === 1 ? '' : 's'} the last process left`);

  if (queued > 0) port.pumpSoon();
}
