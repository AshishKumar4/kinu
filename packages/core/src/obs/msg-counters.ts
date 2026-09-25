/**
 * Delegation cross-talk counters: messages sent/received, sender wait, and same-path writes by different agents.
 * Counts only; never restricts or delays. Bodies are never recorded (`ReservedLogField` enforces it); sizes, names,
 * topics and paths are. `message_id` joins sent to received lines.
 *
 * Limits: a collision is a path and a clock, not a proven overwrite; the author ledger keys on path spelling per
 * process, so agents on private homes sharing a spelling are miscounted; shell writes are invisible; sent and
 * received totals live in different processes and do not subtract.
 */

import { diagnostics } from './index';
import { nowMs } from '../utils/date';

/** `peer` crosses a workspace boundary; `subordinate` stays inside one workspace. */
export type MsgTransport = 'peer' | 'subordinate';

/** `agent` names a roster entry; `event` answers an inbound message event by id. */
export type MsgAddressing = 'agent' | 'event';

/** `replied` is a send-and-await that got an answer; its `wait_ms` includes the other agent's think time. */
export type MsgOutcome = 'delivered' | 'queued' | 'replied' | 'rejected' | 'failed';

export interface MsgSendFact {
  readonly action: 'msg' | 'hire';
  readonly transport: MsgTransport;
  readonly addressing: MsgAddressing;
  /** The agent name addressed, or the event id being answered. */
  readonly target: string;
  /** Message length in characters, never the text. */
  readonly chars: number;
}

export interface MsgSendResult {
  readonly outcome: MsgOutcome;
  /** Join key to `agents.msg.received`; absent only when the transport refused before minting one. */
  readonly messageId?: string;
}

/** Process-scoped: `inflight` contention only means something across turns. */
let sentTotal = 0;

let inflight = 0;

let receivedTotal = 0;

/**
 * Hand one delegation message to its transport, timed and counted. `send` runs
 * once; its result or throw passes through unchanged.
 */
export async function countedMsgSend<Result>(
  fact: MsgSendFact,
  send: () => Promise<Result>,
  read: (result: Result) => MsgSendResult,
): Promise<Result> {
  const started = nowMs();
  const concurrent = inflight;
  sentTotal += 1;
  const sequence = sentTotal;
  inflight += 1;

  try {
    const result = await send();
    emitSent(fact, read(result), { started, concurrent, sequence });

    return result;
  } catch (cause) {
    emitSent(fact, { outcome: 'failed' }, { started, concurrent, sequence });
    throw cause;
  } finally {
    inflight -= 1;
  }
}

interface MsgSendPosition {
  readonly started: number;
  readonly concurrent: number;
  readonly sequence: number;
}

/** `wait_ms` is sender blocked time only, not delivery latency. */
function emitSent(fact: MsgSendFact, result: MsgSendResult, position: MsgSendPosition): void {
  const at = nowMs();
  diagnostics.event('agents.msg.sent', {
    action: fact.action,
    transport: fact.transport,
    addressing: fact.addressing,
    target: fact.target,
    outcome: result.outcome,
    message_id: result.messageId ?? '',
    wait_ms: at - position.started,
    chars: fact.chars,
    sent: position.sequence,
    inflight: position.concurrent,
    at,
  });
}

export interface MsgReceivedFact {
  readonly from: string;
  readonly topic: string;
  /** The sender's outbox row id. */
  readonly messageId: string;
  /** Serialized body length in characters. */
  readonly chars: number;
  /** False when refused or not logged; still counted as arrived traffic. */
  readonly admitted: boolean;
}

/** Counts arrival (not consumption), admitted or not. */
export function countMsgReceived(fact: MsgReceivedFact): void {
  receivedTotal += 1;
  diagnostics.event('agents.msg.received', {
    from: fact.from,
    topic: fact.topic,
    message_id: fact.messageId,
    chars: fact.chars,
    admitted: fact.admitted,
    received: receivedTotal,
    at: nowMs(),
  });
}

/**
 * Retention bound, not a finding: lines carry `gap_ms` for re-windowing. Not
 * 300_000: that value already trips `gate:policy-drift` for two other windows.
 */
const WRITE_SETTLE_WINDOW_MS = 60_000;

const TRACKED_PATHS = 4_096;

interface PathWrite {
  readonly writer: WriteAuthor;
  readonly at: number;
}

/** Insertion-ordered by last write; repeat writes delete before set so the front stays oldest. */
const lastWriteByPath = new Map<string, PathWrite>();

/** Ordinal writer identity; collisions only ask "a different one?". */
export type WriteAuthor = number;

/** Call once per writer, at construction. */
export function newWriteAuthor(): WriteAuthor {
  authorCount += 1;

  return authorCount;
}

let authorCount = 0;

let collisionCount = 0;

/**
 * Record a write; emit `agents.msg.write_collision` when a different author
 * wrote the same path inside the settle window.
 */
export function countSharedWrite(author: WriteAuthor, path: string): void {
  const at = nowMs();
  const previous = lastWriteByPath.get(path);
  lastWriteByPath.delete(path);
  lastWriteByPath.set(path, { writer: author, at });
  evictOldestPaths();

  if (previous === undefined || previous.writer === author) return;
  const gap = at - previous.at;

  if (gap > WRITE_SETTLE_WINDOW_MS) return;
  collisionCount += 1;
  diagnostics.event('agents.msg.write_collision', {
    path,
    gap_ms: gap,
    window_ms: WRITE_SETTLE_WINDOW_MS,
    writer: author,
    other: previous.writer,
    collisions: collisionCount,
    at,
  });
}

function evictOldestPaths(): void {
  while (lastWriteByPath.size > TRACKED_PATHS) {
    const oldest = lastWriteByPath.keys().next();

    if (oldest.done === true) return;
    lastWriteByPath.delete(oldest.value);
  }
}
