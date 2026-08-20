// The deferred turn-review queue — the TURN LANE's answer to the question the
// CADENCE LANE already answered.
//
// A one-shot host (`kinu exec` / `kinu run`) is one process per task. It
// never STARTS the cadence lane, because it cannot finish it; the turn writes
// one durable row and the daemon or the next interactive open runs the work
// (scaffold/shadow.ts, `scaffold_trial_queue`). The turn lane had no such
// escape: `settleEvolution()` JOINED it at exit, so the outcome review — a
// classifier call plus, when the turn went wrong, a reflection and a pattern
// extraction — was charged in full to the process that had already answered the
// user. Measured on a one-line task (TB2.1, 2026-08-20): 27.4s of turn against
// 64.9s of `evolution.settled waitedOn:"Turn review"`.
//
// So the one-shot host defers the same way: `reviewTurn`'s two inputs — the
// snapshotted CompletedTurn and the follow-up that grades it — go into
// `turn_review_queue`, and the next host that can afford the work runs them
// through the SAME `engine.reviewTurn` path. Nothing is dropped and nothing is
// re-derived: the row carries exactly what the inline call would have received.
//
// The row is retired only AFTER its review has run, exactly as the session
// window retires only after the pass it fed settles — so a host that dies
// mid-review leaves the review for the next one rather than consuming it for
// work that never happened.
//
// Two bounds, for two different failure modes:
//   • MAX_QUEUED_TURN_REVIEWS caps the table, for the workspace that is only
//     ever driven by `kinu exec` with no daemon running and no interactive
//     open — nothing there ever drains, so the queue needs a ceiling rather
//     than a promise.
//   • MAX_TURN_REVIEWS_PER_OPEN caps ONE drain, so a backlog cannot stall the
//     fresh turn the host actually opened for.

import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { CompletedTurn } from './types';
import { CompletedTurnSchema } from './session-window';
import { parseJsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { diagnostics, toProteusError, tolerate } from '../obs/index';

export function initTurnReviewQueueTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS turn_review_queue (
    id TEXT PRIMARY KEY,
    turn TEXT NOT NULL,
    followup TEXT,
    queued_at INTEGER NOT NULL
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_turn_review_queue_queued ON turn_review_queue(queued_at)`);
}

/**
 * Reviews one workspace may hold undrained.
 *
 * A drain normally empties the queue, so depth is one or two. The ceiling is
 * for the workspace nothing ever drains — only ever opened by one-shot
 * invocations, with no scheduler daemon and no interactive session — and is set
 * well above the session-reflection interval so a full window's worth of turns
 * can be owed at once without the queue starting to shed the newest evidence.
 */
const MAX_QUEUED_TURN_REVIEWS = 32;

/**
 * Reviews ONE session open drains.
 *
 * The drain runs before the host's first turn, so its cost is latency the user
 * is waiting on — the very thing the deferral exists to remove. One review is
 * one to three sequential fast-model completions, so the batch is sized to a
 * session-reflection window (five turns): enough that a normal backlog clears
 * in one open, small enough that an abandoned workspace's accumulated ceiling
 * cannot be paid all at once by whoever happens to open it next. What is not
 * drained stays queued for the next open.
 */
export const MAX_TURN_REVIEWS_PER_OPEN = 5;

/** A review the one-shot host deferred and nothing has run yet. Exactly
 *  `engine.reviewTurn`'s two arguments, plus its row identity. */
export interface DeferredTurnReview {
  readonly id: string;
  readonly turn: CompletedTurn;
  /** The conversational follow-up that grades the turn, or null when no
   *  follow-up can — the same distinction `reviewTurn` reads, carried rather
   *  than re-guessed by whoever drains the row. */
  readonly followup: string | null;
  readonly queuedAt: number;
}

/** A row the drain would not run, and why. Named rather than skipped: the row
 *  is this module's own write, so an unreadable one is a corrupt database, and
 *  reviewing a default in its place would write a `turn_outcomes` verdict
 *  against a turn nobody can read. */
export interface RefusedTurnReview {
  readonly id: string;
  readonly reason: 'unreadable';
}

/** What {@link queueTurnReview} did. `queue_full` and `unserializable` are
 *  refusals: the review does not exist and no later host will find it. */
export type TurnReviewQueueOutcome = 'queued' | 'queue_full' | 'unserializable';

/** What one drain of the queue accomplished. `refused` counts rows that were
 *  retired without being reviewed — see {@link RefusedTurnReview}. */
export interface DeferredReviewDrain {
  readonly reviewed: number;
  readonly refused: number;
}

export interface TakenTurnReviews {
  readonly reviews: readonly DeferredTurnReview[];
  readonly refused: readonly RefusedTurnReview[];
}

/**
 * Defer one turn's review. Returns what happened so the caller reports an
 * honest reason rather than a silent no-op.
 *
 * A turn that will not serialize is refused here rather than written as a row
 * that cannot be read back: the inline path would have reviewed it from memory,
 * and the deferral must not convert an unserializable turn into a corrupt row
 * the drain then has to refuse.
 */
export function queueTurnReview(
  sql: SqlExecutor,
  args: {
    turn: CompletedTurn;
    followup: string | null;
    now?: number;
  },
): TurnReviewQueueOutcome {
  if (countQueuedTurnReviews(sql) >= MAX_QUEUED_TURN_REVIEWS) return 'queue_full';
  let encoded: string;
  try {
    encoded = JSON.stringify(args.turn);
  } catch (err) {
    diagnostics.failure(
      'evolution.deferred_review_unserializable',
      toProteusError({ doing: 'serialize a turn for its deferred review', cause: err, otherwise: 'bad_input' }),
    );
    return 'unserializable';
  }
  void sql`INSERT INTO turn_review_queue (id, turn, followup, queued_at)
      VALUES (${`rev-${nanoid()}`}, ${encoded}, ${args.followup}, ${args.now ?? nowMs()})`;
  return 'queued';
}

/** How many reviews are owed and have not run. */
export function countQueuedTurnReviews(sql: SqlExecutor): number {
  return sql<{ n: number }>`SELECT COUNT(*) AS n FROM turn_review_queue`[0]?.n ?? 0;
}

/**
 * The oldest `limit` reviews, in the order they were deferred — oldest first,
 * because a later turn's lesson is worth more with the earlier turn's already
 * in the ledger.
 *
 * Undecodable rows are RETIRED here and reported as refusals. Retiring them is
 * what keeps one corrupt row from wedging the queue behind it forever, exactly
 * as the session window retires an undecodable claimed row; reporting them is
 * what keeps the refusal from looking like an empty queue.
 */
export function takeQueuedTurnReviews(sql: SqlExecutor, limit: number): TakenTurnReviews {
  type Row = { id: string; turn: string; followup: string | null; queued_at: number };
  const rows = sql<Row>`
    SELECT id, turn, followup, queued_at FROM turn_review_queue
    ORDER BY queued_at ASC, rowid ASC LIMIT ${limit}`;
  const reviews: DeferredTurnReview[] = [];
  const refused: RefusedTurnReview[] = [];
  for (const row of rows) {
    const parsed = v.safeParse(
      CompletedTurnSchema,
      tolerate(() => parseJsonValue(row.turn), 'malformed-input'),
    );
    if (!parsed.success) {
      dropQueuedTurnReview(sql, row.id);
      diagnostics.failure(
        'evolution.deferred_review_unreadable',
        toProteusError({
          doing: 'decode a deferred turn review',
          cause: new Error(parsed.issues[0]?.message ?? 'the row is not a CompletedTurn'),
          otherwise: 'bad_input',
        }),
        { reviewId: row.id },
      );
      refused.push({ id: row.id, reason: 'unreadable' });
      continue;
    }
    reviews.push({
      id: row.id,
      turn: parsed.output,
      followup: row.followup,
      queuedAt: row.queued_at,
    });
  }
  return { reviews, refused };
}

/** The review ran (or was refused) — the row's job is done. */
export function dropQueuedTurnReview(sql: SqlExecutor, id: string): void {
  void sql`DELETE FROM turn_review_queue WHERE id = ${id}`;
}
