/**
 * The subordinate roster (`actor_subordinates`): the parent's record of who works for it.
 * Durable and task-lifetime helpers share the table, distinguished by `lifetime`.
 */

import * as v from 'valibot';
import type { SqlExec, SqlExecRow } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { seekPage, StaleCursorError, type Page, type PageRequest } from '../session/page';
import { boundedInt } from '../utils/bounds';
import type { SubordinateReportStatus } from '../events/hub/types';
import type { SubordinateReportOrigin } from './support';
import type { SubordinateRosterEntry, SubordinateStatus } from '../delegation/agents-tool';
import { SUBORDINATE_LIFETIMES, TEMPORARY_LIFETIME, temporaryRunSettles } from './temporary';
import { ActorReferenceSchema, sameActorReference, type ActorReference } from '../identity/actor-handle';
import { SubordinateBirthSchema } from './birth';
import { parseJsonValue } from '../utils/json';
import { KinuError } from '../obs/error';

const ROSTER_COLUMNS =
  'actor_id, name, created_by, status, current_task, created_at, dismissed_at, lifetime, task_event_id, actor_reference, birth_request, delete_requested';

const ROSTER_PROJECTION =
  'name, created_by AS createdBy, status, current_task AS currentTask, '
  + 'created_at AS createdAt, dismissed_at AS dismissedAt, '
  + 'lifetime, task_event_id AS taskEventId, actor_reference AS actorReference, birth_request AS birth, delete_requested AS deleteRequested';

/** Every column a compensating restore overwrites, except the conflict key. */
const ROSTER_RESTORE_CONFLICT = `
       ON CONFLICT(actor_id, name) DO UPDATE SET
         created_by = excluded.created_by,
         status = excluded.status,
         current_task = excluded.current_task,
         created_at = excluded.created_at,
         dismissed_at = excluded.dismissed_at,
         lifetime = excluded.lifetime,
         task_event_id = excluded.task_event_id,
         actor_reference = excluded.actor_reference, birth_request = excluded.birth_request, delete_requested = excluded.delete_requested`;

/** Roster columns nothing else can derive: `lifetime` (whether an answer releases the row)
 *  and `task_event_id` (the EventLog id the report cites, as in `SubordinateHandoff.eventId`). */

/** Lifecycle and task facts only; title and role live in the child's actor_config. */
export const SubordinateRosterEntrySchema = v.object({
  name: v.string(),
  actorReference: v.nullable(ActorReferenceSchema),
  birth: v.nullable(SubordinateBirthSchema),
  deleteRequested: v.boolean(),
  createdBy: v.picklist(['orchestrator', 'user']),
  status: v.picklist(['idle', 'working', 'awaiting_input', 'dismissed']),
  currentTask: v.nullable(v.string()),
  createdAt: v.number(),
  dismissedAt: v.nullable(v.number()),
  lifetime: v.picklist(SUBORDINATE_LIFETIMES),
  taskEventId: v.nullable(v.string()),
}) satisfies v.GenericSchema<SubordinateRosterEntry>;

const StoredRosterEntrySchema = v.object({
  ...SubordinateRosterEntrySchema.entries, actorReference: v.nullable(v.string()), birth: v.nullable(v.string()),
  deleteRequested: v.pipe(v.union([v.literal(0), v.literal(1)]), v.transform((value) => value === 1)),
});

function parseStoredRosterRow(row: SqlExecRow): SubordinateRosterEntry {
  try {
    const stored = v.parse(StoredRosterEntrySchema, row);

    return v.parse(SubordinateRosterEntrySchema, {
      ...stored, actorReference: stored.actorReference === null ? null : parseJsonValue(stored.actorReference),
      birth: stored.birth === null ? null : parseJsonValue(stored.birth),
    });
  } catch (cause) {
    throw new KinuError('io', 'Stored subordinate roster data is malformed.', { cause });
  }
}

/** Where a row lands on its child's own word: an answer idles it, a block waits
 *  on the operator, and anything else keeps the open assignment it still has. */
function reportedRosterStatus(status: SubordinateReportStatus, currentTask: string | null): SubordinateStatus {
  if (status === 'completed') return 'idle';

  if (status === 'blocked') return 'awaiting_input';

  return currentTask === null || currentTask === '' ? 'idle' : 'working';
}

/** Parent-actor roster; owns all subordinate status policy. */
export class SubordinateRosterStore {
  private readonly actorId: string;

  /** Scoped to one parent actor: subordinate names are unique only per parent. */
  constructor(private readonly sql: SqlExec, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  ensureSchema(): void {
    this.actor.assertCurrent();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS actor_subordinates (
      actor_id      TEXT NOT NULL,
      name          TEXT NOT NULL,
      created_by    TEXT NOT NULL CHECK (created_by IN ('orchestrator','user')),
      status        TEXT NOT NULL CHECK (status IN ('idle','working','awaiting_input','dismissed')),
      current_task  TEXT,
      created_at    INTEGER NOT NULL,
      dismissed_at INTEGER,
      lifetime      TEXT NOT NULL DEFAULT 'durable' CHECK (lifetime IN ('durable','task')),
      task_event_id TEXT,
      actor_reference TEXT,
      birth_request TEXT, delete_requested INTEGER NOT NULL DEFAULT 0 CHECK (delete_requested IN (0,1)),
      PRIMARY KEY (actor_id, name)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_actor_subordinates_order
      ON actor_subordinates(actor_id, created_at, name)`);
  }

  /** `onConflict` is empty for a first insert and the upsert clause for a compensating restore. */
  private writeRow(entry: SubordinateRosterEntry, onConflict: string): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `INSERT INTO actor_subordinates (${ROSTER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${onConflict}`,
      this.actorId,
      entry.name,
      entry.createdBy,
      entry.status,
      entry.currentTask,
      entry.createdAt,
      entry.dismissedAt,
      entry.lifetime,
      entry.taskEventId,
      entry.actorReference === null ? null : JSON.stringify(entry.actorReference),
      entry.birth === null ? null : JSON.stringify(entry.birth), entry.deleteRequested ? 1 : 0,
    );
  }

  create(entry: SubordinateRosterEntry): void {
    this.writeRow(entry, '');
  }

  /** Exact upsert used only for compensating a failed facet operation. */
  restore(entry: SubordinateRosterEntry): void {
    this.writeRow(entry, ROSTER_RESTORE_CONFLICT);
  }

  attachActor(name: string, creationId: string, reference: ActorReference): void {
    const row = this.requireExisting(name);

    if (row.birth?.creationId !== creationId) throw new KinuError('denied', 'The birth admission no longer owns this roster name.');

    if (row.actorReference !== null && !sameActorReference(row.actorReference, reference)) throw new KinuError('denied', 'The roster actor reference is immutable.');
    const child = v.parse(ActorReferenceSchema, reference);
    this.sql.exec('UPDATE actor_subordinates SET actor_reference = ? WHERE actor_id = ? AND name = ?',
      JSON.stringify(child), this.actorId, name);
  }

  finishBirth(name: string, creationId: string): void {
    const row = this.requireExisting(name);

    if (row.birth?.creationId !== creationId || row.actorReference === null) throw new KinuError('denied', 'The birth admission cannot complete this roster row.');
    this.sql.exec('UPDATE actor_subordinates SET birth_request = NULL WHERE actor_id = ? AND name = ?',
      this.actorId, name);
  }

  /** This parent's rows in roster order, narrowed by `condition` (empty for all). */
  private orderedRows(condition: string): SubordinateRosterEntry[] {
    this.actor.assertCurrent();

    return this.sql.exec(
      `SELECT ${ROSTER_PROJECTION} FROM actor_subordinates
       WHERE actor_id = ? ${condition} ORDER BY created_at, name`,
      this.actorId,
    ).toArray().map(parseStoredRosterRow);
  }

  private anyRow(condition: string): boolean {
    this.actor.assertCurrent();

    return this.sql.exec(
      `SELECT name FROM actor_subordinates WHERE actor_id = ? ${condition} LIMIT 1`,
      this.actorId,
    ).toArray().length > 0;
  }

  pendingBirths(): SubordinateRosterEntry[] {
    return this.orderedRows('AND birth_request IS NOT NULL');
  }

  hasPendingBirths(): boolean {
    return this.anyRow('AND birth_request IS NOT NULL');
  }

  requestDeletion(name: string, reference: ActorReference, now: number): void {
    const row = this.requireExisting(name);

    if (!row.actorReference || !sameActorReference(row.actorReference, reference)) throw new KinuError('denied', 'The deletion request does not own this roster row.');
    this.sql.exec(`UPDATE actor_subordinates SET status = 'dismissed', dismissed_at = ?, delete_requested = 1 WHERE actor_id = ? AND name = ?`, now, this.actorId, name);
  }

  removeActor(name: string, reference: ActorReference): void {
    const row = this.get(name);

    if (!row) return;

    if (!row.actorReference || !sameActorReference(row.actorReference, reference)) throw new KinuError('denied', 'The deletion cannot remove a replacement actor.');
    this.sql.exec(`DELETE FROM actor_subordinates WHERE actor_id = ? AND name = ?
      AND json_extract(actor_reference, '$.actorId') = ? AND json_extract(actor_reference, '$.workspaceId') = ?
      AND json_extract(actor_reference, '$.parentActorId') IS ?`, this.actorId, name, reference.actorId, reference.workspaceId, reference.parentActorId);
  }

  cancelBirth(name: string, creationId: string): void {
    this.actor.assertCurrent();
    this.sql.exec(`UPDATE actor_subordinates SET status = 'dismissed', delete_requested = 1
      WHERE actor_id = ? AND name = ? AND json_extract(birth_request, '$.creationId') = ?`,
      this.actorId, name, creationId);
  }

  pendingDeletions(): SubordinateRosterEntry[] {
    return this.orderedRows('AND delete_requested = 1');
  }

  hasPendingDeletions(): boolean {
    return this.anyRow('AND delete_requested = 1');
  }
  remove(name: string): void {
    this.actor.assertCurrent();
    this.sql.exec(`DELETE FROM actor_subordinates WHERE actor_id = ? AND name = ?`, this.actorId, name);
  }

  get(name: string): SubordinateRosterEntry | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT ${ROSTER_PROJECTION} FROM actor_subordinates WHERE actor_id = ? AND name = ?`,
      this.actorId, name,
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
    return this.orderedRows(`AND status != 'dismissed'`);
  }

  listAll(): SubordinateRosterEntry[] {
    return this.orderedRows('');
  }

  /** Owner history includes archived children without reopening them. */
  listPage(request: PageRequest): Page<SubordinateRosterEntry> {
    this.actor.assertCurrent();
    const limit = boundedInt(request.limit, 50, 1, 200);
    const after = request.cursor?.after;
    const anchor = after === undefined ? null : this.get(after);

    if (after !== undefined && anchor === null) throw new StaleCursorError('subordinate roster', after);

    const rows = anchor
      ? this.sql.exec(`SELECT ${ROSTER_PROJECTION} FROM actor_subordinates
          WHERE actor_id = ? AND (created_at > ? OR (created_at = ? AND name > ?))
          ORDER BY created_at, name LIMIT ?`, this.actorId, anchor.createdAt, anchor.createdAt, anchor.name, limit + 1)
      : this.sql.exec(`SELECT ${ROSTER_PROJECTION} FROM actor_subordinates WHERE actor_id = ? ORDER BY created_at, name LIMIT ?`, this.actorId, limit + 1);

    return seekPage(rows.toArray().map(parseStoredRosterRow), limit, (row) => row.name);
  }

  /** Open an assignment on this row. `eventId` is a separate write because admission
   *  issues it after the roster transition. */
  assign(name: string, task: string): void {
    this.requireActive(name);
    this.sql.exec(
      `UPDATE actor_subordinates
       SET status = 'working', current_task = ?, task_event_id = NULL, dismissed_at = NULL
       WHERE actor_id = ? AND name = ?`,
      task,
      this.actorId,
      name,
    );
  }

  recordAssignmentEvent(name: string, eventId: string): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `UPDATE actor_subordinates SET task_event_id = ? WHERE actor_id = ? AND name = ?`,
      eventId,
      this.actorId,
      name,
    );
  }

  resumeAfterMessage(name: string): void {
    const entry = this.requireActive(name);

    if (entry.status !== 'awaiting_input') return;
    this.sql.exec(
      `UPDATE actor_subordinates SET status = 'working' WHERE actor_id = ? AND name = ?`,
      this.actorId,
      name,
    );
  }

  /**
   * Move a row on its child's report. A task-lifetime row is released by its answer here,
   * since no waiter may remain to do it; durable rows go to idle or awaiting_input.
   */
  applyReport(
    name: string,
    status: SubordinateReportStatus,
    origin: SubordinateReportOrigin,
    now: number,
  ): void {
    const entry = this.requireActive(name);

    // Same predicate as the port's settle, so both paths agree on which report is the answer.
    if (entry.lifetime === TEMPORARY_LIFETIME && temporaryRunSettles({ status, origin })) {
      this.dismiss(name, now);

      return;
    }

    this.sql.exec(
      `UPDATE actor_subordinates
       SET status = ?,
           current_task = CASE WHEN ? = 'completed' THEN NULL ELSE current_task END,
           task_event_id = CASE WHEN ? = 'completed' THEN NULL ELSE task_event_id END
       WHERE actor_id = ? AND name = ?`,
      reportedRosterStatus(status, entry.currentTask),
      status,
      status,
      this.actorId,
      name,
    );
  }

  dismiss(name: string, now: number): void {
    this.requireExisting(name);
    this.sql.exec(
      `UPDATE actor_subordinates
       SET status = 'dismissed', current_task = NULL, task_event_id = NULL,
           dismissed_at = COALESCE(dismissed_at, ?)
       WHERE actor_id = ? AND name = ?`,
      now,
      this.actorId,
      name,
    );
  }
}
