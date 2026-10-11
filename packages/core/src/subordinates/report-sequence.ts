/**
 * An agent's sequence, in its own store, which numbers its reports and its turns' openings to the workspace, and the
 * newest report the workspace took from each agent (design v3 B): a report delayed past a later one, or sent before
 * either side reset, changes nothing there.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { AgentStandingReport } from './agent-isolate';

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

/** The workspace's side: the newest report it took from each agent, and the standing that report carried. */
export function initAgentReportsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_reports (
    actor_id      TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id),
    seq           INTEGER NOT NULL,
    standing_json TEXT NOT NULL
  )`);
}

const MeasureRowSchema = v.object({ tokens: v.number(), at: v.string(), seq: v.number() });

/** An {@link AgentStandingReport} as the workspace stored it. */
const AgentStandingReportSchema = v.object({
  messageCount: v.number(),
  measures: v.object({
    provider: v.nullable(MeasureRowSchema),
    gate: v.nullable(v.object({ tokens: v.nullable(v.number()), at: v.string(), seq: v.number(), contextWindow: v.nullable(v.number()) })),
  }),
  latestRun: v.nullable(v.object({ status: v.nullable(v.string()), userMessage: v.nullable(v.string()) })),
  pendingSteers: v.array(v.object({ id: v.string(), text: v.string(), state: v.picklist(['queued', 'landed']), atStep: v.nullable(v.number()) })),
});

export class AgentReports {
  constructor(private readonly sql: SqlExecutor) {}

  /** Whether `seq` is newer than every report taken from the agent, recorded with the standing it carried if it is. */
  accept(actorId: string, seq: number, standing: AgentStandingReport): boolean {
    return this.sql<{ seq: number }>`INSERT INTO agent_reports (actor_id, seq, standing_json) VALUES (${actorId}, ${seq}, ${JSON.stringify(standing)})
      ON CONFLICT (actor_id) DO UPDATE SET seq = excluded.seq, standing_json = excluded.standing_json
      WHERE excluded.seq > agent_reports.seq RETURNING seq`.length > 0;
  }

  /** The standing the agent last reported, as it reported it: none before its first report. A read of the workspace's own
   *  rows, so an activation that took no report yet never wakes the agent to learn it. */
  standing(actorId: string): AgentStandingReport | null {
    const stored = this.sql<{ standing_json: string }>`SELECT standing_json FROM agent_reports WHERE actor_id = ${actorId}`[0]?.standing_json;

    return stored === undefined ? null : v.parse(AgentStandingReportSchema, JSON.parse(stored));
  }
}
