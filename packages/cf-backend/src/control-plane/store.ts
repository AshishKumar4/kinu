/**
 * The control-plane feedback slice: submission writes and the operator's
 * feedback list, as functions over a `ControlPlaneSql`.
 *
 * Lives beside the producer contract (`../feedback/contract`) until that
 * contract joins core, when this folds into `@kinu.run/core/control-plane`.
 * Everything else — users, workspaces, audit, the DDL, the cursor plumbing —
 * is that module's; this file imports its primitives rather than restating
 * them.
 */
import { seekPage, type Page, type PageRequest } from '@kinu.run/core';
import {
  anchor, clampText, readAnchor, run, select,
  clampPage, type ControlPlaneSql,
} from '@kinu.run/core/control-plane';
import * as v from 'valibot';
import type { FeedbackRecord } from '../feedback/contract';
import {
  FEEDBACK_MAX_NOTE_CHARS, FEEDBACK_MAX_ROUTE_CHARS, FEEDBACK_MAX_USER_AGENT_CHARS,
} from '../feedback/contract';

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
