/**
 * The public share index: a projection, never an authority, since visibility
 * lives on the owner's share row. Nothing reads it yet.
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
