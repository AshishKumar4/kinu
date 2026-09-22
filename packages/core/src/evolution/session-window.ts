// One durable row per completed turn that still owes evolution work, carrying
// two lifetimes: window membership (`in_window`, `claim()`/`settle()`) and the
// review obligation ('awaiting_followup' | 'queued' | 'claimed' | 'done'). The
// row is deleted only when both are over, so they cannot disagree.
//
// A window is settled only after its pass runs, so a host that exits mid-cycle
// leaves its turns for the next host. EvolutionEngine's constructor creates
// this table.

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CompletedTurn } from './types';
import { JsonObjectSchema, JsonValueSchema, parseJsonValue } from '../utils/json';
import { UsageSchema } from '../usage';
import { diagnostics, toKinuError, tolerate } from '../obs/index';
import {
  initEffectTombstoneTable, effectAlreadyDone, recordEffectDone,
} from '../identity/effect-tombstones';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { ToolOutcomeSchema } from '../tools/outcome';

/** The one durable mirror of {@link CompletedTurn}; a second mirror would drift
 *  into turns that silently fail to decode. */
export const CompletedTurnSchema: v.GenericSchema<CompletedTurn> = v.object({
  userMessage: v.string(),
  assistantResponse: v.string(),
  toolCalls: v.array(v.object({
    toolCallId: v.optional(v.string()),
    name: v.string(),
    args: JsonObjectSchema,
    result: v.optional(JsonValueSchema),
    outcome: v.optional(ToolOutcomeSchema),
  })),
  craftedToolsUsed: v.optional(v.array(v.string())),
  steps: v.number(),
  durationMs: v.number(),
  feedback: v.nullable(v.picklist(['positive', 'negative'])),
  hadError: v.boolean(),
  turnId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  origin: v.optional(v.picklist(['user', 'programmatic'])),
  usage: v.optional(UsageSchema),
  // Persisted with the turn: the drain needs it after the running scope is gone.
  missionLabels: v.optional(v.array(v.pipe(v.string(), v.nonEmpty()))),
});

const APPEND_SCOPE = 'turn_append';

/** The review's side effects ran; distinct from the row's `done` lease state. */
const REVIEW_SCOPE = 'turn_review';

export function initCompletedTurnTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS completed_turns (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    turn       TEXT NOT NULL,
    followup   TEXT,
    in_window  INTEGER NOT NULL,
    review     TEXT NOT NULL CHECK (review IN ('none','awaiting_followup','queued','claimed','done')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_completed_turns_review
             ON completed_turns(actor_id, review, created_at)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_completed_turns_window
             ON completed_turns(actor_id, in_window, created_at)`);
  // Both lifetimes end in a DELETE of replayable work, so tombstones are part
  // of this table's contract.
  initEffectTombstoneTable(execRaw);
}

/**
 * Reviews one session open drains. The drain delays the first turn, so the
 * batch is one reflection window; the rest stays queued for the next open.
 */
export const MAX_TURN_REVIEWS_PER_OPEN = 5;

/**
 * Ceiling for a workspace nothing drains (one-shot invocations only); above the
 * reflection interval so a full window can be owed without shedding.
 */
const MAX_QUEUED_TURN_REVIEWS = 32;

/** Turns stay in the window until `settle()`, so a host dying mid-pass leaves
 *  them for the next host. */
export interface ClaimedWindow {
  readonly turns: CompletedTurn[];
  readonly startedAt: number;
  /** Retire exactly the claimed rows; turns appended meanwhile open the next window. */
  settle(): void;
}

/** Stays `claimed` until {@link CompletedTurnStore.settleReview}, so a crash mid-review is recoverable. */
export interface PendingTurnReview {
  readonly rowId: string;
  readonly turn: CompletedTurn;
}

/** A review some host owes: `reviewTurn`'s arguments plus the row id. */
export interface DeferredTurnReview {
  readonly id: string;
  readonly turn: CompletedTurn;
  /** Null when no follow-up can grade the turn; carried so drains need not guess. */
  readonly followup: string | null;
  readonly queuedAt: number;
}

/**
 * A row the drain would not run. `unreadable` retires it: a corrupt row of our
 * own must not produce a verdict or wedge the queue. `budget` re-queues it:
 * the mission is over its cap and the owner may raise it.
 */
export interface RefusedTurnReview {
  readonly id: string;
  readonly reason: 'unreadable' | 'budget';
}

/** `queue_full` and `unserializable` are refusals: no later host will find the review. */
export type EnqueueOutcome = 'queued' | 'queue_full' | 'unserializable';

export interface DeferredReviewDrain {
  readonly reviewed: number;
  readonly refused: readonly RefusedTurnReview[];
}

export interface TakenTurnReviews {
  readonly reviews: readonly DeferredTurnReview[];
  readonly refused: readonly RefusedTurnReview[];
}

export interface AppendTurnOpts {
  /** Whether a follow-up that could grade this turn can still arrive; false for
   *  programmatic turns and one-shot hosts, whose next input is not a reply. */
  awaitsFollowup: boolean;
  /** Caller-owned durable identity; makes the append idempotent via the
   *  `turn_append` tombstone, since `sweepSettled` may already have deleted the
   *  row. Omit when the recording cannot be replayed. */
  id?: string;
  /** Epoch ms; defaults to now. */
  now?: number;
}

export interface CompletedTurnStore {
  /** Joins the open window and, when `awaitsFollowup`, parks for review. Returns
   *  the row id (or `opts.id`). */
  append(turn: CompletedTurn, opts: AppendTurnOpts): string;
  size(): number;
  /** Null when empty; the caller settles once the pass has run. */
  claim(): ClaimedWindow | null;
  claimPendingReview(): PendingTurnReview | null;
  /** Demote parked reviews into the owed queue; the caller decides when a
   *  follow-up can no longer grade them. `before` limits demotion to rows
   *  created at or before it, so a replayed old task cannot demote a newer
   *  turn's review. Returns the count. */
  expireAwaitingReviews(opts?: { before?: number }): number;
  settleReview(rowId: string): void;
  /** The review's side effects landed. Separate from the lease so recovery does
   *  not re-run a review that finished before {@link settleReview}. Idempotent. */
  recordReviewRan(rowId: string): void;
  /** With `storedRowId`, the existing row becomes the owed review rather than a copy. */
  enqueueReview(
    turn: CompletedTurn,
    followup: string | null,
    opts?: { storedRowId?: string },
  ): EnqueueOutcome;
  /** Take the oldest `limit` queued reviews into `claimed`; rows whose review
   *  already ran are settled instead. */
  takeQueuedReviews(limit: number): TakenTurnReviews;
  /** Re-queue a claimed review after a refusal (budget), not a completion. */
  releaseQueuedReview(rowId: string): void;
  countQueuedReviews(): number;
  /** Re-queue claims whose process died, unless the review already ran (then
   *  settle). Returns how many rows were re-queued. */
  resetStaleClaims(): number;
}

interface TurnRow { id: string; turn: string; followup: string | null; created_at: number }

/** Bound to one actor: ids can collide across actors, and window size, queue
 *  depth and stale-claim sweeps are counts. */
export function createCompletedTurnStore(sql: SqlExecutor, actor: ActorHandle): CompletedTurnStore {
  const actorId = actor.actorId;
  const authorize = actor.assertCurrent;

  // Rows with both lifetimes over carry nothing; dropping them bounds the table.
  const sweepSettled = (): void => {
    void sql`DELETE FROM completed_turns
      WHERE actor_id = ${actorId} AND in_window = 0 AND review IN ('none','done')`;
  };

  const decode = (row: TurnRow): CompletedTurn | null => {
    // Unreadable rows (e.g. another code version) are skipped so the cadence never stalls.
    const parsed = v.safeParse(
      CompletedTurnSchema,
      tolerate(() => parseJsonValue(row.turn), 'malformed-input'),
    );

    return parsed.success ? parsed.output : null;
  };

  const retireUnreadable = (row: TurnRow, cause: Error): void => {
    void sql`UPDATE completed_turns SET review = 'done'
      WHERE actor_id = ${actorId} AND id = ${row.id}`;
    diagnostics.failure(
      'evolution.stored_turn_unreadable',
      toKinuError({
        doing: 'decode a stored completed turn',
        cause,
        otherwise: 'bad_input',
      }),
      { rowId: row.id },
    );
  };

  return {
    append(turn, opts) {
      // A keyed replay has nothing to add, and its row may already be swept.
      authorize();

      if (opts.id !== undefined && effectAlreadyDone(sql, actor, APPEND_SCOPE, opts.id)) return opts.id;
      const encoded = JSON.stringify(turn);

      // The review obligation is written in the same insert, so an eviction
      // cannot lose it and a replay cannot dispatch it twice.
      const review = opts.awaitsFollowup ? 'awaiting_followup' : 'queued';
      const id = opts.id ?? `turn-${nanoid()}`;
      const now = opts.now ?? nowMs();
      // DO NOTHING: a replay must not reset the state the original row reached.
      void sql`INSERT INTO completed_turns (actor_id, id, turn, followup, in_window, review, created_at)
          VALUES (${actorId}, ${id}, ${encoded}, ${null}, 1, ${review}, ${now})
          ON CONFLICT(actor_id, id) DO NOTHING`;

      // Same synchronous pass, so nothing observes the row without its tombstone.
      if (opts.id !== undefined) recordEffectDone(sql, actor, { scope: APPEND_SCOPE, key: opts.id }, now);
      sweepSettled();

      return id;
    },

    size() {
      authorize();

      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM completed_turns
        WHERE actor_id = ${actorId} AND in_window = 1`[0]?.n ?? 0;
    },

    claim() {
      authorize();

      const rows = sql<TurnRow>`
        SELECT id, turn, followup, created_at FROM completed_turns
        WHERE actor_id = ${actorId} AND in_window = 1 ORDER BY created_at ASC, rowid ASC`;

      const oldest = rows[0];

      if (oldest === undefined) return null;

      return {
        turns: rows.map(decode).filter((t): t is CompletedTurn => t !== null),
        startedAt: oldest.created_at,
        settle() {
          // Retire by claimed id: later appends belong to the next window, and
          // undecodable rows must still retire.
          authorize();

          for (const row of rows) {
            void sql`UPDATE completed_turns SET in_window = 0
              WHERE actor_id = ${actorId} AND id = ${row.id}`;
          }

          sweepSettled();
        },
      };
    },

    claimPendingReview() {
      authorize();

      const row = sql<TurnRow>`
        SELECT id, turn, followup, created_at FROM completed_turns
        WHERE actor_id = ${actorId} AND review = 'awaiting_followup'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`[0];

      if (!row) return null;
      void sql`UPDATE completed_turns SET review = 'claimed'
        WHERE actor_id = ${actorId} AND id = ${row.id}`;
      const turn = decode(row);

      if (!turn) {
        retireUnreadable(row, new Error('the stored turn is not a CompletedTurn'));

        return null;
      }

      return { rowId: row.id, turn };
    },

    settleReview(rowId) {
      // Tombstone first: after the sweep the row can no longer record that its review ran.
      recordEffectDone(sql, actor, { scope: REVIEW_SCOPE, key: rowId });
      void sql`UPDATE completed_turns SET review = 'done'
        WHERE actor_id = ${actorId} AND id = ${rowId}`;
      sweepSettled();
    },

    recordReviewRan(rowId) {
      recordEffectDone(sql, actor, { scope: REVIEW_SCOPE, key: rowId });
    },

    expireAwaitingReviews(opts) {
      authorize();
      // `created_at` is epoch ms, so MAX_SAFE_INTEGER means no cutoff.
      const before = opts?.before ?? Number.MAX_SAFE_INTEGER;

      const stale = sql<{ id: string }>`
        SELECT id FROM completed_turns
        WHERE actor_id = ${actorId} AND review = 'awaiting_followup' AND created_at <= ${before}`;

      if (stale.length === 0) return 0;
      void sql`UPDATE completed_turns SET review = 'queued'
          WHERE actor_id = ${actorId} AND review = 'awaiting_followup' AND created_at <= ${before}`;

      return stale.length;
    },

    enqueueReview(turn, followup, opts) {
      authorize();

      if (opts?.storedRowId) {
        // Convert the claimed row itself instead of writing a second copy.
        void sql`UPDATE completed_turns SET review = 'queued', followup = ${followup}
            WHERE actor_id = ${actorId} AND id = ${opts.storedRowId}`;

        return 'queued';
      }

      if (this.countQueuedReviews() >= MAX_QUEUED_TURN_REVIEWS) return 'queue_full';
      let encoded: string;

      try {
        encoded = JSON.stringify(turn);
      } catch (err) {
        diagnostics.failure(
          'evolution.deferred_review_unserializable',
          toKinuError({ doing: 'serialize a turn for its deferred review', cause: err, otherwise: 'bad_input' }),
        );

        return 'unserializable';
      }

      void sql`INSERT INTO completed_turns (actor_id, id, turn, followup, in_window, review, created_at)
          VALUES (${actorId}, ${`rev-${nanoid()}`}, ${encoded}, ${followup}, 0, 'queued', ${nowMs()})`;

      return 'queued';
    },

    takeQueuedReviews(limit) {
      authorize();

      const rows = sql<TurnRow>`
        SELECT id, turn, followup, created_at FROM completed_turns
        WHERE actor_id = ${actorId} AND review = 'queued'
        ORDER BY created_at ASC, rowid ASC LIMIT ${limit}`;

      const reviews: DeferredTurnReview[] = [];
      const refused: RefusedTurnReview[] = [];

      for (const row of rows) {
        // Work already landed; settle rather than offer or refuse it.
        if (effectAlreadyDone(sql, actor, REVIEW_SCOPE, row.id)) {
          void sql`UPDATE completed_turns SET review = 'done'
            WHERE actor_id = ${actorId} AND id = ${row.id}`;
          continue;
        }

        const turn = decode(row);

        if (!turn) {
          retireUnreadable(row, new Error('the stored turn is not a CompletedTurn'));
          refused.push({ id: row.id, reason: 'unreadable' });
          continue;
        }

        void sql`UPDATE completed_turns SET review = 'claimed'
          WHERE actor_id = ${actorId} AND id = ${row.id}`;
        reviews.push({ id: row.id, turn, followup: row.followup, queuedAt: row.created_at });
      }

      sweepSettled();

      return { reviews, refused };
    },

    releaseQueuedReview(rowId) {
      authorize();
      void sql`UPDATE completed_turns SET review = 'queued'
        WHERE actor_id = ${actorId} AND id = ${rowId} AND review = 'claimed'`;
    },

    countQueuedReviews() {
      authorize();

      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM completed_turns
        WHERE actor_id = ${actorId} AND review = 'queued'`[0]?.n ?? 0;
    },

    resetStaleClaims() {
      authorize();

      const stale = sql<{ id: string }>`
        SELECT id FROM completed_turns WHERE actor_id = ${actorId} AND review = 'claimed'`;

      if (stale.length === 0) return 0;
      // A claim is a lease: an eviction after `reviewTurn`'s append-only writes
      // but before `settleReview` must not re-run the review, so tombstoned rows
      // are settled and only the rest re-queued.
      let requeued = 0;

      for (const row of stale) {
        if (effectAlreadyDone(sql, actor, REVIEW_SCOPE, row.id)) {
          void sql`UPDATE completed_turns SET review = 'done'
            WHERE actor_id = ${actorId} AND id = ${row.id}`;
          continue;
        }

        void sql`UPDATE completed_turns SET review = 'queued'
          WHERE actor_id = ${actorId} AND id = ${row.id}`;
        requeued++;
      }

      sweepSettled();

      return requeued;
    },
  };
}
