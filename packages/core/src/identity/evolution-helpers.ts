/** Task agents an evolution lane started; a row is the spawner fact and the lane's durable inbox. */

import * as v from 'valibot';
import type { SqlExec } from '../types/primitives';
import type { ActorHandle } from './actor-handle';

export type EvolutionLane = 'refinement';

export interface EvolutionLaneRequest {
  readonly lane: EvolutionLane;
  readonly requestId: string;
}

export type EvolutionAnswerStatus = 'completed' | 'blocked';

export type EvolutionHelperAnswer =
  | { readonly state: 'answered'; readonly name: string; readonly status: EvolutionAnswerStatus; readonly answer: string }
  | { readonly state: 'running'; readonly name: string };

export function initEvolutionHelperTable(sql: SqlExec): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS evolution_helpers (
    actor_id        TEXT NOT NULL,
    name            TEXT NOT NULL,
    lane            TEXT NOT NULL CHECK (lane IN ('refinement')),
    lane_request_id TEXT NOT NULL,
    -- The assignment the answer settles (the helper's subordinate_task event id); null until it answers.
    task_event_id   TEXT,
    answer_status   TEXT CHECK (answer_status IN ('completed','blocked')),
    answer          TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (actor_id, name)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_evolution_helpers_request
    ON evolution_helpers(actor_id, lane, lane_request_id, created_at)`);
}

const HelperRowSchema = v.object({
  name: v.string(),
  answer_status: v.nullable(v.picklist(['completed', 'blocked'])),
  answer: v.nullable(v.string()),
});

export class EvolutionHelperStore {
  private readonly actorId: string;

  constructor(private readonly sql: SqlExec, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  record(name: string, request: EvolutionLaneRequest, now: number): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `INSERT INTO evolution_helpers (actor_id, name, lane, lane_request_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      this.actorId, name, request.lane, request.requestId, now,
    );
  }

  has(name: string): boolean {
    this.actor.assertCurrent();

    return this.sql.exec(
      `SELECT 1 FROM evolution_helpers WHERE actor_id = ? AND name = ? LIMIT 1`, this.actorId, name,
    ).toArray().length > 0;
  }

  /** First answer wins. */
  storeAnswer(name: string, taskEventId: string | null, status: EvolutionAnswerStatus, answer: string): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `UPDATE evolution_helpers SET task_event_id = ?, answer_status = ?, answer = ?
       WHERE actor_id = ? AND name = ? AND answer_status IS NULL`,
      taskEventId, status, answer, this.actorId, name,
    );
  }

  answerFor(request: EvolutionLaneRequest): EvolutionHelperAnswer | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT h.name, h.answer_status, h.answer FROM evolution_helpers h
       LEFT JOIN actor_subordinates s ON s.actor_id = h.actor_id AND s.name = h.name
       WHERE h.actor_id = ? AND h.lane = ? AND h.lane_request_id = ?
         AND (h.answer_status IS NOT NULL OR s.status != 'dismissed')
       ORDER BY h.answer_status IS NULL, h.created_at DESC, h.name DESC LIMIT 1`,
      this.actorId, request.lane, request.requestId,
    ).toArray().map((row) => v.parse(HelperRowSchema, row));

    const row = rows[0];

    if (!row) return null;

    if (row.answer_status === null || row.answer === null) return { state: 'running', name: row.name };

    return { state: 'answered', name: row.name, status: row.answer_status, answer: row.answer };
  }

  remove(name: string): void {
    this.actor.assertCurrent();
    this.sql.exec(`DELETE FROM evolution_helpers WHERE actor_id = ? AND name = ?`, this.actorId, name);
  }
}
