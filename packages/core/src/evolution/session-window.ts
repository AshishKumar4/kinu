// SessionWindow — the durable evolution window and the turn awaiting its
// outcome review.
//
// Both used to be fields on the AgentOrchestrator instance. That works only
// while the instance outlives the turns it is counting, and neither backend
// guarantees that: `proteus exec` is one process per turn (so the N-turn
// cadence was unreachable and every turn was graded by the session-end
// constant), and a Durable Object is evicted between requests (so a
// low-traffic agent loses the same state, just more slowly).
//
// The window therefore lives in the workspace's SQLite next to the other
// evolution ledgers (turn_outcomes, lessons, replay_evals — all created by
// EvolutionEngine's constructor, which owns this one too).
//
// One row is one completed turn with two independent lifetimes: it belongs to
// the open reflection window until that window closes, and — for user-origin
// turns — it waits for the follow-up that grades it. The row is dropped once
// both are done, so the table holds at most the open window plus one pending
// review.

import type { SqlExecutor, RawSqlExec } from '../types/primitives.js';
import type { CompletedTurn } from './types.js';
import { nanoid } from '../utils/nanoid.js';
import { nowMs } from '../utils/date.js';

export function initSessionWindowTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS session_window (
    id TEXT PRIMARY KEY,
    turn TEXT NOT NULL,
    in_window INTEGER NOT NULL,
    awaiting_review INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
}

export interface SessionWindowStore {
  /** Buffer a completed turn: it joins the open window, and a user-origin
   *  turn additionally waits for the user's next message to grade it. */
  append(turn: CompletedTurn, now?: number): void;
  /** Turns in the open window, oldest first. */
  turns(): CompletedTurn[];
  /** How many turns the open window holds. */
  size(): number;
  /** Epoch ms the open window opened (its oldest turn), or null when empty. */
  startedAt(): number | null;
  /** Close the window: its turns, oldest first, removed from the window. */
  close(): CompletedTurn[];
  /** Take the turn waiting to be graded, if one is waiting. */
  takePendingReview(): CompletedTurn | null;
}

interface WindowRow { id: string; turn: string; created_at: number }

export function createSessionWindowStore(sql: SqlExecutor): SessionWindowStore {
  // A row whose two lifetimes are both over carries no information — dropping
  // it here keeps the table bounded by the open window plus one pending review.
  const dropSettled = (): void => {
    sql`DELETE FROM session_window WHERE in_window = 0 AND awaiting_review = 0`;
  };
  const windowRows = (): WindowRow[] => sql<WindowRow>`
    SELECT id, turn, created_at FROM session_window
    WHERE in_window = 1 ORDER BY created_at ASC, rowid ASC`;

  return {
    append(turn, now) {
      // A turn that cannot be serialized cannot be replayed to the engine
      // later, and losing the whole window to one bad tool result would be
      // worse than losing that turn — so a failed encode drops just this turn.
      let encoded: string;
      try {
        encoded = JSON.stringify(turn);
      } catch (err) {
        console.warn('[proteus] session window: turn could not be serialized:', (err as Error).message);
        return;
      }
      // Only a user-origin turn has a follow-up coming; a programmatic turn
      // (reactor, job wake) is reviewed the moment it completes.
      const awaitingReview = turn.origin === 'programmatic' ? 0 : 1;
      // At most one turn waits at a time — the newest user message grades the
      // most recent turn, exactly as the in-memory field did.
      if (awaitingReview === 1) {
        sql`UPDATE session_window SET awaiting_review = 0 WHERE awaiting_review = 1`;
        dropSettled();
      }
      sql`INSERT INTO session_window (id, turn, in_window, awaiting_review, created_at)
          VALUES (${`win-${nanoid()}`}, ${encoded}, 1, ${awaitingReview}, ${now ?? nowMs()})`;
    },

    turns() {
      return windowRows().map(decode).filter((t): t is CompletedTurn => t !== null);
    },

    size() {
      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM session_window WHERE in_window = 1`[0]?.n ?? 0;
    },

    startedAt() {
      const row = sql<{ at: number | null }>`
        SELECT MIN(created_at) AS at FROM session_window WHERE in_window = 1`[0];
      return row?.at ?? null;
    },

    close() {
      const rows = windowRows();
      if (rows.length === 0) return [];
      sql`UPDATE session_window SET in_window = 0 WHERE in_window = 1`;
      dropSettled();
      return rows.map(decode).filter((t): t is CompletedTurn => t !== null);
    },

    takePendingReview() {
      const row = sql<WindowRow>`
        SELECT id, turn, created_at FROM session_window
        WHERE awaiting_review = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1`[0];
      if (!row) return null;
      sql`UPDATE session_window SET awaiting_review = 0 WHERE id = ${row.id}`;
      dropSettled();
      return decode(row);
    },
  };
}

/** A row written by another version of this code is skipped, not fatal — the
 *  window is a buffer, and one unreadable turn must not stall the cadence. */
function decode(row: WindowRow): CompletedTurn | null {
  try {
    const parsed = JSON.parse(row.turn) as CompletedTurn;
    return typeof parsed?.userMessage === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
