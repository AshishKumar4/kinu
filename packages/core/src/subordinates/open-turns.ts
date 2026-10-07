/** Turns handed to an agent's own isolate with no end heard: after a reset, each agent named here is woken first. And
 *  the agents whose own isolate holds owed work, as each last told it: who the work read asks. */
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

export function initAgentOpenTurnsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_open_turns (
    actor_id  TEXT NOT NULL REFERENCES workspace_actors(actor_id),
    turn_id   TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, turn_id)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS agent_owed_work (
    actor_id TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id)
  )`);
}

/**
 * Which agents hold owed work in their own isolate: a turn not settled, or an effect owed, parked ones included. An
 * agent's wake is when it next needs driving, and a parked effect needs none; this is whether it owes anything at all.
 */
export class AgentOwedWork {
  constructor(private readonly sql: SqlExecutor) {}

  /** The agent's own answer, replacing what it said before. */
  held(actorId: string, holds: boolean): void {
    if (holds) void this.sql`INSERT OR IGNORE INTO agent_owed_work (actor_id) VALUES (${actorId})`;
    else void this.sql`DELETE FROM agent_owed_work WHERE actor_id = ${actorId}`;
  }

  all(): readonly string[] {
    return this.sql<{ actor_id: string }>`SELECT actor_id FROM agent_owed_work ORDER BY actor_id`.map((row) => row.actor_id);
  }
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

  /** Every turn out at an agent's own isolate whose end has not reached this workspace, oldest first. */
  all(): readonly AgentOpenTurn[] {
    return this.sql<{ actor_id: string; turn_id: string }>`SELECT actor_id, turn_id FROM agent_open_turns ORDER BY opened_at`
      .map((row) => ({ actorId: row.actor_id, turnId: row.turn_id }));
  }

  /** Opened before `before`: an earlier activation handed them out, and no end reached this one. */
  openedBefore(before: number): readonly AgentOpenTurn[] {
    return this.sql<{ actor_id: string; turn_id: string }>`
      SELECT actor_id, turn_id FROM agent_open_turns WHERE opened_at < ${before} ORDER BY opened_at`
      .map((row) => ({ actorId: row.actor_id, turnId: row.turn_id }));
  }
}
