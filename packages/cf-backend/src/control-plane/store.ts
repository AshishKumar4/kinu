/**
 * The control-plane index and audit log, as functions over a `SqlExec`.
 *
 * Split from the Durable Object for the same reason `monitor/incidents.ts` is
 * split from `MonitorDO`: everything here is our own logic — cursor anchors,
 * upsert semantics, tombstones, the audit append — and none of it needs an
 * actor. So it is testable against a real SQLite database rather than against a
 * fake of the object that hosts it, and `ControlPlaneDO` is left holding exactly
 * two things it cannot delegate: the capability gate and the storage handle.
 *
 * WHAT IS DERIVED AND WHAT IS NOT. Every row except the audit log is a copy of
 * state a UserDO owns, which is what makes a stale row a performance problem
 * rather than a correctness one and what lets `replaceUserWorkspaces` repair one
 * account from its source at any moment. The audit log is this store's own
 * primary record, and it has no update and no delete path anywhere in this file —
 * an audit log an admin can edit is a diary.
 */
import { seekPage, type Page, type PageRequest } from '@kinu.run/core';
import * as v from 'valibot';
import type { ControlPlaneSql, ControlPlaneSqlValue } from './sql';
import type { FeedbackRecord } from '../feedback/contract';
import {
  FEEDBACK_MAX_NOTE_CHARS, FEEDBACK_MAX_ROUTE_CHARS, FEEDBACK_MAX_USER_AGENT_CHARS,
} from '../feedback/contract';

export type { ControlPlaneSql } from './sql';

/** Page sizes. `MAX` is a per-page ceiling, not a total: every list here is
 *  cursored, so a caller reaches row 5,000 by walking pages. A read that could
 *  only ever return its first 200 rows would be a silent truncation, which is the
 *  defect this repo's paging contract exists to prevent. */
export const CONTROL_PAGE_DEFAULT = 50;
export const CONTROL_PAGE_MAX = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

const DDL = [
  // A user this deployment has seen sign in. `email` is the verified address from
  // the identity provider and the only human-readable handle an operator has for
  // an account, so it is stored rather than digested.
  `CREATE TABLE IF NOT EXISTS cp_users (
     user_id       TEXT PRIMARY KEY,
     email         TEXT    NOT NULL,
     display_name  TEXT,
     first_seen_at INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS cp_users_seen ON cp_users (last_seen_at DESC, user_id)`,
  // Keyed by (owner, name), because a workspace name is unique WITHIN a UserDO
  // and nowhere else — two accounts can both own `research`. Keying on the name
  // alone would have one user's row overwrite another's, which is a cross-user
  // data leak inside an admin list.
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
  // Feedback metadata. The column list is `FeedbackRecord`, whose producer owns
  // the shape; it is not restated as a second declaration anywhere.
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

/* ── Row shapes crossing the RPC boundary ────────────────────────────────── */

export interface ControlUserRow {
  userId: string;
  email: string;
  displayName: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Live workspaces this account owns, per the index. */
  workspaces: number;
}

export interface ControlWorkspaceRow {
  userId: string;
  /** The owner's address, or empty when a workspace was indexed before its
   *  owner's first observation landed. Stated rather than faked. */
  email: string;
  name: string;
  displayName: string;
  createdAt: number;
  lastSeenAt: number;
  removedAt: number | null;
}

export type ControlFeedbackRow = FeedbackRecord;

/** What an operator did. `denied` and `failed` are kept apart because a refused
 *  attempt and a broken one are different facts, and pooling them makes both
 *  useless.
 *
 *  `pending` is the INTENT, written before the mutation runs. A row that is
 *  still pending is the evidence that an action was attempted and its result was
 *  never recorded — which is a fact an operator surface must be able to show,
 *  and the reason the write happens first. */
export const AUDIT_OUTCOMES = ['pending', 'ok', 'denied', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** The outcomes an attempt can SETTLE on. `pending` is excluded by
 *  construction, so a settlement cannot write the row back to unfinished. */
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
  /** Specifics an operator can act on — a job id, a refusal reason, an affected
   *  count. Never a credential: nothing on this path holds one. */
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
  /** The registry's own creation timestamp when the feed has it, so the index
   *  does not claim a workspace was created the first time somebody opened it. */
  createdAt?: number;
  at?: number;
}

/** The subset of a roster entry the index stores. */
export interface RosterWorkspace {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
}

/* ── SQL row shapes ──────────────────────────────────────────────────────── */

// One schema per table, applied on every read. `monitor/incidents.ts` declares
// its `IncidentRowSchema` the same way and for the same reason: a durable row's
// column set is a runtime fact.
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

// `outcome` is read as a plain string and narrowed in `projectAudit`, so a
// hand-edited database reads as `failed` rather than throwing a parse error at
// an operator who is trying to read the log.
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

/* ── Paging ──────────────────────────────────────────────────────────────── */

function clampPage(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CONTROL_PAGE_DEFAULT;
  return Math.min(CONTROL_PAGE_MAX, Math.max(1, Math.trunc(limit)));
}

/**
 * A cursor anchor over a (descending timestamp, ascending tiebreak) ordering.
 *
 * One opaque string, because that is what `SeekCursor` carries. The tiebreak is
 * mandatory: `last_seen_at` is a millisecond clock and two rows written in the
 * same millisecond are not hypothetical when a feed observes a batch. Without it
 * a page boundary landing inside a tie would skip or repeat rows, which is the
 * paging defect hardest to notice.
 */
function anchor(at: number, ...tiebreak: string[]): string {
  return [String(at), ...tiebreak].join('\u0000');
}

/** Raised when a cursor cannot be decoded. Thrown rather than treated as "start
 *  from the beginning": restarting a walk from the top looks like success and
 *  silently repeats every row already seen. */
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

/** Bound a text column at the width the contract declares. The producer clamps
 *  too; this is the store declining to hold a row wider than its own shape, so a
 *  future writer cannot widen it by forgetting. */
function clampText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Run a statement that returns nothing worth reading.
 *
 * Separate from `select` so a write never has to name a row schema it does not
 * have, and so the reads are visibly the only place a schema is applied.
 */
function run(sql: ControlPlaneSql, query: string, ...bindings: ControlPlaneSqlValue[]): void {
  sql.exec(query, ...bindings);
}

/**
 * Run a query and PARSE its rows.
 *
 * Parsed rather than asserted, and this is not ceremony: these rows come out of
 * durable storage that earlier versions of this code wrote, so the column set a
 * row actually has is a runtime fact rather than a compile-time one. An assertion
 * would fabricate the shape and then trust it — which is exactly how a workspace
 * failed on a `no such column` after a table gained one.
 */
function select<Row>(
  sql: ControlPlaneSql, schema: v.GenericSchema<Row>, query: string, ...bindings: ControlPlaneSqlValue[]
): Row[] {
  return v.parse(v.array(schema), sql.exec(query, ...bindings).toArray());
}

const CountRowSchema = v.object({ n: v.number() });

function count(sql: ControlPlaneSql, query: string, ...bindings: ControlPlaneSqlValue[]): number {
  return select(sql, CountRowSchema, query, ...bindings)[0]?.n ?? 0;
}

/* ── Feeds ───────────────────────────────────────────────────────────────── */

/**
 * Record that an account exists and was seen.
 *
 * Upsert rather than insert-or-ignore: `last_seen_at` is what the users list is
 * ordered by, and `email` is refreshed because a provider can change the verified
 * address behind a stable subject.
 */
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

/** Record that a workspace exists under an account. Resurrects a row the index
 *  had tombstoned, because a same-name recreate is a live workspace and the
 *  registry treats it as one. */
export function observeWorkspace(
  sql: ControlPlaneSql, observation: WorkspaceObservation, now = Date.now(),
): void {
  const at = observation.at ?? now;
  run(sql,
    `INSERT INTO cp_workspaces (user_id, name, display_name, created_at, last_seen_at, removed_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(user_id, name) DO UPDATE SET
       display_name = excluded.display_name,
       created_at = MIN(cp_workspaces.created_at, excluded.created_at),
       last_seen_at = MAX(cp_workspaces.last_seen_at, excluded.last_seen_at),
       removed_at = NULL`,
    observation.userId, observation.name, observation.displayName,
    observation.createdAt ?? at, at);
}

/** Record that a workspace was used, without claiming its title.
 *
 * The ownership-gated use feed only knows the slug from the request path, so
 * it leaves a supplied title alone. Writing the slug as the title reset every
 * renamed workspace on next open. New rows still take the slug until a feed
 * that knows the title writes one. */
export function touchWorkspace(
  sql: ControlPlaneSql, observation: WorkspaceObservation, now = Date.now(),
): void {
  const at = observation.at ?? now;
  run(sql,
    `INSERT INTO cp_workspaces (user_id, name, display_name, created_at, last_seen_at, removed_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(user_id, name) DO UPDATE SET
       last_seen_at = MAX(cp_workspaces.last_seen_at, excluded.last_seen_at),
       removed_at = NULL`,
    observation.userId, observation.name, observation.displayName,
    observation.createdAt ?? at, at);
}

/**
 * Mark a workspace gone.
 *
 * A tombstone, not a delete. The row is how an operator answers "what happened
 * to it" afterwards, and the workspace it described is already unrecoverable — so
 * dropping the row would destroy the only remaining evidence it existed.
 */
export function forgetWorkspace(
  sql: ControlPlaneSql, target: { userId: string; name: string; at?: number }, now = Date.now(),
): void {
  run(sql,
    `UPDATE cp_workspaces SET removed_at = ?
     WHERE user_id = ? AND name = ? AND removed_at IS NULL`,
    target.at ?? now, target.userId, target.name);
}

/** Store one feedback submission's metadata. The screenshot bytes are already in
 *  R2 and are not touched here: the row carries `objectKey` and this store never
 *  holds an image. */
/** What a stored submission answers with: the id the producer minted, echoed so
 *  the caller has one value to treat as its commit acknowledgement. */
export interface FeedbackWritten { id: string }

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

/**
 * Replace one account's workspace rows from the registry that owns them.
 *
 * This is what makes the index safe to be incomplete: the feeds are best-effort
 * observations from the request path, and this reads through to the source of
 * truth and settles the difference, so a missed feed is never permanent and no
 * reconciliation job has to exist.
 *
 * Rows absent from `live` are tombstoned rather than deleted. An empty `live` is
 * NOT an early return: an account whose last workspace was removed must stop
 * showing rows.
 */
/** What a reconcile settled: how many rows the registry still has, and how many
 *  the index had that it no longer does. */
export interface ReconcileOutcome {
  present: number;
  tombstoned: number;
}

export function replaceUserWorkspaces(
  sql: ControlPlaneSql, userId: string, live: readonly RosterWorkspace[], now = Date.now(),
): ReconcileOutcome {
  for (const row of live) {
    // Keep last_seen_at monotone. The use feed advances this clock on
    // observations the registry never sees, so an overwrite moves it backwards.
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

/* ── Reads ───────────────────────────────────────────────────────────────── */

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

/** Accounts, most recently seen first. `workspaces` is counted per row rather
 *  than denormalized, so the number cannot drift from the rows it summarizes. */
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

/** Which workspaces a list should carry. Named because the store, the Durable
 *  Object and the route all pass it, and three restatements of one filter is how
 *  a fourth reader gets it wrong. */
export interface WorkspaceFilter {
  userId?: string;
  /** Defaults false so the common list is live workspaces; the tombstones are
   *  what an operator asks for deliberately. */
  includeRemoved?: boolean;
}

/** Workspaces across every account, or one account's when `userId` is given. */
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

/* ── The audit log's only writers ────────────────────────────────────────── */

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
 * Append one attempt.
 *
 * INSERT only, and every column it writes is written once: who acted, when, on
 * what. That is what append-only means for the part of the row that matters —
 * the record of the ATTEMPT can never be edited or removed, because the only
 * other statement in this file that touches `cp_audit` settles an outcome and
 * cannot reach any of those columns.
 *
 * THE ID AND THE CLOCK ARE THIS FUNCTION'S, never the draft's. A caller that
 * could choose the primary key of an append-only log could collide with a row
 * already in it, and one that could choose `at` could date an attempt into the
 * past. No caller needs either — `recordAudit` is the only writer and supplies
 * neither — and a test that needs a fixed clock passes `now`.
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
 * Settle a pending attempt.
 *
 * `WHERE outcome = 'pending'` is the whole safety property: an already-settled
 * row cannot be rewritten, so a replayed or duplicated settlement is a no-op
 * rather than a way to edit history. Nothing else in this file updates
 * `cp_audit`, and this statement names only `outcome` and `detail` — the actor,
 * the operation, the target and the timestamp stay exactly as the attempt wrote
 * them.
 *
 * Returns the settled row, or `null` when there was no pending row to settle —
 * which the caller must treat as a fact rather than as success, because it means
 * the attempt it thought it was finishing is not the row in this table.
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

/** Attempts whose outcome was never recorded. An operator reads this to find
 *  the actions that ran against a workspace while the audit log could not be
 *  finished — the one class of row this design deliberately leaves behind
 *  instead of hiding. */
export function listPendingAudit(sql: ControlPlaneSql, limit = CONTROL_PAGE_DEFAULT): ControlAuditRow[] {
  return select(sql, AuditSqlRowSchema,
    `SELECT id, at, actor_email, actor_user, operation, target_kind, target, outcome, detail
       FROM cp_audit WHERE outcome = 'pending' ORDER BY at DESC, id ASC LIMIT ?`,
    clampPage(limit)).map(projectAudit);
}

/* ── Projections ─────────────────────────────────────────────────────────── */

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

function projectAudit(row: AuditSqlRow): ControlAuditRow {
  return {
    id: row.id,
    at: row.at,
    actorEmail: row.actor_email,
    actorUserId: row.actor_user,
    operation: row.operation,
    targetKind: row.target_kind,
    target: row.target,
    // Written by `appendAudit` and `settleAudit` only, from a closed union —
    // narrowed on read so a hand-edited database cannot widen the type.
    outcome: AUDIT_OUTCOMES.find((known) => known === row.outcome) ?? 'failed',
    detail: row.detail,
  };
}
