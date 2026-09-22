/**
 * Transient per-delta output of a running head, filling the gap before a durable step lands. Best
 * effort and subordinate: the durable step supersedes it, and nothing reads a frame back. One frame
 * per provider delta, never batched.
 */
import type { HeadId } from './types';

export type HeadStreamKind = 'text' | 'reasoning';

/** The wire discriminant `type: 'head_stream'` lives at the broadcast site. `kind` is required. */
export interface HeadStreamFrame {
  readonly headId: HeadId;
  readonly kind: HeadStreamKind;
  readonly delta: string;
}

/** {@link ReportHeadDelta} has its id bound; {@link PublishHeadStream} carries it per frame. Neither is awaited or may fail the work. */
export type ReportHeadDelta = (kind: HeadStreamKind, delta: string) => void;

export type PublishHeadStream = (frame: HeadStreamFrame) => void;
