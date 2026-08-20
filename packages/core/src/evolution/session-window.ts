// SessionWindow — the durable evolution window and the turn awaiting its
// outcome review.
//
// Both used to be fields on the AgentOrchestrator instance. That works only
// while the instance outlives the turns it is counting, and neither backend
// guarantees that: `kinu exec` is one process per turn (so the N-turn
// cadence was unreachable and every turn was graded by the session-end
// constant), and a Durable Object is evicted between requests (so a
// low-traffic agent loses the same state, just more slowly).
//
// The window therefore lives in the workspace's SQLite next to the other
// evolution ledgers (turn_outcomes, lessons, replay_evals — all created by
// EvolutionEngine's constructor, which owns this one too).
//
// One row is one completed turn with two independent lifetimes: it belongs to
// the open reflection window until that window closes, and — when a
// conversational follow-up that could grade it can still arrive — it waits for
// that follow-up. The row is dropped once both are done, so the table holds at
// most the open window plus one pending review.
//
// A window is CLAIMED for a session-evolution pass and settled only once that
// pass has run (`claim()` → `settle()`), never closed up front. That is what
// lets a host decline to wait for the pass: a `kinu exec` process that
// exits, or an interactive session the user quits mid-cycle, leaves its turns
// in the window for the next host that can afford the work — rather than
// consuming them for a pass that was killed halfway.

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { CompletedTurn } from './types';
import { JsonObjectSchema, JsonValueSchema, parseJsonValue } from '../utils/json';
import { UsageSchema } from '../usage';
import { diagnostics, toProteusError, tolerate } from '../obs/index';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';

export function initSessionWindowTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS session_window (
    id TEXT PRIMARY KEY,
    turn TEXT NOT NULL,
    in_window INTEGER NOT NULL,
    awaiting_review INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
}

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

/** How a completed turn enters the window. */
export interface AppendTurnOpts {
  /** Whether a conversational follow-up that could GRADE this turn can still
   *  arrive. Only then is the turn parked awaiting review. The caller decides:
   *  a programmatic turn has no user behind it, and a one-shot host's next
   *  invocation is an independent task, not a reply — parking either would
   *  hand the classifier a "follow-up" that is not one. */
  awaitsFollowup: boolean;
  /** Epoch ms to stamp the row with. Defaults to now. */
  now?: number;
}

export interface SessionWindowStore {
  /** Buffer a completed turn: it joins the open window, and — when a
   *  conversational follow-up can still grade it — additionally waits for
   *  that follow-up. */
  append(turn: CompletedTurn, opts: AppendTurnOpts): void;
  /** How many turns the open window holds. */
  size(): number;
  /** Claim the open window for one session-evolution pass, or null when it is
   *  empty. The caller settles it once the pass has run. */
  claim(): ClaimedWindow | null;
  /** Take the turn waiting to be graded, if one is waiting. */
  takePendingReview(): CompletedTurn | null;
}

interface WindowRow { id: string; turn: string; created_at: number }
/** The durable mirror of {@link CompletedTurn} — one schema for every table
 *  that stores a snapshotted turn (this window and the deferred-review queue),
 *  because two mirrors of one type drift and the drift shows up as a turn that
 *  silently will not decode. */
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

export function createSessionWindowStore(sql: SqlExecutor): SessionWindowStore {
  // A row whose two lifetimes are both over carries no information — dropping
  // it here keeps the table bounded by the open window plus one pending review.
  const dropSettled = (): void => {
    void sql`DELETE FROM session_window WHERE in_window = 0 AND awaiting_review = 0`;
  };
  const windowRows = (): WindowRow[] => sql<WindowRow>`
    SELECT id, turn, created_at FROM session_window
    WHERE in_window = 1 ORDER BY created_at ASC, rowid ASC`;

  return {
    append(turn, opts) {
      // A turn that cannot be serialized cannot be replayed to the engine
      // later, and losing the whole window to one bad tool result would be
      // worse than losing that turn — so a failed encode drops just this turn.
      let encoded: string;
      try {
        encoded = JSON.stringify(turn);
      } catch (err) {
        diagnostics.failure(
          'evolution.session_turn_unserializable',
          toProteusError({ doing: 'serialize a session-window turn', cause: err, otherwise: 'bad_input' }),
        );
        return;
      }
      const awaitingReview = opts.awaitsFollowup ? 1 : 0;
      // At most one turn waits at a time — the newest user message grades the
      // most recent turn, exactly as the in-memory field did.
      if (awaitingReview === 1) {
        void sql`UPDATE session_window SET awaiting_review = 0 WHERE awaiting_review = 1`;
        dropSettled();
      }
      void sql`INSERT INTO session_window (id, turn, in_window, awaiting_review, created_at)
          VALUES (${`win-${nanoid()}`}, ${encoded}, 1, ${awaitingReview}, ${opts.now ?? nowMs()})`;
    },

    size() {
      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM session_window WHERE in_window = 1`[0]?.n ?? 0;
    },

    claim() {
      const rows = windowRows();
      if (rows.length === 0) return null;
      return {
        turns: rows.map(decode).filter((t): t is CompletedTurn => t !== null),
        startedAt: rows[0]!.created_at,
        settle() {
          // Retire by claimed id, not by `in_window = 1`: a turn appended while
          // the pass ran belongs to the NEXT window, and an undecodable row
          // must still retire or it would wedge the window forever.
          for (const row of rows) {
            void sql`UPDATE session_window SET in_window = 0 WHERE id = ${row.id}`;
          }
          dropSettled();
        },
      };
    },

    takePendingReview() {
      const row = sql<WindowRow>`
        SELECT id, turn, created_at FROM session_window
        WHERE awaiting_review = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1`[0];
      if (!row) return null;
      void sql`UPDATE session_window SET awaiting_review = 0 WHERE id = ${row.id}`;
      dropSettled();
      return decode(row);
    },
  };
}

/** A row written by another version of this code is skipped, not fatal — the
 *  window is a buffer, and one unreadable turn must not stall the cadence. */
function decode(row: WindowRow): CompletedTurn | null {
  const parsed = v.safeParse(
    CompletedTurnSchema,
    tolerate(() => parseJsonValue(row.turn), 'malformed-input'),
  );
  return parsed.success ? parsed.output : null;
}
