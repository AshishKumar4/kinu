/**
 * An agent's sequence, in its own store, which numbers its reports and its turns' openings to the workspace, and the
 * newest report the workspace took from each agent (design v3 B): a report delayed past a later one, or sent before
 * either side reset, changes nothing there.
 */
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

/** The agent's side: one counter, in its own store, which a restart of its isolate continues. */
export function initAgentSequenceTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_sequence (
    actor_id TEXT PRIMARY KEY,
    seq      INTEGER NOT NULL
  )`);
}

export class AgentSequence {
  constructor(private readonly sql: SqlExecutor, private readonly actorId: string) {}

  /** The next number, committed as it is taken. */
  next(): number {
    const [row] = this.sql<{ seq: number }>`INSERT INTO agent_sequence (actor_id, seq) VALUES (${this.actorId}, 1)
      ON CONFLICT (actor_id) DO UPDATE SET seq = seq + 1 RETURNING seq`;

    return row?.seq ?? 1;
  }
}

/** The workspace's side: the newest report it took from each agent. */
export function initAgentReportsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_reports (
    actor_id TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id),
    seq      INTEGER NOT NULL
  )`);
}

export class AgentReports {
  constructor(private readonly sql: SqlExecutor) {}

  /** Whether `seq` is newer than every report taken from the agent, recorded if it is. */
  accept(actorId: string, seq: number): boolean {
    return this.sql<{ seq: number }>`INSERT INTO agent_reports (actor_id, seq) VALUES (${actorId}, ${seq})
      ON CONFLICT (actor_id) DO UPDATE SET seq = excluded.seq WHERE excluded.seq > agent_reports.seq RETURNING seq`.length > 0;
  }
}
