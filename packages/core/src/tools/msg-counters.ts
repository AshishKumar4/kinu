/**
 * Counters for delegation cross-talk — how much agents message each other, what
 * it costs them to wait, and where two of them write the same file.
 *
 * ## Why this exists, and why it is only counters
 *
 * The `msg` action is peer-to-peer cross-talk: a worker can address any agent on
 * the roster, and on the peer transport that roster reaches the owner's OTHER
 * workspaces' agents. A `hire` without `scope:'workspace'` seats the child on
 * the parent's own file plane, so several hired agents write the same bytes with
 * no lock between them.
 *
 * Both are shapes another harness measured and then removed: equal-role
 * coordination through a shared file, where agents held locks too long, forgot
 * to release them, and twenty agents ran at the throughput of one to three. That
 * is a real finding about a real workload — and it is THEIR workload. No
 * contention, wait or throughput figure exists for this tree at any fan-out, so
 * narrowing `msg` on the strength of it would be imitation rather than
 * engineering.
 *
 * So this module restricts nothing and refuses nothing. It counts, and it counts
 * the three quantities that would settle the question:
 *
 *   1. how many delegation messages an agent sends, and how many arrive;
 *   2. what a sender waits, and whether delivery was deferred rather than made;
 *   3. how often two agents' writes land on one path close enough together that
 *      neither could have seen the other's.
 *
 * ## What is never recorded
 *
 * A message BODY, in any field, on any line. The size of one is a number and is
 * recorded; the text is not, and `ReservedLogField` makes the obvious mistakes
 * (`content`, `body`, `prompt`, …) a compile error rather than a review note.
 * Agent names, topics and file paths ARE recorded: fan-out is meaningless
 * without distinct targets, and a collision is unactionable without its path.
 *
 * ## Reading the lines
 *
 * Every line carries `at`, the wall clock in epoch milliseconds, because the
 * logger's envelope carries no timestamp of its own and two of the three
 * questions are about elapsed time. `agents.msg.sent` and `agents.msg.received`
 * both carry `message_id` — the sender's outbox row id, which the receiver sees
 * as `sender_event_id` — so a queued send joins to the delivery it eventually
 * got and the residual queue wait falls out of the two `at` values. That join is
 * how end-to-end wait is obtained; the sender's own `wait_ms` is only the part
 * its turn was blocked for.
 */

import { diagnostics } from '../obs/index';
import { nowMs } from '../utils/date';

/** Which substrate carried the message. `peer` crosses a workspace boundary
 *  (PeerHub → outbox row → the receiver's own event log); `subordinate` stays
 *  inside one workspace and lands as an event on a child this actor owns. */
export type MsgTransport = 'peer' | 'subordinate';

/** How the sender said WHO. `agent` names a roster entry; `event` answers the
 *  inbound message event that asked, and its target is that event's id. */
export type MsgAddressing = 'agent' | 'event';

/**
 * What the transport answered.
 *
 * `delivered` and `queued` are the transports' own vocabulary and mean what they
 * say there: reached the target's context, versus admitted and waiting behind
 * work already accepted. `replied` is a send-and-await that came back with an
 * answer, so its `wait_ms` includes the other agent's whole think time — the
 * number that says whether fan-out is actually parallel. `rejected` is the
 * transport declining; `failed` is it throwing.
 */
export type MsgOutcome = 'delivered' | 'queued' | 'replied' | 'rejected' | 'failed';

/** Everything known about a delegation message BEFORE it is handed over. */
export interface MsgSendFact {
  /** The delegation verb the caller used — `msg`, or the `hire` that hands the
   *  workstream to an agent that already exists. Both are one message on one
   *  transport; separating them keeps "cross-talk" and "handoff" countable
   *  apart without needing two event names. */
  readonly action: 'msg' | 'hire';
  readonly transport: MsgTransport;
  readonly addressing: MsgAddressing;
  /** The agent name addressed, or the event id being answered. */
  readonly target: string;
  /** Message length in characters. The SIZE of what was said, never the text. */
  readonly chars: number;
}

/** The transport's answer, reduced to the two facts a counter can carry. */
export interface MsgSendResult {
  readonly outcome: MsgOutcome;
  /** The transport's own id for this message — the outbox row id on the peer
   *  path, the handoff event id on the subordinate path. The join key to the
   *  `agents.msg.received` line, and absent only when the transport refused
   *  before minting one. */
  readonly messageId?: string;
}

/** Delegation messages this process has issued, and how many are in the air.
 *  Process-scoped rather than turn-scoped on purpose: a turn is a window a
 *  reader draws over these lines, and `inflight` — the quantity that says
 *  whether cross-talk is CONTENDING — is only meaningful across turns, because
 *  the agents contending are in different ones. */
let sentTotal = 0;
let inflight = 0;
let receivedTotal = 0;

/**
 * Hand one delegation message to its transport, timed and counted.
 *
 * The whole instrument is the wrapper: `send` is called exactly once, its result
 * is returned exactly as it came back, and a throw propagates unchanged after
 * being counted as `failed`. Nothing here can refuse a message, delay one, or
 * change what the caller sees — a counter that could alter delivery would be
 * the restriction this lane exists not to impose.
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
    emitSent(fact, read(result), started, concurrent, sequence);
    return result;
  } catch (cause) {
    emitSent(fact, { outcome: 'failed' }, started, concurrent, sequence);
    throw cause;
  } finally {
    inflight -= 1;
  }
}

/**
 * `agents.msg.sent` — one line per delegation message handed to a transport.
 *
 * `wait_ms` is the sender's blocked time and nothing more: from handing the
 * message over to having an outcome. On a fire-and-forget send that is the
 * enqueue plus whatever inline dispatch the hub attempted; on a send-and-await
 * it is the answering agent's entire turn. It is deliberately NOT called
 * "delivery latency" — for `outcome:'queued'` the message had not been delivered
 * when this line was written, and the rest of that wait is recoverable only by
 * joining `message_id` to the receiver's line.
 */
function emitSent(
  fact: MsgSendFact,
  result: MsgSendResult,
  started: number,
  concurrent: number,
  sequence: number,
): void {
  const at = nowMs();
  diagnostics.event('agents.msg.sent', {
    action: fact.action,
    transport: fact.transport,
    addressing: fact.addressing,
    target: fact.target,
    outcome: result.outcome,
    message_id: result.messageId ?? '',
    wait_ms: at - started,
    chars: fact.chars,
    sent: sequence,
    inflight: concurrent,
    at,
  });
}

/** An inbound peer message, as the receiving transport saw it. */
export interface MsgReceivedFact {
  readonly from: string;
  readonly topic: string;
  /** The sender's outbox row id — the join key back to `agents.msg.sent`. */
  readonly messageId: string;
  /** Serialized body length in characters. Never the body. */
  readonly chars: number;
  /** False when the receiver refused it — an ungranted cross-owner sender, or a
   *  log that would not take it. A refused message is still traffic that
   *  arrived, so it is counted here rather than dropped. */
  readonly admitted: boolean;
}

/**
 * `agents.msg.received` — one line per peer message the receiving transport
 * took off the wire, admitted or not.
 *
 * This is the ARRIVAL, not the consumption: an admitted message becomes an event
 * in the receiver's log and drains into a programmatic turn later, and the gap
 * between the two is the receiver's own backlog rather than the transport's.
 * Counting arrival is what makes `sent` and `received` comparable at all — they
 * are then the same event observed at both ends, and the difference between
 * their `at` values is the queue wait that actually elapsed before delivery.
 */
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
 * How close two writes to one path have to be for neither agent to have seen
 * the other's.
 *
 * A RETENTION BOUND rather than a finding: every line carries `gap_ms`, so a
 * reader who thinks the real window is thirty seconds re-windows the same data
 * without re-instrumenting anything. All the constant decides is how long a
 * path's last author stays worth remembering.
 *
 * One minute, and NOT the five that first suggested itself: 300_000 is already
 * `STEP_UP_WINDOW_MS` (cf-backend auth) and `HMAC_TIMESTAMP_WINDOW_MS` (webhook
 * ingress), a pair `gate:policy-drift` reports precisely because one policy is
 * written under two names. A third window at that value made the pair
 * ambiguous and the gate went quiet on a real finding — which is the strongest
 * argument available that this number must not be five minutes. A minute also
 * bounds the ledger tighter, and a collision a reader would have wanted at
 * ninety seconds is not lost: the write is still in {@link TRACKED_PATHS} and
 * the next write to that path reports its true gap.
 */
const WRITE_SETTLE_WINDOW_MS = 60_000;

/** Paths remembered at once. Bounds the ledger for a run that touches tens of
 *  thousands of files; the eviction is oldest-write-first, which is the same
 *  order the window would have retired them in. */
const TRACKED_PATHS = 4_096;

interface PathWrite {
  readonly writer: WriteAuthor;
  readonly at: number;
}

/** Insertion-ordered by last write, so the front is always the oldest entry.
 *  A repeat write deletes before it sets, because a Map overwrite keeps the
 *  original position and would strand the evictable entry at the front. */
const lastWriteByPath = new Map<string, PathWrite>();

/**
 * One writing agent, as the collision ledger knows it.
 *
 * A number, and deliberately not a name: the only question a collision asks of
 * identity is "a DIFFERENT one?". The write seam has no agent name to give —
 * the file planes below it are per-actor views of shared bytes and carry no
 * author — and minting one here would be a second, wrong source of truth
 * beside the roster. An ordinal answers the question that is actually asked and
 * claims nothing further.
 */
export type WriteAuthor = number;

/** Claim an author ordinal. Called once per writer, at its construction, so
 *  the identity is fixed for that writer's whole life rather than derived per
 *  write from something that could change under it. */
export function newWriteAuthor(): WriteAuthor {
  authorCount += 1;
  return authorCount;
}

let authorCount = 0;
let collisionCount = 0;

/**
 * Record that `writer` wrote `path`, and count it when another agent wrote the
 * same path inside the settle window.
 *
 * `author` is the writing actor's own turn ledger's ordinal — one per actor,
 * which is what makes "a different agent" answerable at the moment a write
 * lands rather than by a diff afterwards. Sibling agents run concurrently over
 * one workspace's files, so an end-of-run comparison smears all of their work
 * into one pile; this is the same reason head attribution happens at the write.
 *
 * The same agent rewriting its own file is not a collision and is not counted —
 * it is the ordinary shape of an edit followed by a fix.
 *
 * `agents.msg.write_collision` carries `gap_ms` (elapsed since the other
 * agent's write), `writer` and `other` (the two author ordinals), and
 * `collisions`, the running total. It is emitted per COLLIDING WRITE, so a file
 * two agents trade six times reports six lines and not one.
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
