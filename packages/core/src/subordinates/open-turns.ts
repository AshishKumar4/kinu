/**
 * The delegated turns the workspace handed to an agent's own isolate and has not heard end. The agent's turn claim
 * is in the agent's own database, so this row is the workspace's only record that the agent may owe a recovery:
 * an activation after a reset wakes each agent named here, before any turn is delivered again.
 */
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

export function initAgentOpenTurnsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_open_turns (
    actor_id  TEXT NOT NULL REFERENCES workspace_actors(actor_id),
    turn_id   TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, turn_id)
  )`);
}

export interface AgentOpenTurn {
  readonly actorId: string;
  readonly turnId: string;
}

export class AgentOpenTurns {
  constructor(private readonly sql: SqlExecutor) {}

  open(turn: AgentOpenTurn, now: number): void {
    void this.sql`INSERT OR IGNORE INTO agent_open_turns (actor_id, turn_id, opened_at) VALUES (${turn.actorId}, ${turn.turnId}, ${now})`;
  }

  close(turn: AgentOpenTurn): void {
    void this.sql`DELETE FROM agent_open_turns WHERE actor_id = ${turn.actorId} AND turn_id = ${turn.turnId}`;
  }

  /** Opened before `before`: an earlier activation handed them out, and no end reached this one. */
  openedBefore(before: number): readonly AgentOpenTurn[] {
    return this.sql<{ actor_id: string; turn_id: string }>`
      SELECT actor_id, turn_id FROM agent_open_turns WHERE opened_at < ${before} ORDER BY opened_at`
      .map((row) => ({ actorId: row.actor_id, turnId: row.turn_id }));
  }
}
