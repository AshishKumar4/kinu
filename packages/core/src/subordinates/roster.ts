/**
 * THE SUBORDINATE ROSTER — the parent's own record of who works for it.
 *
 * ONE table, `workspace_subordinates`, and one place its status policy lives, so
 * the tools, the report ingress, the per-step snapshot and the operator surfaces
 * cannot drift from each other. Split out of `support.ts` because it is the
 * STORE and that module is the POLICY over it: an actor's orchestration reads
 * this, and this reads nothing back.
 *
 * Every lifetime lives here. A durable `hire` and the temporary agent a
 * role-targeted `ask` creates are rows in the SAME roster, distinguished by the
 * one column neither can derive (`lifetime`), because "who works here" is one
 * question and two registers would have been two answers to it.
 */

import * as v from 'valibot';
import type { SqlExec, SqlExecutor } from '../types/primitives';
import { reconcileColumns } from '../identity/columns';
import type { SubordinateReportStatus } from '../events/hub/types';
import type { SubordinateReportOrigin } from './support';
import type { SubordinateRosterEntry, SubordinateStatus } from '../tools/agents-tool';
import { SUBORDINATE_LIFETIMES, TEMPORARY_LIFETIME, temporaryRunSettles } from './temporary';

const ROSTER_COLUMNS =
  'name, created_by, status, current_task, created_at, dismissed_at, lifetime, task_event_id';
const ROSTER_PROJECTION =
  'name, created_by AS createdBy, status, current_task AS currentTask, '
  + 'created_at AS createdAt, dismissed_at AS dismissedAt, '
  + 'lifetime, task_event_id AS taskEventId';

/** The two roster columns nothing else can derive.
 *
 *  `lifetime` is a DECISION the creating call made and no later state recovers:
 *  a task-lifetime row and a durable row with an open assignment are the same
 *  shape, and only one of them is released when it answers.
 *
 *  `task_event_id` is the EventLog's own id for the assignment this row is
 *  working on — issued by admission, so it cannot be computed here — and it is
 *  what correlates the eventual report with the thing that was asked. It is the
 *  same id the sender is handed as `SubordinateHandoff.eventId`, which is what
 *  makes the correlation the one already documented on this surface rather than
 *  a second scheme beside it.
 *
 *  Both carry constant defaults, so a workspace created before this rung reads
 *  as what it is: every existing row is `durable` with no open assignment id. */
const ROSTER_ADDED_COLUMNS = {
  lifetime: "TEXT NOT NULL DEFAULT 'durable'",
  task_event_id: 'TEXT',
} as const;

/** Lifecycle and task facts only — the title and role a subordinate presents
 *  live in ITS agent_config ({@link SubordinateDescriptorSource}), never here. */
const RosterEntrySchema: v.GenericSchema<SubordinateRosterEntry> = v.object({
  name: v.string(),
  createdBy: v.picklist(['orchestrator', 'user']),
  status: v.picklist(['idle', 'working', 'awaiting_input', 'dismissed']),
  currentTask: v.nullable(v.string()),
  createdAt: v.number(),
  dismissedAt: v.nullable(v.number()),
  lifetime: v.picklist(SUBORDINATE_LIFETIMES),
  taskEventId: v.nullable(v.string()),
});

function parseStoredRosterRow<T>(row: T): SubordinateRosterEntry {
  const parsed = v.safeParse(RosterEntrySchema, row);
  if (!parsed.success) throw new Error('Stored subordinate roster row is malformed.');
  return parsed.output;
}

/** Parent-DO product roster. All status policy lives here so tools, report
 * ingress, snapshots, and the future UI cannot drift. */
export class SubordinateRosterStore {
  /** `tagged` is the same storage as `sql` in the tagged-template form
   *  {@link reconcileColumns} needs, for the same reason
   *  {@link SubordinateIdentityStore} takes it: this table has gained columns,
   *  and IF NOT EXISTS is a no-op on a workspace that already had it. */
  constructor(private readonly sql: SqlExec, private readonly tagged: SqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_subordinates (
      name          TEXT PRIMARY KEY,
      created_by    TEXT NOT NULL CHECK (created_by IN ('orchestrator','user')),
      status        TEXT NOT NULL CHECK (status IN ('idle','working','awaiting_input','dismissed')),
      current_task  TEXT,
      created_at    INTEGER NOT NULL,
      dismissed_at INTEGER,
      lifetime      TEXT NOT NULL DEFAULT 'durable' CHECK (lifetime IN ('durable','task')),
      task_event_id TEXT
    )`);
    reconcileColumns(
      this.tagged, (ddl) => { this.sql.exec(ddl); },
      'workspace_subordinates', ROSTER_ADDED_COLUMNS,
    );
  }

  create(entry: SubordinateRosterEntry): void {
    this.sql.exec(
      `INSERT INTO workspace_subordinates (${ROSTER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.name,
      entry.createdBy,
      entry.status,
      entry.currentTask,
      entry.createdAt,
      entry.dismissedAt,
      entry.lifetime,
      entry.taskEventId,
    );
  }

  /** Exact upsert used only for compensating a failed facet operation. */
  restore(entry: SubordinateRosterEntry): void {
    this.sql.exec(
      `INSERT INTO workspace_subordinates (${ROSTER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         created_by = excluded.created_by,
         status = excluded.status,
         current_task = excluded.current_task,
         created_at = excluded.created_at,
         dismissed_at = excluded.dismissed_at,
         lifetime = excluded.lifetime,
         task_event_id = excluded.task_event_id`,
      entry.name,
      entry.createdBy,
      entry.status,
      entry.currentTask,
      entry.createdAt,
      entry.dismissedAt,
      entry.lifetime,
      entry.taskEventId,
    );
  }

  remove(name: string): void {
    this.sql.exec(`DELETE FROM workspace_subordinates WHERE name = ?`, name);
  }

  get(name: string): SubordinateRosterEntry | null {
    const rows = this.sql.exec(
      `SELECT ${ROSTER_PROJECTION} FROM workspace_subordinates WHERE name = ?`,
      name,
    ).toArray();
    return rows.length === 0 ? null : parseStoredRosterRow(rows[0]);
  }

  requireExisting(name: string): SubordinateRosterEntry {
    const entry = this.get(name);
    if (!entry) throw new Error(`unknown subordinate "${name}"`);
    return entry;
  }

  requireActive(name: string): SubordinateRosterEntry {
    const entry = this.requireExisting(name);
    if (entry.status === 'dismissed') throw new Error(`subordinate "${name}" is dismissed`);
    return entry;
  }

  list(): SubordinateRosterEntry[] {
    return this.sql.exec(
      `SELECT ${ROSTER_PROJECTION} FROM workspace_subordinates
       WHERE status != 'dismissed' ORDER BY created_at, name`,
    ).toArray().map(parseStoredRosterRow);
  }

  listAll(): SubordinateRosterEntry[] {
    return this.sql.exec(
      `SELECT ${ROSTER_PROJECTION} FROM workspace_subordinates ORDER BY created_at, name`,
    ).toArray().map(parseStoredRosterRow);
  }

  /** Open an assignment on this row. `eventId` is the EventLog id the eventual
   *  report cites; it lands here in a SECOND write because admission issues it
   *  and admission happens after the roster transition it compensates. */
  assign(name: string, task: string): void {
    this.requireActive(name);
    this.sql.exec(
      `UPDATE workspace_subordinates
       SET status = 'working', current_task = ?, task_event_id = NULL, dismissed_at = NULL
       WHERE name = ?`,
      task,
      name,
    );
  }

  /** Record which admitted event this row's open assignment IS. */
  recordAssignmentEvent(name: string, eventId: string): void {
    this.sql.exec(
      `UPDATE workspace_subordinates SET task_event_id = ? WHERE name = ?`,
      eventId,
      name,
    );
  }

  resumeAfterMessage(name: string): void {
    const entry = this.requireActive(name);
    if (entry.status !== 'awaiting_input') return;
    this.sql.exec(
      `UPDATE workspace_subordinates SET status = 'working' WHERE name = ?`,
      name,
    );
  }

  /**
   * Move a row on its child's own word.
   *
   * `origin` and `now` are what a TASK-lifetime row needs and a durable one
   * ignores. A temporary agent exists for one answer, so the report that IS its
   * answer ends it — and when that report arrives with nobody waiting on it (the
   * asking activation was evicted, so the answer became an ordinary event rather
   * than a return value) this is the ONLY thing that still runs. Without the
   * release here that row stayed listed as a live helper forever: addressable by
   * name, never retired, and contradicting the lifetime that created it.
   *
   * A durable subordinate is untouched by this: `completed` still takes it to
   * idle and `blocked` to awaiting_input, because it is meant to stay.
   */
  applyReport(
    name: string,
    status: SubordinateReportStatus,
    origin: SubordinateReportOrigin,
    now: number,
  ): void {
    const entry = this.requireActive(name);
    // The SAME predicate the port settles on, so the two paths cannot disagree
    // about which report was the answer.
    if (entry.lifetime === TEMPORARY_LIFETIME && temporaryRunSettles({ status, origin })) {
      this.dismiss(name, now);
      return;
    }
    const rosterStatus: SubordinateStatus = status === 'completed'
      ? 'idle'
      : status === 'blocked'
        ? 'awaiting_input'
        : entry.currentTask
          ? 'working'
          : 'idle';
    this.sql.exec(
      `UPDATE workspace_subordinates
       SET status = ?,
           current_task = CASE WHEN ? = 'completed' THEN NULL ELSE current_task END,
           task_event_id = CASE WHEN ? = 'completed' THEN NULL ELSE task_event_id END
       WHERE name = ?`,
      rosterStatus,
      status,
      status,
      name,
    );
  }

  dismiss(name: string, now: number): void {
    this.requireExisting(name);
    this.sql.exec(
      `UPDATE workspace_subordinates
       SET status = 'dismissed', current_task = NULL, task_event_id = NULL,
           dismissed_at = COALESCE(dismissed_at, ?)
       WHERE name = ?`,
      now,
      name,
    );
  }
}
