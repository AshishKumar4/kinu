// CompletedTurnStore — ONE durable row per completed turn that still owes
// evolution work, carrying both of its independent lifetimes:
//
//   • WINDOW MEMBERSHIP — the open reflection window the session-evolution
//     pass consumes (`in_window`, `claim()`/`settle()`).
//   • REVIEW OBLIGATION — the typed state of the turn's outcome review:
//     'awaiting_followup' (a conversational follow-up may still grade it),
//     'queued' (a host owes the review), 'claimed' (a host is running it),
//     'done' (it ran). The row is DELETED only when both lifetimes are over.
//
// One row carries both lifetimes, so they cannot disagree: taking a turn
// awaiting review never destroys the row before its deferred copy exists,
// and a detached review that dies leaves its row behind instead of losing it.
//
// A window is CLAIMED for a session-evolution pass and settled only once that
// pass has run (`claim()` → `settle()`), never closed up front. That is what
// lets a host decline to wait for the pass: a `kinu exec` process that exits,
// or an interactive session the user quits mid-cycle, leaves its turns in the
// window for the next host that can afford the work — rather than consuming
// them for a pass that was killed halfway.
//
// The table lives in the workspace's SQLite next to the other evolution
// ledgers (turn_outcomes, lessons, replay_evals — created by EvolutionEngine's
// constructor, which owns this one too).

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { CompletedTurn } from './types';
import { JsonObjectSchema, JsonValueSchema, parseJsonValue } from '../utils/json';
import { UsageSchema } from '../usage';
import { diagnostics, toKinuError, tolerate } from '../obs/index';
import {
  initEffectTombstoneTable, effectAlreadyDone, recordEffectDone,
} from '../identity/effect-tombstones';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';

/** The durable mirror of {@link CompletedTurn} — the one schema every table
 *  that stores a snapshotted turn serializes through, because two mirrors of
 *  one type drift and the drift shows up as a turn that silently will not
 *  decode. */
export const CompletedTurnSchema: v.GenericSchema<CompletedTurn> = v.object({
  userMessage: v.string(),
  assistantResponse: v.string(),
  toolCalls: v.array(v.object({
    name: v.string(),
    args: JsonObjectSchema,
    result: v.optional(JsonValueSchema),
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
  // The label its review debits. Persisted with the turn rather than beside it,
  // so the deferred-review row already carries what the drain has to know: the
  // scope that ran the turn is long gone by then.
  missionLabels: v.optional(v.array(v.pipe(v.string(), v.nonEmpty()))),
});

/** The keyed append of one recorded turn. */
const APPEND_SCOPE = 'turn_append';
/** That turn's review having RUN — its `turn_outcomes` row, craft EMA move and
 *  lesson. Distinct from the row's `done` state, which is only the lease. */
const REVIEW_SCOPE = 'turn_review';

export function initCompletedTurnTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS completed_turns (
    id         TEXT PRIMARY KEY,
    turn       TEXT NOT NULL,
    followup   TEXT,
    in_window  INTEGER NOT NULL,
    review     TEXT NOT NULL CHECK (review IN ('none','awaiting_followup','queued','claimed','done')),
    created_at INTEGER NOT NULL
  )`);
  // Both of this row's lifetimes end in a DELETE, and both of them are keyed
  // durable work a backend can replay — so the tombstones are as much a part of
  // this table's contract as its own columns, and the store must never be
  // constructed without them.
  initEffectTombstoneTable(execRaw);
}

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

/** The open window, handed to ONE session-evolution pass. The turns stay in
 *  the window until `settle()`, so a host that dies mid-pass leaves them for
 *  the next host instead of consuming them for work that never happened. */
export interface ClaimedWindow {
  /** The claimed turns, oldest first. */
  readonly turns: CompletedTurn[];
  /** Epoch ms the window opened (its oldest turn). */
  readonly startedAt: number;
  /** Retire exactly the claimed rows. Turns appended while the pass ran stay
   *  in the window and open the next one. */
  settle(): void;
}

/** A turn claimed off `awaiting_followup` for its conversational review. The
 *  row stays `claimed` until {@link CompletedTurnStore.settleReview} — so a
 *  process that dies mid-review leaves a recoverable trace instead of losing
 *  the review. */
export interface PendingTurnReview {
  readonly rowId: string;
  readonly turn: CompletedTurn;
}

/** A review some host owes and has not run yet. Exactly `reviewTurn`'s two
 *  arguments, plus its row identity. */
export interface DeferredTurnReview {
  readonly id: string;
  readonly turn: CompletedTurn;
  /** The conversational follow-up that grades the turn, or null when no
   *  follow-up can — the same distinction `reviewTurn` reads, carried rather
   *  than re-guessed by whoever drains the row. */
  readonly followup: string | null;
  readonly queuedAt: number;
}

/**
 * A row the drain would not run, and why. Named rather than skipped, and each
 * reason states its own disposition, because a review that vanishes without one
 * is the failure this queue exists to prevent.
 *
 * `unreadable` RETIRES the row: it is this module's own write, so an undecodable
 * one is a corrupt database, and reviewing a default in its place would write a
 * `turn_outcomes` verdict against a turn nobody can read. One corrupt row must
 * not wedge the queue behind it either.
 *
 * `budget` RE-QUEUES it: the mission the turn ran under is over its cap, so the
 * host declined the review's model call. Nothing about the row is wrong and the
 * owner can raise the cap, so retiring it would throw away evidence the mission
 * already paid to produce. The queue's own ceiling bounds what that can cost.
 */
export interface RefusedTurnReview {
  readonly id: string;
  readonly reason: 'unreadable' | 'budget';
}

/** What {@link CompletedTurnStore.enqueueReview} did. `queue_full` and
 *  `unserializable` are refusals: the review does not exist and no later host
 *  will find it. */
export type EnqueueOutcome = 'queued' | 'queue_full' | 'unserializable';

/** What one drain accomplished. `refused` names the rows it would not review
 *  and why — a count alone cannot say whether a row is gone or still owed. */
export interface DeferredReviewDrain {
  readonly reviewed: number;
  readonly refused: readonly RefusedTurnReview[];
}

export interface TakenTurnReviews {
  readonly reviews: readonly DeferredTurnReview[];
  readonly refused: readonly RefusedTurnReview[];
}

/** How a completed turn enters the store. */
export interface AppendTurnOpts {
  /** Whether a conversational follow-up that could GRADE this turn can still
   *  arrive. Only then does the turn park awaiting review. The caller decides:
   *  a programmatic turn has no user behind it, and a one-shot host's next
   *  invocation is an independent task, not a reply — parking either would
   *  hand the classifier a "follow-up" that is not one. */
  awaitsFollowup: boolean;
  /** The row identity, when the caller has a durable one for the turn being
   *  recorded. It makes this append IDEMPOTENT: a replay of one turn's
   *  recording refuses instead of writing a second row, so the session
   *  cadence — which counts window rows — is not advanced twice by one turn.
   *
   *  The refusal is decided by the `turn_append` TOMBSTONE, not by the row:
   *  `sweepSettled` deletes the row as soon as its review is done and it has
   *  left the window, and `ON CONFLICT(id) DO NOTHING` protects nothing once
   *  that has happened — a replay would reinsert the same turn with a fresh
   *  queued review and `in_window = 1`.
   *
   *  The identity is the CALLER's because only the caller knows it. A window
   *  that minted its own could never recognise a replay: the second call would
   *  arrive with a fresh id and look like a new turn. A caller with no durable
   *  identity (an interactive session, whose recording cannot be replayed
   *  because nothing durable owes it) passes none and gets a fresh row. */
  id?: string;
  /** Epoch ms to stamp the row with. Defaults to now. */
  now?: number;
}

export interface CompletedTurnStore {
  /** Buffer a completed turn: it joins the open window, and — when a
   *  conversational follow-up can still grade it — additionally waits for
   *  that follow-up. Returns the row id (pass it to `enqueueReview`/
   *  settlement when the caller reviews immediately), or null when the turn
   *  could not be serialized. With `opts.id` the append is idempotent and the
   *  returned id is that one, whether this call wrote the row or found it. */
  append(turn: CompletedTurn, opts: AppendTurnOpts): string | null;
  /** How many turns the open window holds. */
  size(): number;
  /** Claim the open window for one session-evolution pass, or null when it is
   *  empty. The caller settles it once the pass has run. */
  claim(): ClaimedWindow | null;
  /** Claim the turn waiting to be graded by the next conversational message,
   *  if one is waiting. */
  claimPendingReview(): PendingTurnReview | null;
  /** Demote every turn still parked awaiting a follow-up into the owed queue.
   *  The CALLER decides when that happened: an independent task's arrival
   *  proves the conversational follow-up can never grade its predecessor,
   *  while a programmatic turn proves nothing about the conversation and must
   *  not displace it. Returns how many rows were demoted.
   *
   *  `before` scopes the demotion to rows created at or before that instant —
   *  the recorded turn's own clock, for a caller whose recording is replayable.
   *  A replay of an independent task that ended long ago must not demote the
   *  parked review of a NEWER conversational turn that did not exist when it
   *  ran. Absent, every parked row is demoted, which is what a live caller
   *  standing at the present moment means. */
  expireAwaitingReviews(opts?: { before?: number }): number;
  /** The claimed review ran — its obligation is settled, and the row may be
   *  swept. */
  settleReview(rowId: string): void;
  /** The review's own side effects have landed (the `turn_outcomes` row, the
   *  craft EMA move, the lesson). Split from its lease so recovery can tell
   *  "the review ran" from "a host held the row": a claim is only a lease, so
   *  an eviction after the side effects but before {@link settleReview} used to
   *  re-run the whole review on the next activation. Idempotent. */
  recordReviewRan(rowId: string): void;
  /** Defer one turn's review. With `storedRowId`, the turn is ALREADY a row
   *  here (just claimed) and the row itself becomes the owed review instead of
   *  a second copy. Returns what happened so the caller reports an honest
   *  reason rather than a silent no-op. */
  enqueueReview(
    turn: CompletedTurn,
    followup: string | null,
    opts?: { storedRowId?: string },
  ): EnqueueOutcome;
  /** Take the oldest `limit` queued reviews. Each taken row moves to
   *  `claimed`; settle or release it afterwards. A row whose review has already
   *  run is not offered — it is settled instead, so it stops being owed. */
  takeQueuedReviews(limit: number): TakenTurnReviews;
  /** Return a claimed queued review to the queue — a refusal that is a
   *  decision (budget), not a completion. */
  releaseQueuedReview(rowId: string): void;
  countQueuedReviews(): number;
  /** Activation recovery: a `claimed` review whose claiming process died is
   *  owed again — UNLESS its work already ran, in which case the claim outlived
   *  the review and the row is settled rather than re-queued. Returns how many
   *  rows were re-queued. */
  resetStaleClaims(): number;
}

interface TurnRow { id: string; turn: string; followup: string | null; created_at: number }

export function createCompletedTurnStore(sql: SqlExecutor): CompletedTurnStore {
  // A row whose two lifetimes are both over carries no information — dropping
  // it keeps the table bounded by the open window, the pending review, and the
  // owed queue.
  const sweepSettled = (): void => {
    void sql`DELETE FROM completed_turns WHERE in_window = 0 AND review IN ('none','done')`;
  };
  const decode = (row: TurnRow): CompletedTurn | null => {
    // A row written by another version of this code is skipped, not fatal —
    // the store buffers turns, and one unreadable turn must not stall the
    // cadence.
    const parsed = v.safeParse(
      CompletedTurnSchema,
      tolerate(() => parseJsonValue(row.turn), 'malformed-input'),
    );
    return parsed.success ? parsed.output : null;
  };
  const retireUnreadable = (row: TurnRow, cause: Error): void => {
    void sql`UPDATE completed_turns SET review = 'done' WHERE id = ${row.id}`;
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
      // Refused before the encode: a keyed replay has nothing to add and the
      // row it would have written may already be gone.
      if (opts.id !== undefined && effectAlreadyDone(sql, APPEND_SCOPE, opts.id)) return opts.id;
      // A turn that cannot be serialized cannot be replayed to the engine
      // later, and losing the whole window to one bad tool result would be
      // worse than losing that turn — so a failed encode drops just this turn.
      let encoded: string;
      try {
        encoded = JSON.stringify(turn);
      } catch (err) {
        diagnostics.failure(
          'evolution.session_turn_unserializable',
          toKinuError({ doing: 'serialize a completed turn', cause: err, otherwise: 'bad_input' }),
        );
        return null;
      }
      // `queued`, not `none`, and written in the SAME insert as the turn. The
      // review of a turn with no follow-up coming used to be DISPATCHED inline by
      // the caller after this insert returned, so an eviction between the two
      // left the row at `none` with its review lost, while a replay of the
      // recording dispatched it a second time. The obligation is now part of the
      // row, and the durable queued-review lane claims it exactly once.
      const review = opts.awaitsFollowup ? 'awaiting_followup' : 'queued';
      const id = opts.id ?? `turn-${nanoid()}`;
      const now = opts.now ?? nowMs();
      // DO NOTHING, not a replace: the row the first append wrote is the
      // recording, and a replay must leave the window membership and the
      // review state that row has since reached exactly as they are.
      void sql`INSERT INTO completed_turns (id, turn, followup, in_window, review, created_at)
          VALUES (${id}, ${encoded}, ${null}, 1, ${review}, ${now})
          ON CONFLICT(id) DO NOTHING`;
      // Same synchronous pass as the insert, so nothing can observe the row
      // without the tombstone that outlives it.
      if (opts.id !== undefined) recordEffectDone(sql, APPEND_SCOPE, opts.id, now);
      sweepSettled();
      return id;
    },

    size() {
      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM completed_turns WHERE in_window = 1`[0]?.n ?? 0;
    },

    claim() {
      const rows = sql<TurnRow>`
        SELECT id, turn, followup, created_at FROM completed_turns
        WHERE in_window = 1 ORDER BY created_at ASC, rowid ASC`;
      const oldest = rows[0];
      if (oldest === undefined) return null;
      return {
        turns: rows.map(decode).filter((t): t is CompletedTurn => t !== null),
        startedAt: oldest.created_at,
        settle() {
          // Retire by claimed id, not by `in_window = 1`: a turn appended while
          // the pass ran belongs to the NEXT window, and an undecodable row
          // must still retire or it would wedge the window forever.
          for (const row of rows) {
            void sql`UPDATE completed_turns SET in_window = 0 WHERE id = ${row.id}`;
          }
          sweepSettled();
        },
      };
    },

    claimPendingReview() {
      const row = sql<TurnRow>`
        SELECT id, turn, followup, created_at FROM completed_turns
        WHERE review = 'awaiting_followup' ORDER BY created_at DESC, rowid DESC LIMIT 1`[0];
      if (!row) return null;
      void sql`UPDATE completed_turns SET review = 'claimed' WHERE id = ${row.id}`;
      const turn = decode(row);
      if (!turn) {
        retireUnreadable(row, new Error('the stored turn is not a CompletedTurn'));
        return null;
      }
      return { rowId: row.id, turn };
    },

    settleReview(rowId) {
      // The tombstone first: settling makes the row sweepable, and after the
      // sweep the row can no longer say that its review ran.
      recordEffectDone(sql, REVIEW_SCOPE, rowId);
      void sql`UPDATE completed_turns SET review = 'done' WHERE id = ${rowId}`;
      sweepSettled();
    },

    recordReviewRan(rowId) {
      recordEffectDone(sql, REVIEW_SCOPE, rowId);
    },

    expireAwaitingReviews(opts) {
      // MAX_SAFE_INTEGER, not a second query: `created_at` is epoch ms, so an
      // absent cutoff is the same predicate with a bound nothing can exceed.
      const before = opts?.before ?? Number.MAX_SAFE_INTEGER;
      const stale = sql<{ id: string }>`
        SELECT id FROM completed_turns
        WHERE review = 'awaiting_followup' AND created_at <= ${before}`;
      if (stale.length === 0) return 0;
      void sql`UPDATE completed_turns SET review = 'queued'
          WHERE review = 'awaiting_followup' AND created_at <= ${before}`;
      return stale.length;
    },

    enqueueReview(turn, followup, opts) {
      if (opts?.storedRowId) {
        // The turn already lives here as a claimed row — convert THAT row into
        // the owed review instead of writing a second copy of it.
        void sql`UPDATE completed_turns SET review = 'queued', followup = ${followup}
            WHERE id = ${opts.storedRowId}`;
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
      void sql`INSERT INTO completed_turns (id, turn, followup, in_window, review, created_at)
          VALUES (${`rev-${nanoid()}`}, ${encoded}, ${followup}, 0, 'queued', ${nowMs()})`;
      return 'queued';
    },

    takeQueuedReviews(limit) {
      const rows = sql<TurnRow>`
        SELECT id, turn, followup, created_at FROM completed_turns
        WHERE review = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT ${limit}`;
      const reviews: DeferredTurnReview[] = [];
      const refused: RefusedTurnReview[] = [];
      for (const row of rows) {
        // Its work already landed and something re-queued the lease. Not a
        // refusal — there is nothing wrong with the row and nothing owed by it
        // — so it is settled here and never offered again.
        if (effectAlreadyDone(sql, REVIEW_SCOPE, row.id)) {
          void sql`UPDATE completed_turns SET review = 'done' WHERE id = ${row.id}`;
          continue;
        }
        const turn = decode(row);
        if (!turn) {
          retireUnreadable(row, new Error('the stored turn is not a CompletedTurn'));
          refused.push({ id: row.id, reason: 'unreadable' });
          continue;
        }
        void sql`UPDATE completed_turns SET review = 'claimed' WHERE id = ${row.id}`;
        reviews.push({ id: row.id, turn, followup: row.followup, queuedAt: row.created_at });
      }
      sweepSettled();
      return { reviews, refused };
    },

    releaseQueuedReview(rowId) {
      void sql`UPDATE completed_turns SET review = 'queued' WHERE id = ${rowId} AND review = 'claimed'`;
    },

    countQueuedReviews() {
      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM completed_turns WHERE review = 'queued'`[0]?.n ?? 0;
    },

    resetStaleClaims() {
      const stale = sql<{ id: string }>`
        SELECT id FROM completed_turns WHERE review = 'claimed'`;
      if (stale.length === 0) return 0;
      // THE defect this split exists for. A claim is a lease, not the work: an
      // eviction after `reviewTurn` appended its `turn_outcomes` row and moved
      // the craft EMAs, but before `settleReview`, used to arrive here and
      // re-run the whole review on the next activation — and both of those
      // writes are append-only or cumulative, so the duplicate is observable.
      // A row whose work is tombstoned is settled; only the rest is owed again.
      let requeued = 0;
      for (const row of stale) {
        if (effectAlreadyDone(sql, REVIEW_SCOPE, row.id)) {
          void sql`UPDATE completed_turns SET review = 'done' WHERE id = ${row.id}`;
          continue;
        }
        void sql`UPDATE completed_turns SET review = 'queued' WHERE id = ${row.id}`;
        requeued++;
      }
      sweepSettled();
      return requeued;
    },
  };
}
