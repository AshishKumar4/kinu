/**
 * The public share index: what the Shared page's "Public" list reads.
 *
 * A PROJECTION, never an authority — the idiom `preview/preview-exposures.ts`
 * states for previews. A row names (owner, workspace, share, kind, title) and
 * never visibility, because visibility has one home, the share row in the
 * owner's workspace object, and every open asks that object again. A stale
 * row here can therefore list something that then refuses; it can never admit
 * anything. It lives on the control plane because the question is fleet-wide:
 * "what is public" has no per-user shard that could answer it.
 */
import * as v from 'valibot';
import type { ControlPlaneSql } from './sql';

const DDL = `CREATE TABLE IF NOT EXISTS cp_public_shares (
  owner_user_id TEXT NOT NULL,
  owner_email   TEXT NOT NULL,
  workspace     TEXT NOT NULL,
  share_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, workspace, share_id)
)`;

export function initPublicShareIndex(sql: ControlPlaneSql): void {
  sql.exec(DDL);
}

export const PublicShareRowSchema = v.object({
  ownerUserId: v.string(),
  ownerEmail: v.string(),
  workspace: v.string(),
  shareId: v.string(),
  kind: v.picklist(['blueprint', 'live']),
  title: v.string(),
  createdAt: v.number(),
});

export type PublicShareRow = v.InferOutput<typeof PublicShareRowSchema>;

export interface PublicShareKey {
  readonly ownerUserId: string;
  readonly workspace: string;
  readonly shareId: string;
}

const StoredRow = v.object({
  owner_user_id: v.string(), owner_email: v.string(), workspace: v.string(), share_id: v.string(),
  kind: v.picklist(['blueprint', 'live']), title: v.string(), created_at: v.number(),
});

/** Upsert one row; the title and the owner's email follow the latest write. */
export function indexPublicShare(sql: ControlPlaneSql, row: PublicShareRow): void {
  sql.exec(
    `INSERT INTO cp_public_shares (owner_user_id, owner_email, workspace, share_id, kind, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_user_id, workspace, share_id) DO UPDATE SET
       owner_email = excluded.owner_email, title = excluded.title, kind = excluded.kind`,
    row.ownerUserId, row.ownerEmail, row.workspace, row.shareId, row.kind, row.title, row.createdAt,
  );
}

export function forgetPublicShare(sql: ControlPlaneSql, key: PublicShareKey): void {
  sql.exec(
    'DELETE FROM cp_public_shares WHERE owner_user_id = ? AND workspace = ? AND share_id = ?',
    key.ownerUserId, key.workspace, key.shareId,
  );
}

/** Newest first. `limit` bounds a page the reader then verifies row by row
 *  against each owner's object, so a large index costs the reader, not this
 *  query. */
export function listPublicShares(sql: ControlPlaneSql, limit = 200): PublicShareRow[] {
  return sql.exec('SELECT * FROM cp_public_shares ORDER BY created_at DESC, share_id LIMIT ?', limit).toArray()
    .map((raw) => {
      const row = v.parse(StoredRow, raw);

      return {
        ownerUserId: row.owner_user_id, ownerEmail: row.owner_email, workspace: row.workspace,
        shareId: row.share_id, kind: row.kind, title: row.title, createdAt: row.created_at,
      };
    });
}
