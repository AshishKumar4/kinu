/**
 * The workspace's revocation watermark for an agent's turn (design v3 B): the newest epoch the agent opened it at, from
 * the agent's own claim on it, and whether it was cancelled. Durable, so an opening older than one taken is refused
 * after a reset of the workspace as before it.
 */
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

export function initTurnFenceTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS actor_turn_fence (
    actor_id     TEXT NOT NULL REFERENCES workspace_actors(actor_id),
    turn_id      TEXT NOT NULL,
    epoch        INTEGER NOT NULL,
    cancelled_at INTEGER,
    PRIMARY KEY (actor_id, turn_id)
  )`);
}

export class TurnFences {
  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Raises the turn's fence to `epoch` and answers true; answers false and writes nothing for an epoch below it or a
   * cancelled turn. An agent's turns open one at a time, so its other turns' fences go: they have ended.
   */
  open(actorId: string, turnId: string, epoch: number): boolean {
    void this.sql`DELETE FROM actor_turn_fence WHERE actor_id = ${actorId} AND turn_id <> ${turnId}`;

    return this.sql<{ epoch: number }>`INSERT INTO actor_turn_fence (actor_id, turn_id, epoch) VALUES (${actorId}, ${turnId}, ${epoch})
      ON CONFLICT (actor_id, turn_id) DO UPDATE SET epoch = excluded.epoch
      WHERE excluded.epoch >= actor_turn_fence.epoch AND actor_turn_fence.cancelled_at IS NULL RETURNING epoch`.length > 0;
  }
}
