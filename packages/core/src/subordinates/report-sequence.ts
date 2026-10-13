/**
 * An agent's sequence, in its own store, which numbers its reports to the workspace, and the newest report the
 * workspace took from each agent (design v3 B): a report delayed past a later one, or sent before either side reset,
 * changes nothing there. Its executions' openings are numbered by their claims' epochs (`actor_epochs`).
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

/** The workspace's side: the newest report it took from each agent, the standing that report carried, and whether its
 *  isolate holds owed work (`holds`), as that report said; and each steer it carried, a row each, as each came. */
export function initAgentReportsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_reports (
    actor_id      TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id),
    seq           INTEGER NOT NULL,
    standing_json TEXT NOT NULL,
    holds         INTEGER NOT NULL CHECK (holds IN (0, 1))
  )`);
  // A steer's text fit its own row where it was sent, and no row holds more than one, however many are pending.
  execRaw(`CREATE TABLE IF NOT EXISTS agent_report_steers (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id),
    ord      INTEGER NOT NULL,
    id       TEXT NOT NULL,
    text     TEXT NOT NULL,
    state    TEXT NOT NULL CHECK (state IN ('queued', 'landed')),
    at_step  INTEGER,
    PRIMARY KEY (actor_id, ord)
  )`);
}

const MeasureRowSchema = v.object({ tokens: v.number(), at: v.string(), seq: v.number() });

/** An {@link AgentStandingReport} as the workspace stored it, its steers aside. */
const StoredStandingSchema = v.object({
  messageCount: v.number(),
  measures: v.object({
    provider: v.nullable(MeasureRowSchema),
    gate: v.nullable(v.object({ tokens: v.nullable(v.number()), at: v.string(), seq: v.number(), contextWindow: v.nullable(v.number()) })),
  }),
  latestRun: v.nullable(v.object({ status: v.nullable(v.string()), userMessage: v.nullable(v.string()) })),
  plans: v.object({ pending: v.boolean(), revision: v.number() }),
  questions: v.number(),
});

/** An agent's newest report as the workspace took it: its standing, and whether its isolate holds owed work. */
export interface AcceptedReport {
  readonly standing: AgentStandingReport;
  readonly holds: boolean;
}

const SteerRowSchema = v.object({ id: v.string(), text: v.string(), state: v.picklist(['queued', 'landed']), at_step: v.nullable(v.number()) });

export class AgentReports {
  constructor(private readonly sql: SqlExecutor) {}

  /** Whether `seq` is newer than every report taken from the agent, recorded with what it carried if it is. */
  accept(actorId: string, seq: number, standing: AgentStandingReport, holds: boolean): boolean {
    const { pendingSteers, ...rest } = standing;

    const accepted = this.sql<{ seq: number }>`INSERT INTO agent_reports (actor_id, seq, standing_json, holds)
      VALUES (${actorId}, ${seq}, ${JSON.stringify(rest)}, ${holds ? 1 : 0})
      ON CONFLICT (actor_id) DO UPDATE SET seq = excluded.seq, standing_json = excluded.standing_json, holds = excluded.holds
      WHERE excluded.seq > agent_reports.seq RETURNING seq`.length > 0;

    if (!accepted) return false;
    void this.sql`DELETE FROM agent_report_steers WHERE actor_id = ${actorId}`;

    for (const [ord, steer] of pendingSteers.entries()) {
      void this.sql`INSERT INTO agent_report_steers (actor_id, ord, id, text, state, at_step)
        VALUES (${actorId}, ${ord}, ${steer.id}, ${steer.text}, ${steer.state}, ${steer.atStep})`;
    }

    return true;
  }

  /** What the agent last reported, as it reported it: none before its first report. A read of the workspace's own rows,
   *  so an activation that took no report yet never wakes the agent to learn it. */
  report(actorId: string): AcceptedReport | null {
    const stored = this.sql<{ standing_json: string; holds: number }>`SELECT standing_json, holds FROM agent_reports WHERE actor_id = ${actorId}`[0];

    if (stored === undefined) return null;

    const pendingSteers = this.sql`SELECT id, text, state, at_step FROM agent_report_steers WHERE actor_id = ${actorId} ORDER BY ord`
      .map((row) => v.parse(SteerRowSchema, row))
      .map((row) => ({ id: row.id, text: row.text, state: row.state, atStep: row.at_step }));

    return { standing: { ...v.parse(StoredStandingSchema, JSON.parse(stored.standing_json)), pendingSteers }, holds: stored.holds === 1 };
  }

  /** The agents whose own isolate holds owed work, as each last reported: a turn not settled, or an effect owed, parked
   *  ones included. A wake is when an agent next needs driving, and a parked effect needs none; this is whether it owes
   *  anything at all. */
  holding(): readonly string[] {
    return this.sql<{ actor_id: string }>`SELECT actor_id FROM agent_reports WHERE holds = 1 ORDER BY actor_id`.map((row) => row.actor_id);
  }

  /** A retired agent owes nothing here any more: whether it was holding work. */
  release(actorId: string): boolean {
    return this.sql`UPDATE agent_reports SET holds = 0 WHERE actor_id = ${actorId} AND holds = 1 RETURNING actor_id`.length > 0;
  }
}
