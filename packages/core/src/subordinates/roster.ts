/**
 * THE SUBORDINATE ROSTER — the parent's own record of who works for it.
 *
 * ONE table, `actor_subordinates`, and one place its status policy lives, so
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
import type { SqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { seekPage, StaleCursorError, type Page, type PageRequest } from '../read-models/page';
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

/** The two roster columns nothing else can derive.
 *
 *  `lifetime` is a DECISION the creating call made and no later state recovers:
 *  a task-lifetime row and a durable row with an open assignment are the same
 *  shape, and only one of them is released when it answers.
 *
 *  `task_event_id` is the EventLog's own id for the assignment this row is
 *  working on. Admission supplies this identity.
 *  what correlates the eventual report with the thing that was asked. It is the
 *  same id the sender is handed as `SubordinateHandoff.eventId`, which is what
 *  makes the correlation the one already documented on this surface rather than
 *  a second scheme beside it. */

/** Lifecycle and task facts only — the title and role a subordinate presents
 *  live in ITS actor_config ({@link SubordinateDescriptorSource}), never here. */
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

function parseStoredRosterRow<T>(row: T): SubordinateRosterEntry {
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

/** Parent-DO product roster. All status policy lives here so tools, report
 * ingress, snapshots, and the future UI cannot drift. */
export class SubordinateRosterStore {
  private readonly actorId: string;

  /** Bind the roster to ONE PARENT actor. A subordinate name is chosen by the
   *  parent that hired it ('reviewer', 'scout'), so two actors of one workspace
   *  really do hire the same name — and a shared table would let one parent
   *  dismiss, re-point or delete another's child by name alone. */
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

  create(entry: SubordinateRosterEntry): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `INSERT INTO actor_subordinates (${ROSTER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  /** Exact upsert used only for compensating a failed facet operation. */
  restore(entry: SubordinateRosterEntry): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `INSERT INTO actor_subordinates (${ROSTER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(actor_id, name) DO UPDATE SET
         created_by = excluded.created_by,
         status = excluded.status,
         current_task = excluded.current_task,
         created_at = excluded.created_at,
         dismissed_at = excluded.dismissed_at,
         lifetime = excluded.lifetime,
         task_event_id = excluded.task_event_id,
         actor_reference = excluded.actor_reference, birth_request = excluded.birth_request, delete_requested = excluded.delete_requested`,
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

  pendingBirths(): SubordinateRosterEntry[] {
    this.actor.assertCurrent();
    return this.sql.exec(`SELECT ${ROSTER_PROJECTION} FROM actor_subordinates WHERE actor_id = ? AND birth_request IS NOT NULL ORDER BY created_at, name`, this.actorId).toArray().map(parseStoredRosterRow);
  }

  hasPendingBirths(): boolean {
    this.actor.assertCurrent();
    return this.sql.exec('SELECT name FROM actor_subordinates WHERE actor_id = ? AND birth_request IS NOT NULL LIMIT 1', this.actorId).toArray().length > 0;
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
    this.actor.assertCurrent();
    return this.sql.exec(`SELECT ${ROSTER_PROJECTION} FROM actor_subordinates WHERE actor_id = ? AND delete_requested = 1 ORDER BY created_at, name`, this.actorId).toArray().map(parseStoredRosterRow);
  }

  hasPendingDeletions(): boolean {
    this.actor.assertCurrent();
    return this.sql.exec('SELECT name FROM actor_subordinates WHERE actor_id = ? AND delete_requested = 1 LIMIT 1', this.actorId).toArray().length > 0;
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
    this.actor.assertCurrent();
    return this.sql.exec(
      `SELECT ${ROSTER_PROJECTION} FROM actor_subordinates
       WHERE actor_id = ? AND status != 'dismissed' ORDER BY created_at, name`,
      this.actorId,
    ).toArray().map(parseStoredRosterRow);
  }

  listAll(): SubordinateRosterEntry[] {
    this.actor.assertCurrent();
    return this.sql.exec(
      `SELECT ${ROSTER_PROJECTION} FROM actor_subordinates WHERE actor_id = ? ORDER BY created_at, name`,
      this.actorId,
    ).toArray().map(parseStoredRosterRow);
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

  /** Open an assignment on this row. `eventId` is the EventLog id the eventual
   *  report cites; it lands here in a SECOND write because admission issues it
   *  and admission happens after the roster transition it compensates. */
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

  /** Record which admitted event this row's open assignment IS. */
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
      `UPDATE actor_subordinates
       SET status = ?,
           current_task = CASE WHEN ? = 'completed' THEN NULL ELSE current_task END,
           task_event_id = CASE WHEN ? = 'completed' THEN NULL ELSE task_event_id END
       WHERE actor_id = ? AND name = ?`,
      rosterStatus,
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
