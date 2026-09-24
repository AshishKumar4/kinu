/**
 * The control-plane index and audit log over a `ControlPlaneSql`. Every row except
 * the audit log is derived from UserDO state; the audit log is primary and has no
 * update or delete path beyond settling a pending outcome.
 */
import { seekPage, type Page, type PageRequest } from '../session/page';
import * as v from 'valibot';
import type { ControlPlaneSql, ControlPlaneSqlValue } from './sql';
import {
  FEEDBACK_MAX_NOTE_CHARS, FEEDBACK_MAX_ROUTE_CHARS, FEEDBACK_MAX_USER_AGENT_CHARS,
  type FeedbackRecord,
} from '../feedback/contract';

export type { ControlPlaneSql } from './sql';

/** `MAX` is a per-page ceiling; every list is cursored. */
export const CONTROL_PAGE_DEFAULT = 50;

export const CONTROL_PAGE_MAX = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

const DDL = [
  `CREATE TABLE IF NOT EXISTS cp_users (
     user_id       TEXT PRIMARY KEY,
     email         TEXT    NOT NULL,
     display_name  TEXT,
     first_seen_at INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS cp_users_seen ON cp_users (last_seen_at DESC, user_id)`,
  // Keyed by (owner, name): a workspace name is unique only within a UserDO.
  `CREATE TABLE IF NOT EXISTS cp_workspaces (
     user_id      TEXT    NOT NULL,
     name         TEXT    NOT NULL,
     display_name TEXT    NOT NULL,
     created_at   INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     removed_at   INTEGER,
     PRIMARY KEY (user_id, name)
   )`,
  `CREATE INDEX IF NOT EXISTS cp_workspaces_seen
     ON cp_workspaces (last_seen_at DESC, user_id, name)`,
  `CREATE TABLE IF NOT EXISTS cp_feedback (
     id            TEXT PRIMARY KEY,
     created_at    INTEGER NOT NULL,
     user_id       TEXT    NOT NULL,
     email         TEXT    NOT NULL,
     note          TEXT    NOT NULL,
     route         TEXT    NOT NULL,
     workspace     TEXT,
     object_key    TEXT,
     content_type  TEXT,
     bytes         INTEGER,
     user_agent    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS cp_feedback_created ON cp_feedback (created_at DESC, id)`,
  `CREATE TABLE IF NOT EXISTS cp_audit (
     id           TEXT PRIMARY KEY,
     at           INTEGER NOT NULL,
     actor_email  TEXT    NOT NULL,
     actor_user   TEXT    NOT NULL,
     operation    TEXT    NOT NULL,
     target_kind  TEXT    NOT NULL,
     target       TEXT    NOT NULL,
     outcome      TEXT    NOT NULL,
     detail       TEXT    NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS cp_audit_at ON cp_audit (at DESC, id)`,
] as const;

export function initControlPlaneSchema(sql: ControlPlaneSql): void {
  for (const statement of DDL) sql.exec(statement);
}

export interface ControlUserRow {
  userId: string;
  email: string;
  displayName: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  workspaces: number;
}

export interface ControlWorkspaceRow {
  userId: string;
  /** Empty when the workspace was indexed before its owner was observed. */
  email: string;
  name: string;
  displayName: string;
  createdAt: number;
  lastSeenAt: number;
  removedAt: number | null;
}


/** `pending` is the intent, written before the mutation runs; a row still pending
 *  means the result was never recorded. */
export const AUDIT_OUTCOMES = ['pending', 'ok', 'denied', 'failed'] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export type AuditSettlement = Exclude<AuditOutcome, 'pending'>;

export interface ControlAuditRow {
  id: string;
  at: number;
  actorEmail: string;
  actorUserId: string;
  operation: string;
  targetKind: string;
  target: string;
  outcome: AuditOutcome;
  /** Never a credential. */
  detail: string;
}

export interface ControlOverview {
  users: number;
  workspaces: number;
  workspacesRemoved: number;
  feedback: number;
  auditEntries: number;
  lastAdminActionAt: number | null;
  activeUsers24h: number;
  activeUsers7d: number;
}

export interface UserObservation {
  userId: string;
  email: string;
  displayName?: string | null;
  at?: number;
}

export interface WorkspaceObservation {
  userId: string;
  name: string;
  displayName: string;
  /** The registry's creation time when known, rather than first-open time. */
  createdAt?: number;
  at?: number;
}

export interface RosterWorkspace {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
}

const UserSqlRowSchema = v.object({
  user_id: v.string(),
  email: v.string(),
  display_name: v.nullable(v.string()),
  first_seen_at: v.number(),
  last_seen_at: v.number(),
  workspaces: v.number(),
});

type UserSqlRow = v.InferOutput<typeof UserSqlRowSchema>;

const WorkspaceSqlRowSchema = v.object({
  user_id: v.string(),
  email: v.nullable(v.string()),
  name: v.string(),
  display_name: v.string(),
  created_at: v.number(),
  last_seen_at: v.number(),
  removed_at: v.nullable(v.number()),
});

type WorkspaceSqlRow = v.InferOutput<typeof WorkspaceSqlRowSchema>;

// `outcome` is narrowed in `projectAudit` so a hand-edited row reads as `failed`.
const AuditSqlRowSchema = v.object({
  id: v.string(),
  at: v.number(),
  actor_email: v.string(),
  actor_user: v.string(),
  operation: v.string(),
  target_kind: v.string(),
  target: v.string(),
  outcome: v.string(),
  detail: v.string(),
});

type AuditSqlRow = v.InferOutput<typeof AuditSqlRowSchema>;

function clampPage(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CONTROL_PAGE_DEFAULT;

  return Math.min(CONTROL_PAGE_MAX, Math.max(1, Math.trunc(limit)));
}

/** The tiebreak is mandatory: rows can share a millisecond, and a page boundary
 *  inside a tie would skip or repeat rows. */
function anchor(at: number, ...tiebreak: string[]): string {
  return [String(at), ...tiebreak].join('\u0000');
}

/** Thrown rather than restarting the walk, which would silently repeat rows. */
export class MalformedCursorError extends Error {
  constructor() {
    super('That control-plane cursor is not one this read issued.');
    this.name = 'MalformedCursorError';
  }
}

function readAnchor(cursor: PageRequest['cursor'], parts: number): ControlPlaneSqlValue[] | null {
  if (cursor === undefined) return null;
  const pieces = cursor.after.split('\u0000');

  if (pieces.length !== parts) throw new MalformedCursorError();
  const at = Number(pieces[0]);

  if (!Number.isFinite(at)) throw new MalformedCursorError();

  return [at, ...pieces.slice(1)];
}

function clampText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function run(sql: ControlPlaneSql, query: string, ...bindings: ControlPlaneSqlValue[]): void {
  sql.exec(query, ...bindings);
}

/** Parsed, not asserted: stored rows may predate the current column set. */
function select<Row>(
  sql: ControlPlaneSql, schema: v.GenericSchema<Row>, query: string, ...bindings: ControlPlaneSqlValue[]
): Row[] {
  return v.parse(v.array(schema), sql.exec(query, ...bindings).toArray());
}

const CountRowSchema = v.object({ n: v.number() });

function count(sql: ControlPlaneSql, query: string, ...bindings: ControlPlaneSqlValue[]): number {
  return select(sql, CountRowSchema, query, ...bindings)[0]?.n ?? 0;
}

/** Upsert: `email` is refreshed because a provider can change the verified address. */
export function observeUser(sql: ControlPlaneSql, observation: UserObservation, now = Date.now()): void {
  const at = observation.at ?? now;
  run(sql,
    `INSERT INTO cp_users (user_id, email, display_name, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       email = excluded.email,
       display_name = COALESCE(excluded.display_name, cp_users.display_name),
       last_seen_at = MAX(cp_users.last_seen_at, excluded.last_seen_at)`,
    observation.userId, observation.email, observation.displayName ?? null, at, at);
}

const WORKSPACE_SEEN = `
       last_seen_at = MAX(cp_workspaces.last_seen_at, excluded.last_seen_at),
       removed_at = NULL`;

const WORKSPACE_TITLED = `
       display_name = excluded.display_name,
       created_at = MIN(cp_workspaces.created_at, excluded.created_at),${WORKSPACE_SEEN}`;

function writeWorkspaceRow(
  sql: ControlPlaneSql, observation: WorkspaceObservation, now: number, onConflict: string,
): void {
  const at = observation.at ?? now;
  run(sql,
    `INSERT INTO cp_workspaces (user_id, name, display_name, created_at, last_seen_at, removed_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(user_id, name) DO UPDATE SET${onConflict}`,
    observation.userId, observation.name, observation.displayName,
    observation.createdAt ?? at, at);
}

/** Resurrects a tombstoned row: a same-name recreate is a live workspace. */
export function observeWorkspace(
  sql: ControlPlaneSql, observation: WorkspaceObservation, now = Date.now(),
): void {
  writeWorkspaceRow(sql, observation, now, WORKSPACE_TITLED);
}

/** Record use without claiming a title; the use feed only knows the slug. */
export function touchWorkspace(
  sql: ControlPlaneSql, observation: WorkspaceObservation, now = Date.now(),
): void {
  writeWorkspaceRow(sql, observation, now, WORKSPACE_SEEN);
}

/** A tombstone, not a delete: the row is the only remaining evidence. */
export function forgetWorkspace(
  sql: ControlPlaneSql, target: { userId: string; name: string; at?: number }, now = Date.now(),
): void {
  run(sql,
    `UPDATE cp_workspaces SET removed_at = ?
     WHERE user_id = ? AND name = ? AND removed_at IS NULL`,
    target.at ?? now, target.userId, target.name);
}


export interface ReconcileOutcome {
  present: number;
  tombstoned: number;
}

/**
 * Settle one account's rows against the registry, so a missed feed is never
 * permanent. Absent rows are tombstoned; an empty `live` tombstones all.
 */
export function replaceUserWorkspaces(
  sql: ControlPlaneSql, userId: string, live: readonly RosterWorkspace[], now = Date.now(),
): ReconcileOutcome {
  for (const row of live) {
    // Keep last_seen_at monotone: the use feed advances it beyond the registry.
    run(sql,
      `INSERT INTO cp_workspaces (user_id, name, display_name, created_at, last_seen_at, removed_at)
       VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(user_id, name) DO UPDATE SET
        display_name = excluded.display_name,
        created_at = excluded.created_at,
        last_seen_at = MAX(cp_workspaces.last_seen_at, excluded.last_seen_at),
        removed_at = NULL`,
      userId, row.name, row.displayName, row.createdAt, row.lastVisited);
  }

  const names = live.map((row) => row.name);

  const before = count(sql,
    `SELECT COUNT(*) AS n FROM cp_workspaces WHERE user_id = ? AND removed_at IS NULL`, userId);

  const placeholders = names.map(() => '?').join(', ');
  run(sql,
    `UPDATE cp_workspaces SET removed_at = ?
     WHERE user_id = ? AND removed_at IS NULL
       ${names.length > 0 ? `AND name NOT IN (${placeholders})` : ''}`,
    now, userId, ...names);

  const after = count(sql,
    `SELECT COUNT(*) AS n FROM cp_workspaces WHERE user_id = ? AND removed_at IS NULL`, userId);

  return { present: live.length, tombstoned: before - after };
}

export function overview(sql: ControlPlaneSql, now = Date.now()): ControlOverview {
  return {
    users: count(sql, `SELECT COUNT(*) AS n FROM cp_users`),
    workspaces: count(sql, `SELECT COUNT(*) AS n FROM cp_workspaces WHERE removed_at IS NULL`),
    workspacesRemoved: count(sql, `SELECT COUNT(*) AS n FROM cp_workspaces WHERE removed_at IS NOT NULL`),
    feedback: count(sql, `SELECT COUNT(*) AS n FROM cp_feedback`),
    auditEntries: count(sql, `SELECT COUNT(*) AS n FROM cp_audit`),
    lastAdminActionAt: select(sql, v.object({ at: v.number() }), `SELECT at FROM cp_audit ORDER BY at DESC LIMIT 1`)[0]?.at ?? null,
    activeUsers24h: count(sql, `SELECT COUNT(*) AS n FROM cp_users WHERE last_seen_at >= ?`, now - DAY_MS),
    activeUsers7d: count(sql, `SELECT COUNT(*) AS n FROM cp_users WHERE last_seen_at >= ?`, now - 7 * DAY_MS),
  };
}

export function listUsers(sql: ControlPlaneSql, request: PageRequest = {}): Page<ControlUserRow> {
  const limit = clampPage(request.limit);
  const from = readAnchor(request.cursor, 2);

  const found = select(sql, UserSqlRowSchema,
    `SELECT u.user_id, u.email, u.display_name, u.first_seen_at, u.last_seen_at,
            (SELECT COUNT(*) FROM cp_workspaces w
              WHERE w.user_id = u.user_id AND w.removed_at IS NULL) AS workspaces
       FROM cp_users u
      ${from ? `WHERE (u.last_seen_at < ?) OR (u.last_seen_at = ? AND u.user_id > ?)` : ''}
      ORDER BY u.last_seen_at DESC, u.user_id ASC
      LIMIT ?`,
    ...(from ? [from[0], from[0], from[1]] : []), limit + 1);

  return seekPage(found.map(projectUser), limit, (row) => anchor(row.lastSeenAt, row.userId));
}

export function getUser(sql: ControlPlaneSql, userId: string): ControlUserRow | null {
  const row = select(sql, UserSqlRowSchema,
    `SELECT u.user_id, u.email, u.display_name, u.first_seen_at, u.last_seen_at,
            (SELECT COUNT(*) FROM cp_workspaces w
              WHERE w.user_id = u.user_id AND w.removed_at IS NULL) AS workspaces
       FROM cp_users u WHERE u.user_id = ?`, userId)[0];

  return row ? projectUser(row) : null;
}

export interface WorkspaceFilter {
  userId?: string;
  includeRemoved?: boolean;
}

export function listWorkspaces(
  sql: ControlPlaneSql,
  request: PageRequest = {},
  filter: WorkspaceFilter = {},
): Page<ControlWorkspaceRow> {
  const limit = clampPage(request.limit);
  const from = readAnchor(request.cursor, 3);
  const where: string[] = [];
  const bindings: ControlPlaneSqlValue[] = [];

  if (filter.userId !== undefined) { where.push(`w.user_id = ?`); bindings.push(filter.userId); }

  if (filter.includeRemoved !== true) where.push(`w.removed_at IS NULL`);

  if (from) {
    where.push(
      `((w.last_seen_at < ?) OR (w.last_seen_at = ? AND (w.user_id > ? OR (w.user_id = ? AND w.name > ?))))`,
    );
    bindings.push(from[0], from[0], from[1], from[1], from[2]);
  }

  const found = select(sql, WorkspaceSqlRowSchema,
    `SELECT w.user_id, u.email, w.name, w.display_name, w.created_at, w.last_seen_at, w.removed_at
       FROM cp_workspaces w LEFT JOIN cp_users u ON u.user_id = w.user_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY w.last_seen_at DESC, w.user_id ASC, w.name ASC
      LIMIT ?`,
    ...bindings, limit + 1);

  return seekPage(
    found.map(projectWorkspace), limit,
    (row) => anchor(row.lastSeenAt, row.userId, row.name),
  );
}

export function listAudit(sql: ControlPlaneSql, request: PageRequest = {}): Page<ControlAuditRow> {
  const limit = clampPage(request.limit);
  const from = readAnchor(request.cursor, 2);

  const found = select(sql, AuditSqlRowSchema,
    `SELECT id, at, actor_email, actor_user, operation, target_kind, target, outcome, detail
       FROM cp_audit
      ${from ? `WHERE (at < ?) OR (at = ? AND id > ?)` : ''}
      ORDER BY at DESC, id ASC
      LIMIT ?`,
    ...(from ? [from[0], from[0], from[1]] : []), limit + 1);

  return seekPage(found.map(projectAudit), limit, (row) => anchor(row.at, row.id));
}

export interface AuditDraft {
  actorEmail: string;
  actorUserId: string;
  operation: string;
  targetKind: string;
  target: string;
  outcome: AuditOutcome;
  detail: string;
}

/**
 * Insert only. The id and clock are this function's, never the draft's, so a
 * caller cannot collide with an existing row or backdate an attempt.
 */
export function appendAudit(sql: ControlPlaneSql, draft: AuditDraft, now = Date.now()): ControlAuditRow {
  const row: ControlAuditRow = {
    id: crypto.randomUUID(),
    at: now,
    actorEmail: draft.actorEmail,
    actorUserId: draft.actorUserId,
    operation: draft.operation,
    targetKind: draft.targetKind,
    target: draft.target,
    outcome: draft.outcome,
    detail: draft.detail,
  };

  run(sql,
    `INSERT INTO cp_audit
       (id, at, actor_email, actor_user, operation, target_kind, target, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.at, row.actorEmail, row.actorUserId,
    row.operation, row.targetKind, row.target, row.outcome, row.detail);

  return row;
}

/**
 * `WHERE outcome = 'pending'` keeps settled rows immutable. Returns `null` when
 * no pending row matched; callers must not treat that as success.
 */
export function settleAudit(
  sql: ControlPlaneSql,
  settlement: { id: string; outcome: AuditSettlement; detail: string },
): ControlAuditRow | null {
  run(sql,
    `UPDATE cp_audit SET outcome = ?, detail = ? WHERE id = ? AND outcome = 'pending'`,
    settlement.outcome, settlement.detail, settlement.id);

  const found = select(sql, AuditSqlRowSchema,
    `SELECT id, at, actor_email, actor_user, operation, target_kind, target, outcome, detail
       FROM cp_audit WHERE id = ?`,
    settlement.id);

  const row = found[0];

  if (row === undefined || row.outcome !== settlement.outcome) return null;

  return projectAudit(row);
}

/** Attempts whose outcome was never recorded. */
export function listPendingAudit(sql: ControlPlaneSql, limit = CONTROL_PAGE_DEFAULT): ControlAuditRow[] {
  return select(sql, AuditSqlRowSchema,
    `SELECT id, at, actor_email, actor_user, operation, target_kind, target, outcome, detail
       FROM cp_audit WHERE outcome = 'pending' ORDER BY at DESC, id ASC LIMIT ?`,
    clampPage(limit)).map(projectAudit);
}

function projectUser(row: UserSqlRow): ControlUserRow {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    workspaces: row.workspaces,
  };
}

function projectWorkspace(row: WorkspaceSqlRow): ControlWorkspaceRow {
  return {
    userId: row.user_id,
    email: row.email ?? '',
    name: row.name,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    removedAt: row.removed_at,
  };
}

function projectAudit(row: AuditSqlRow): ControlAuditRow {
  return {
    id: row.id,
    at: row.at,
    actorEmail: row.actor_email,
    actorUserId: row.actor_user,
    operation: row.operation,
    targetKind: row.target_kind,
    target: row.target,
    // Narrowed on read so a hand-edited database cannot widen the type.
    outcome: AUDIT_OUTCOMES.find((known) => known === row.outcome) ?? 'failed',
    detail: row.detail,
  };
}

export type ControlFeedbackRow = FeedbackRecord;

const FeedbackSqlRowSchema = v.object({
  id: v.string(),
  created_at: v.number(),
  user_id: v.string(),
  email: v.string(),
  note: v.string(),
  route: v.string(),
  workspace: v.nullable(v.string()),
  object_key: v.nullable(v.string()),
  content_type: v.nullable(v.string()),
  bytes: v.nullable(v.number()),
  user_agent: v.nullable(v.string()),
});

type FeedbackSqlRow = v.InferOutput<typeof FeedbackSqlRowSchema>;

export interface FeedbackWritten { id: string }

/** Screenshot bytes live elsewhere; the row carries only `objectKey`. */
export function recordFeedback(sql: ControlPlaneSql, row: FeedbackRecord): FeedbackWritten {
  run(sql,
    `INSERT INTO cp_feedback
       (id, created_at, user_id, email, note, route, workspace,
        object_key, content_type, bytes, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    row.id, row.createdAt, row.userId, row.email,
    clampText(row.note, FEEDBACK_MAX_NOTE_CHARS),
    clampText(row.route, FEEDBACK_MAX_ROUTE_CHARS),
    row.workspace, row.objectKey, row.contentType, row.bytes,
    row.userAgent === null ? null : clampText(row.userAgent, FEEDBACK_MAX_USER_AGENT_CHARS));

  return { id: row.id };
}

export function listFeedback(sql: ControlPlaneSql, request: PageRequest = {}): Page<ControlFeedbackRow> {
  const limit = clampPage(request.limit);
  const from = readAnchor(request.cursor, 2);

  const found = select(sql, FeedbackSqlRowSchema,
    `SELECT id, created_at, user_id, email, note, route, workspace,
            object_key, content_type, bytes, user_agent
       FROM cp_feedback
      ${from ? `WHERE (created_at < ?) OR (created_at = ? AND id > ?)` : ''}
      ORDER BY created_at DESC, id ASC
      LIMIT ?`,
    ...(from ? [from[0], from[0], from[1]] : []), limit + 1);

  return seekPage(found.map(projectFeedback), limit, (row) => anchor(row.createdAt, row.id));
}

function projectFeedback(row: FeedbackSqlRow): ControlFeedbackRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    userId: row.user_id,
    email: row.email,
    note: row.note,
    route: row.route,
    workspace: row.workspace,
    objectKey: row.object_key,
    contentType: row.content_type,
    bytes: row.bytes,
    userAgent: row.user_agent,
  };
}
