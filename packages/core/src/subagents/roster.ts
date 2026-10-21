/**
 * The subagent roster (`actor_subagents`): the parent's record of who works for it.
 * Durable and task-lifetime subagents share the table; the lifetime is the actor's, or its birth's before it exists.
 */

import { Cause, Effect } from 'effect';
import { settleSync } from '../obs/effect';
import * as v from 'valibot';
import type { SqlExec, SqlExecRow } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { seekPage, StaleCursorError, type Page, type PageRequest } from '../session/page';
import { boundedInt } from '../utils/bounds';
import type { SubagentReportStatus } from '../events/hub/types';
import type { SubagentReportOrigin } from './support';
import { SUBAGENT_STATUSES, type SubagentRosterEntry, type SubagentStatus } from '../delegation/agents-tool';
import { SUBAGENT_LIFETIMES, TEMPORARY_LIFETIME, temporaryRunSettles, type TaskTurnEnding } from './temporary';
import { ActorReferenceSchema, sameActorReference, type ActorReference } from '../identity/actor-handle';
import { SUBAGENT_ORIGINS } from '../identity/workspace-actors';
import { SubagentBirthSchema } from './birth';
import { parseJsonValue } from '../utils/json';
import { KinuError } from '../obs/error';
import { EvolutionSubagentStore, initEvolutionSubagentTable } from '../identity/evolution-subagents';
import type { AgentConfigStore } from '../config/store';
import type { NameOrigin } from '../identity/naming';

const ROSTER_COLUMNS =
  'actor_id, name, status, current_task, created_at, dismissed_at, task_event_id, actor_reference, birth_request, delete_requested';

/** Who made the hire, and for how long, are its actor's; before birth confirms an actor, the birth's seed carries them. */
const ROSTER_PROJECTION =
  'name, COALESCE((SELECT origin FROM workspace_actors WHERE actor_id = json_extract(actor_subagents.actor_reference, \'$.actorId\')), '
  + 'json_extract(birth_request, \'$.seed.origin\')) AS origin, status, current_task AS currentTask, '
  + 'created_at AS createdAt, dismissed_at AS dismissedAt, '
  + 'COALESCE((SELECT lifetime FROM workspace_actors WHERE actor_id = json_extract(actor_subagents.actor_reference, \'$.actorId\')), '
  + 'json_extract(birth_request, \'$.seed.lifetime\')) AS lifetime, '
  + 'task_event_id AS taskEventId, actor_reference AS actorReference, birth_request AS birth, delete_requested AS deleteRequested';

/** Every column a compensating restore overwrites, except the conflict key. */
const ROSTER_RESTORE_CONFLICT = `
       ON CONFLICT(actor_id, name) DO UPDATE SET
         status = excluded.status,
         current_task = excluded.current_task,
         created_at = excluded.created_at,
         dismissed_at = excluded.dismissed_at,
         task_event_id = excluded.task_event_id,
         actor_reference = excluded.actor_reference, birth_request = excluded.birth_request, delete_requested = excluded.delete_requested`;

export const SubagentRosterEntrySchema = v.object({
  name: v.string(),
  actorReference: v.nullable(ActorReferenceSchema),
  birth: v.nullable(SubagentBirthSchema),
  deleteRequested: v.boolean(),
  origin: v.picklist(SUBAGENT_ORIGINS),
  status: v.picklist(SUBAGENT_STATUSES),
  currentTask: v.nullable(v.string()),
  createdAt: v.number(),
  dismissedAt: v.nullable(v.number()),
  lifetime: v.picklist(SUBAGENT_LIFETIMES),
  taskEventId: v.nullable(v.string()),
}) satisfies v.GenericSchema<SubagentRosterEntry>;

const StoredRosterEntrySchema = v.object({
  ...SubagentRosterEntrySchema.entries, actorReference: v.nullable(v.string()), birth: v.nullable(v.string()),
  deleteRequested: v.pipe(v.union([v.literal(0), v.literal(1)]), v.transform((value) => value === 1)),
});

/** Where a row fails its schema, and how: `birth.seed.role: Invalid role id`. */
function firstIssue(issues: readonly v.BaseIssue<unknown>[]): string {
  const [issue] = issues;
  const path = issue?.path?.map((step) => String(step.key)).join('.') ?? '';

  return `${path === '' ? 'the row' : path}: ${issue?.message ?? 'unreadable'}`;
}

/** A stored row, its origin and lifetime read from its actor; one that fails says which row and which field, as
 *  `bad_input`: no retry reads the same row differently, so nothing waiting on it retries on a clock. */
function parseStoredRosterRow(row: SqlExecRow): Effect.Effect<SubagentRosterEntry, KinuError> {
  const named = typeof row.name === 'string' ? row.name : '(unnamed)';

  return Effect.catchCause(Effect.sync(() => {
    const stored = v.parse(StoredRosterEntrySchema, row);

    return v.parse(SubagentRosterEntrySchema, {
      ...stored, actorReference: stored.actorReference === null ? null : parseJsonValue(stored.actorReference),
      birth: stored.birth === null ? null : parseJsonValue(stored.birth),
    });
  }), (failed) => {
    const cause = Cause.squash(failed);
    const where = v.isValiError(cause) ? firstIssue(cause.issues) : String(cause);

    return Effect.fail(new KinuError('bad_input', `Stored subagent roster data is malformed: row "${named}", ${where}.`, { cause }));
  });
}

/** What a write stores is what a read accepts: a row the roster could not read back is never written. */
const WrittenRosterRowSchema = v.omit(SubagentRosterEntrySchema, ['origin', 'lifetime']);

/** What a roster write stores; `origin` and `lifetime` are read from the actor, never written here. */
type RosterRow = Omit<SubagentRosterEntry, 'origin' | 'lifetime'>;

export interface SubagentTitle {
  readonly displayName: string;
  readonly nameOrigin: NameOrigin;
  readonly role: string;
}

export function subagentTitle(entry: SubagentRosterEntry, config: AgentConfigStore | null): SubagentTitle {
  return settleSync(Effect.gen(function* () {
    if (config !== null) {
      return { displayName: config.getDisplayName() ?? entry.name, nameOrigin: config.getNameOrigin() ?? 'auto', role: config.getRoleSelection() };
    }

    const seed = entry.birth?.seed;

    if (seed === undefined) return yield* new KinuError('io', `Subagent "${entry.name}" has neither an actor nor a birth.`);

    return { displayName: seed.displayName, nameOrigin: seed.nameOrigin, role: seed.role };
  }));
}

/** Only a mid-turn note on an open assignment keeps a row working; a turn's end idles it. */
function reportedRosterStatus(status: SubagentReportStatus, origin: SubagentReportOrigin, currentTask: string | null): SubagentStatus {
  if (status === 'blocked') return 'awaiting_input';

  if (temporaryRunSettles({ status, origin })) return 'idle';

  return currentTask === null || currentTask === '' ? 'idle' : 'working';
}

export function initSubagentRosterTable(sql: SqlExec): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS actor_subagents (
    actor_id      TEXT NOT NULL,
    name          TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('idle','working','awaiting_input','dismissed')),
    current_task  TEXT,
    created_at    INTEGER NOT NULL,
    dismissed_at INTEGER,
    task_event_id TEXT,
    actor_reference TEXT,
    birth_request TEXT, delete_requested INTEGER NOT NULL DEFAULT 0 CHECK (delete_requested IN (0,1)),
    PRIMARY KEY (actor_id, name)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_actor_subagents_order
    ON actor_subagents(actor_id, created_at, name)`);
  initEvolutionSubagentTable(sql);
}

/** Parent-actor roster; owns all subagent status policy. */
export class SubagentRosterStore {
  private readonly actorId: string;

  readonly evolution: EvolutionSubagentStore;

  /** Scoped to one parent actor: subagent names are unique only per parent. */
  constructor(private readonly sql: SqlExec, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
    this.evolution = new EvolutionSubagentStore(sql, actor);
  }

  ensureSchema(): void {
    this.actor.assertCurrent();
    initSubagentRosterTable(this.sql);
  }

  /** `onConflict` is empty for a first insert and the upsert clause for a compensating restore. */
  private writeRow(entry: RosterRow, onConflict: string): Effect.Effect<void, KinuError> {
    return Effect.suspend(() => {
      this.actor.assertCurrent();
      const checked = v.safeParse(WrittenRosterRowSchema, entry);

      if (!checked.success) return new KinuError('bad_input', `The hire "${entry.name}" cannot be recorded: ${firstIssue(checked.issues)}.`);
      this.sql.exec(
        `INSERT INTO actor_subagents (${ROSTER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${onConflict}`,
        this.actorId,
        entry.name,
        entry.status,
        entry.currentTask,
        entry.createdAt,
        entry.dismissedAt,
        entry.taskEventId,
        entry.actorReference === null ? null : JSON.stringify(entry.actorReference),
        entry.birth === null ? null : JSON.stringify(entry.birth), entry.deleteRequested ? 1 : 0,
      );

      return Effect.void;
    });
  }

  create(entry: RosterRow): void {
    return settleSync(this.writeRow(entry, ''));
  }

  /** Exact upsert used only for compensating a failed facet operation. */
  restore(entry: RosterRow): void {
    return settleSync(this.writeRow(entry, ROSTER_RESTORE_CONFLICT));
  }

  attachActor(name: string, creationId: string, reference: ActorReference): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const row = this.requireExisting(name);

      if (row.birth?.creationId !== creationId) return yield* new KinuError('denied', 'The birth admission no longer owns this roster name.');

      if (row.actorReference !== null && !sameActorReference(row.actorReference, reference)) return yield* new KinuError('denied', 'The roster actor reference is immutable.');
      const child = v.parse(ActorReferenceSchema, reference);
      this.sql.exec('UPDATE actor_subagents SET actor_reference = ? WHERE actor_id = ? AND name = ?',
        JSON.stringify(child), this.actorId, name);
    }));
  }

  finishBirth(name: string, creationId: string): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const row = this.requireExisting(name);

      if (row.birth?.creationId !== creationId || row.actorReference === null) return yield* new KinuError('denied', 'The birth admission cannot complete this roster row.');
      this.sql.exec('UPDATE actor_subagents SET birth_request = NULL WHERE actor_id = ? AND name = ?',
        this.actorId, name);
    }));
  }

  /** This parent's rows in roster order, narrowed by `condition` (empty for all). */
  private orderedRows(condition: string): Effect.Effect<SubagentRosterEntry[], KinuError> {
    return Effect.suspend(() => {
      this.actor.assertCurrent();

      return Effect.forEach(this.sql.exec(
        `SELECT ${ROSTER_PROJECTION} FROM actor_subagents
         WHERE actor_id = ? ${condition} ORDER BY created_at, name`,
        this.actorId,
      ).toArray(), parseStoredRosterRow);
    });
  }

  private anyRow(condition: string): boolean {
    this.actor.assertCurrent();

    return this.sql.exec(
      `SELECT name FROM actor_subagents WHERE actor_id = ? ${condition} LIMIT 1`,
      this.actorId,
    ).toArray().length > 0;
  }

  pendingBirths(): SubagentRosterEntry[] {
    return settleSync(this.orderedRows('AND birth_request IS NOT NULL'));
  }

  hasPendingBirths(): boolean {
    return this.anyRow('AND birth_request IS NOT NULL');
  }

  requestDeletion(name: string, reference: ActorReference, now: number): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const row = this.requireExisting(name);

      if (!row.actorReference || !sameActorReference(row.actorReference, reference)) return yield* new KinuError('denied', 'The deletion request does not own this roster row.');
      this.sql.exec(`UPDATE actor_subagents SET status = 'dismissed', dismissed_at = ?, delete_requested = 1 WHERE actor_id = ? AND name = ?`, now, this.actorId, name);
    }));
  }

  removeActor(name: string, reference: ActorReference): void {
    return settleSync(Effect.gen({ self: this }, function* () {
      const row = this.get(name);

      if (!row) return;

      if (!row.actorReference || !sameActorReference(row.actorReference, reference)) return yield* new KinuError('denied', 'The deletion cannot remove a replacement actor.');
      this.sql.exec(`DELETE FROM actor_subagents WHERE actor_id = ? AND name = ?
        AND json_extract(actor_reference, '$.actorId') = ? AND json_extract(actor_reference, '$.workspaceId') = ?
        AND json_extract(actor_reference, '$.parentActorId') IS ?`, this.actorId, name, reference.actorId, reference.workspaceId, reference.parentActorId);
      this.evolution.remove(name);
    }));
  }

  cancelBirth(name: string, creationId: string): void {
    this.actor.assertCurrent();
    this.sql.exec(`UPDATE actor_subagents SET status = 'dismissed', delete_requested = 1
      WHERE actor_id = ? AND name = ? AND json_extract(birth_request, '$.creationId') = ?`,
      this.actorId, name, creationId);
  }

  pendingDeletions(): SubagentRosterEntry[] {
    return settleSync(this.orderedRows('AND delete_requested = 1'));
  }

  hasPendingDeletions(): boolean {
    return this.anyRow('AND delete_requested = 1');
  }
  remove(name: string): void {
    this.actor.assertCurrent();
    this.sql.exec(`DELETE FROM actor_subagents WHERE actor_id = ? AND name = ?`, this.actorId, name);
    this.evolution.remove(name);
  }

  get(name: string): SubagentRosterEntry | null {
    return settleSync(this.row(name));
  }

  private row(name: string): Effect.Effect<SubagentRosterEntry | null, KinuError> {
    return Effect.suspend(() => {
      this.actor.assertCurrent();

      const rows = this.sql.exec(
        `SELECT ${ROSTER_PROJECTION} FROM actor_subagents WHERE actor_id = ? AND name = ?`,
        this.actorId, name,
      ).toArray();

      return rows.length === 0 ? Effect.succeed(null) : parseStoredRosterRow(rows[0]);
    });
  }

  requireExisting(name: string): SubagentRosterEntry {
    return settleSync(Effect.gen({ self: this }, function* () {
      const entry = this.get(name);

      if (!entry) return yield* Effect.die(new Error(`unknown subagent "${name}"`));

      return entry;
    }));
  }

  requireActive(name: string): SubagentRosterEntry {
    return settleSync(Effect.gen({ self: this }, function* () {
      const entry = this.requireExisting(name);

      if (entry.status === 'dismissed') return yield* Effect.die(new Error(`subagent "${name}" is dismissed`));

      return entry;
    }));
  }

  list(): SubagentRosterEntry[] {
    return settleSync(this.orderedRows(`AND status != 'dismissed'`));
  }

  listAll(): SubagentRosterEntry[] {
    return settleSync(this.orderedRows(''));
  }

  /** Owner history includes archived children without reopening them. */
  listPage(request: PageRequest): Page<SubagentRosterEntry> {
    return settleSync(Effect.gen({ self: this }, function* () {
      this.actor.assertCurrent();
      const limit = boundedInt(request.limit, 50, 1, 200);
      const after = request.cursor?.after;
      const anchor = after === undefined ? null : yield* this.row(after);

      if (after !== undefined && anchor === null) return yield* Effect.die(new StaleCursorError('subagent roster', after));

      const rows = anchor
        ? this.sql.exec(`SELECT ${ROSTER_PROJECTION} FROM actor_subagents
            WHERE actor_id = ? AND (created_at > ? OR (created_at = ? AND name > ?))
            ORDER BY created_at, name LIMIT ?`, this.actorId, anchor.createdAt, anchor.createdAt, anchor.name, limit + 1)
        : this.sql.exec(`SELECT ${ROSTER_PROJECTION} FROM actor_subagents WHERE actor_id = ? ORDER BY created_at, name LIMIT ?`, this.actorId, limit + 1);

      return seekPage(yield* Effect.forEach(rows.toArray(), parseStoredRosterRow), limit, (row) => row.name);
    }));
  }

  /** Open an assignment on this row. `eventId` is a separate write because admission
   *  issues it after the roster transition. */
  assign(name: string, task: string): void {
    this.requireActive(name);
    this.sql.exec(
      `UPDATE actor_subagents
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
      `UPDATE actor_subagents SET task_event_id = ? WHERE actor_id = ? AND name = ?`,
      eventId,
      this.actorId,
      name,
    );
  }

  resumeAfterMessage(name: string): void {
    const entry = this.requireActive(name);

    if (entry.status !== 'awaiting_input') return;
    this.sql.exec(
      `UPDATE actor_subagents SET status = 'working' WHERE actor_id = ? AND name = ?`,
      this.actorId,
      name,
    );
  }

  /** End durable activity independently of report delivery; an explicit answer or block stands. A turn its parent
   *  awaits nothing from (no current task: the owner's own chat) ends idle however it ended: a block would wait on no one. */
  finishTurn(name: string, ending: TaskTurnEnding, now: number): boolean {
    const entry = this.get(name);

    // Task agents may owe a later turn's answer while their own subagents or inbox still hold work.
    if (entry === null || entry.lifetime !== 'durable' || entry.status !== 'working') return false;
    this.applyReport(name, ending === 'answered' || entry.currentTask === null ? 'progress' : 'blocked', 'turn_end', now);

    return true;
  }

  /**
   * Move a row on its child's report. A task-lifetime row is released by its answer here,
   * since no waiter may remain to do it; durable rows go to idle or awaiting_input.
   */
  applyReport(
    name: string,
    status: SubagentReportStatus,
    origin: SubagentReportOrigin,
    now: number,
  ): void {
    const entry = this.requireActive(name);

    // Same predicate as the port's settle, so both paths agree on which report is the answer.
    if (entry.lifetime === TEMPORARY_LIFETIME && temporaryRunSettles({ status, origin })) {
      this.dismiss(name, now);

      return;
    }

    this.sql.exec(
      `UPDATE actor_subagents
       SET status = ?,
           current_task = CASE WHEN ? = 'completed' THEN NULL ELSE current_task END,
           task_event_id = CASE WHEN ? = 'completed' THEN NULL ELSE task_event_id END
       WHERE actor_id = ? AND name = ?`,
      reportedRosterStatus(status, origin, entry.currentTask),
      status,
      status,
      this.actorId,
      name,
    );
  }

  dismiss(name: string, now: number): void {
    this.requireExisting(name);
    this.sql.exec(
      `UPDATE actor_subagents
       SET status = 'dismissed', current_task = NULL, task_event_id = NULL,
           dismissed_at = COALESCE(dismissed_at, ?)
       WHERE actor_id = ? AND name = ?`,
      now,
      this.actorId,
      name,
    );
  }
}
