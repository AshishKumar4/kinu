/** Task agents an earlier build's evolution lanes started. No lane hires one now; the rows it left say which of an actor's
 *  hires answer no one, so their reports never wake their hirer. The table goes with the next reset of the schema. */

import type { SqlExec } from '../types/primitives';
import type { ActorHandle } from './actor-handle';

export function initEvolutionSubagentTable(sql: SqlExec): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS evolution_subagents (
    actor_id        TEXT NOT NULL,
    name            TEXT NOT NULL,
    lane_request_id TEXT NOT NULL,
    answer_status   TEXT CHECK (answer_status IN ('completed','blocked')),
    answer          TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (actor_id, name)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_evolution_subagents_request
    ON evolution_subagents(actor_id, lane_request_id, created_at)`);
}

export class EvolutionSubagentStore {
  private readonly actorId: string;

  constructor(private readonly sql: SqlExec, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  has(name: string): boolean {
    this.actor.assertCurrent();

    return this.sql.exec(
      `SELECT 1 FROM evolution_subagents WHERE actor_id = ? AND name = ? LIMIT 1`, this.actorId, name,
    ).toArray().length > 0;
  }

  remove(name: string): void {
    this.actor.assertCurrent();
    this.sql.exec(`DELETE FROM evolution_subagents WHERE actor_id = ? AND name = ?`, this.actorId, name);
  }
}
