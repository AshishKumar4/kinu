/** Turns handed to an agent's own isolate with no end heard: after a reset, each agent named here is woken first. */
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

export function initAgentOpenTurnsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_open_turns (
    actor_id  TEXT NOT NULL REFERENCES workspace_actors(actor_id),
    turn_id   TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, turn_id)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS agent_wakes (
    actor_id TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id),
    wake_at  INTEGER NOT NULL
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

/** A facet sets no alarm, so its workspace keeps the instant. */
export class AgentWakes {
  constructor(private readonly sql: SqlExecutor) {}

  arm(actorId: string, atMs: number): void {
    void this.sql`INSERT INTO agent_wakes (actor_id, wake_at) VALUES (${actorId}, ${atMs})
      ON CONFLICT(actor_id) DO UPDATE SET wake_at = MIN(wake_at, excluded.wake_at)`;
  }

  takeDue(now: number): readonly string[] {
    return this.sql<{ actor_id: string }>`DELETE FROM agent_wakes WHERE wake_at <= ${now} RETURNING actor_id`.map((row) => row.actor_id);
  }

  next(): number | null {
    return this.sql<{ at: number | null }>`SELECT MIN(wake_at) AS at FROM agent_wakes`[0]?.at ?? null;
  }
}
