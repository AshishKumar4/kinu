import * as v from 'valibot';
import { tableExists } from '../identity/schema';
import { boundedInt } from '../utils/bounds';
import { seekPage, StaleCursorError, type PageRequest } from '../read-models/page';
import type { SqlExec, SqlExecutor, SqlExecRow } from '../types/primitives';
import { SubordinateRosterStore, SubordinateRosterEntrySchema } from './roster';

const historicalRow = v.object({
  name: v.string(), createdBy: v.picklist(['orchestrator', 'user']), status: v.picklist(['idle', 'working', 'awaiting_input', 'dismissed']),
  currentTask: v.nullable(v.string()), createdAt: v.number(), dismissedAt: v.nullable(v.number()),
  lifetime: v.picklist(['durable', 'task']), taskEventId: v.nullable(v.string()),
});

function projectHistoricalRow(row: SqlExecRow) {
  const stored = v.parse(historicalRow, row);
  return v.parse(SubordinateRosterEntrySchema, { ...stored, actorReference: null, birth: null, deleteRequested: false });
}

/** Frozen deployed schema. This reader cannot register, mutate or execute an actor. */
class HistoricalSubordinateRoster {
  constructor(private readonly sql: SqlExecutor) {}

  get(name: string) {
    const row = this.sql<SqlExecRow>`SELECT name, created_by AS createdBy, status, current_task AS currentTask,
      created_at AS createdAt, dismissed_at AS dismissedAt, lifetime, task_event_id AS taskEventId
      FROM workspace_subordinates WHERE name = ${name}`[0];
    return row ? projectHistoricalRow(row) : null;
  }

  listPage(request: PageRequest) {
    const limit = boundedInt(request.limit, 50, 1, 200);
    const after = request.cursor?.after;
    const anchor = after === undefined ? null : this.get(after);
    if (after !== undefined && !anchor) throw new StaleCursorError('historical subordinate roster', after);
    const rows = anchor
      ? this.sql<SqlExecRow>`SELECT name, created_by AS createdBy, status, current_task AS currentTask,
          created_at AS createdAt, dismissed_at AS dismissedAt, lifetime, task_event_id AS taskEventId
          FROM workspace_subordinates WHERE created_at > ${anchor.createdAt} OR (created_at = ${anchor.createdAt} AND name > ${anchor.name})
          ORDER BY created_at, name LIMIT ${limit + 1}`
      : this.sql<SqlExecRow>`SELECT name, created_by AS createdBy, status, current_task AS currentTask,
          created_at AS createdAt, dismissed_at AS dismissedAt, lifetime, task_event_id AS taskEventId
          FROM workspace_subordinates ORDER BY created_at, name LIMIT ${limit + 1}`;
    return seekPage(rows.map(projectHistoricalRow), limit, (row) => row.name);
  }
}

/** Select a preservation reader from durable identity, never from missing live columns. */
export function subordinateInspectionRoster(sql: SqlExecutor, raw: SqlExec): Pick<SubordinateRosterStore, 'get' | 'listPage'> | null {
  const registeredRoot = tableExists(sql, 'workspace_actors') && sql`SELECT actor_id FROM workspace_actors WHERE parent_actor_id IS NULL LIMIT 1`.length > 0;
  const registeredFacet = tableExists(sql, 'actor_identity') && sql`SELECT actor_reference FROM actor_identity WHERE actor_reference IS NOT NULL LIMIT 1`.length > 0;
  if (registeredRoot || registeredFacet) return tableExists(sql, 'actor_subordinates') ? new SubordinateRosterStore(raw) : null;
  return tableExists(sql, 'workspace_subordinates') ? new HistoricalSubordinateRoster(sql) : null;
}
