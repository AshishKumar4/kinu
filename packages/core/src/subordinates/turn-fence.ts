/**
 * The workspace's revocation watermark for an agent's turn (design v3 B): the newest epoch the agent opened it at, from
 * the agent's own claim on it; whether it ended or was cancelled; and the facts the workspace first offered its
 * preparation, kept until the agent's own copy is durable. Durable, so an opening refused before a reset of the
 * workspace is refused after it, and kept as a tombstone once the turn is over.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { TurnFactsSchema, type TurnFacts } from '../orchestrator/turn-facts';

export function initTurnFenceTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS actor_turn_fence (
    actor_id     TEXT NOT NULL REFERENCES workspace_actors(actor_id),
    turn_id      TEXT NOT NULL,
    epoch        INTEGER NOT NULL,
    ended_at     INTEGER,
    cancelled_at INTEGER,
    facts_json   TEXT,
    PRIMARY KEY (actor_id, turn_id)
  )`);
}

export class TurnFences {
  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Checked before anything is written: an opening of a turn that ended or was cancelled, or below the epoch it was last
   * opened at, is refused and changes nothing. One admitted raises the turn's epoch and ends the agent's other turns,
   * which open one at a time; their offers go, their agent having frozen its facts when they opened.
   */
  open(actorId: string, turnId: string, epoch: number): boolean {
    // The check is the write's own condition: a refused opening's upsert changes no row and returns none.
    const admitted = this.sql<{ epoch: number }>`INSERT INTO actor_turn_fence (actor_id, turn_id, epoch) VALUES (${actorId}, ${turnId}, ${epoch})
      ON CONFLICT (actor_id, turn_id) DO UPDATE SET epoch = excluded.epoch
      WHERE excluded.epoch >= actor_turn_fence.epoch AND actor_turn_fence.ended_at IS NULL AND actor_turn_fence.cancelled_at IS NULL
      RETURNING epoch`.length > 0;

    if (admitted) {
      void this.sql`UPDATE actor_turn_fence SET ended_at = ${Date.now()}, facts_json = NULL
        WHERE actor_id = ${actorId} AND turn_id <> ${turnId} AND ended_at IS NULL`;
    }

    return admitted;
  }

  /** The facts a preparation of the turn is offered: the first it was ever offered, however often it is prepared again,
   *  until its terminal sequence. A turn with no fence has no offer to keep. */
  offer(actorId: string, turnId: string, facts: TurnFacts): TurnFacts {
    const [offered] = this.sql<{ facts_json: string | null }>`UPDATE actor_turn_fence SET facts_json = COALESCE(facts_json, ${JSON.stringify(facts)})
      WHERE actor_id = ${actorId} AND turn_id = ${turnId} AND ended_at IS NULL RETURNING facts_json`;

    return offered?.facts_json == null ? facts : v.parse(TurnFactsSchema, JSON.parse(offered.facts_json));
  }

  /** With the turn's terminal sequence, its facts durable in the handoff: ended, and its offer gone. */
  settled(actorId: string, turnId: string): void {
    void this.sql`UPDATE actor_turn_fence SET ended_at = COALESCE(ended_at, ${Date.now()}), facts_json = NULL
      WHERE actor_id = ${actorId} AND turn_id = ${turnId}`;
  }
}
