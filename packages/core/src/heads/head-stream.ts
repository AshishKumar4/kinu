/**
 * The transient half of a running head's output.
 *
 * `head_activity` (live-journal.ts) says a branch's LEDGER moved: it fires on
 * the durable write and carries an id, so a reader re-reads the journal it
 * already renders from. That is the whole liveness story for a branch that has
 * finished a step — and it is silent for the tens of seconds a step is being
 * produced. An open transcript therefore sat still while its head was working,
 * which reads exactly like a head that has stopped.
 *
 * These frames fill that gap and nothing else. They are BEST EFFORT and
 * SUBORDINATE: the durable step supersedes whatever was painted from them, so a
 * dropped frame needs no repair and no frame is ever read back. Nothing derives
 * a count, a status or a transcript from them.
 *
 * A FRAME IS ONE PROVIDER DELTA. The boundary is the one the model's stream
 * already drew, so nothing here batches, buffers, holds or times anything: what
 * a reader concatenates is byte-for-byte what the provider emitted, in the order
 * it emitted it. There is no size to tune and no tail that can outlive the step
 * it belongs to.
 *
 * A hosted head publishes across a Durable Object boundary, so call volume is a
 * real question — but it is a question for MEASUREMENT, against a real provider
 * stream and a real root. A guessed batch size would trade live behaviour for an
 * unmeasured saving and hide the number we would need to see.
 */
import type { HeadId } from './types';

/** Which half of a step's output a frame carries. */
export type HeadStreamKind = 'text' | 'reasoning';

/**
 * One transient frame's payload — declared once, so every producer and the
 * client validator agree on it.
 *
 * The WIRE DISCRIMINANT is not here. `type: 'head_stream'` is a websocket
 * protocol fact and belongs at the one broadcast site, exactly where
 * `head_activity`'s literal lives; core owns what varies. It also keeps the
 * channel legible to the wiring gate that scans broadcast call sites for the
 * literal it fans out.
 *
 * `kind` is REQUIRED: a client separates thinking from prose, and a frame that
 * omitted it would be dropped by the validator rather than painted as either.
 */
export interface HeadStreamFrame {
  readonly headId: HeadId;
  readonly kind: HeadStreamKind;
  readonly delta: string;
}

/**
 * The two halves of the sink, and the id is what separates them.
 *
 * {@link ReportHeadDelta} is what ONE agent's loop calls: it produces frames for
 * itself, so its id is already bound and nothing inside the loop can name a
 * different branch. {@link PublishHeadStream} is what a RUN-level channel takes —
 * one search publishes for every node it drives — so the id travels with the
 * frame. Whoever knows which agent is running binds one to the other, which is
 * where `nodeLoopDeps` already binds the node's durable step sink.
 *
 * Neither is awaited and neither may fail the work it watches.
 */
export type ReportHeadDelta = (kind: HeadStreamKind, delta: string) => void;
export type PublishHeadStream = (frame: HeadStreamFrame) => void;
