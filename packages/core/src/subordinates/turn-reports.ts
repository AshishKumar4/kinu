/**
 * What each hired turn has told its hirer, kept as its reports land: only ever more. A recovery reads it, so a turn whose
 * report already answered its assignment is settled, never run a second time.
 */
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { SubordinateReportLedger } from './ingress';

export function initTurnReportTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_turn_reports (
    actor_id TEXT NOT NULL,
    turn_id  TEXT NOT NULL,
    spoke    INTEGER NOT NULL,
    settled  INTEGER NOT NULL,
    PRIMARY KEY (actor_id, turn_id)
  )`);
}

/** A turn, as the claim that admitted it names it. */
export interface ReportedTurn {
  readonly actorId: string;
  readonly turnId: string;
}

export class TurnReports {
  constructor(private readonly sql: SqlExecutor) {}

  record(turn: ReportedTurn, reports: SubordinateReportLedger): void {
    if (!reports.spoke) return;
    void this.sql`INSERT INTO agent_turn_reports (actor_id, turn_id, spoke, settled)
      VALUES (${turn.actorId}, ${turn.turnId}, 1, ${reports.settled ? 1 : 0})
      ON CONFLICT(actor_id, turn_id) DO UPDATE SET spoke = 1, settled = MAX(settled, excluded.settled)`;
  }

  read(turn: ReportedTurn): SubordinateReportLedger {
    const row = this.sql<{ settled: number }>`
      SELECT settled FROM agent_turn_reports WHERE actor_id = ${turn.actorId} AND turn_id = ${turn.turnId}`[0];

    return row === undefined ? { spoke: false, settled: false } : { spoke: true, settled: row.settled === 1 };
  }

  /** Whether the turn's report already answered its assignment: a run-settling report reached its hirer. */
  answered(turn: ReportedTurn): boolean {
    return this.read(turn).settled;
  }
}
