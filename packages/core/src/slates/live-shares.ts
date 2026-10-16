import { markStoreChanged } from '@kinu.run/agent-utils';
/** Live-share rows, separate from `slate_shares` (blueprints). `slate_viewer_requests` is the audit trail of what admission did. */
import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { ShareStore, type ShareTable } from './shares';
import { LiveShareVisibilitySchema } from './live-share-visibility';
import { ShareModeSchema } from './share-modes';
import type { LiveShareAuthority } from './share-policy';
import {
  ShareGrantSchema, ViewerCallSchema, ViewerRequestRecordSchema,
  type LiveShareRecord, type ShareGrant, type ViewerCall, type ViewerRequestRecord,
} from './sharing';

export function initSlateLiveShareTables(execRaw: RawSqlExec): void {
  // `mode` is whose access a viewer's calls act with (docs/SLATE-SHARING-NIMBUS.md §2): `own`, their own, which is
  // every share made before the column; `owner`, the owner's, approved for the one revision `grant_revision` names.
  execRaw(`CREATE TABLE IF NOT EXISTS slate_live_shares (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('users', 'public')),
    handle TEXT NOT NULL UNIQUE, grant_json TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
    mode TEXT NOT NULL DEFAULT 'own' CHECK (mode IN ('own', 'owner')), grant_revision TEXT,
    CHECK ((mode = 'owner') = (grant_revision IS NOT NULL))
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_live_share_users (
    share_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (share_id, user_id)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_viewer_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, share_id TEXT NOT NULL, viewer TEXT NOT NULL,
    path TEXT NOT NULL, calls TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER
  )`);
}

const LiveShareRow = v.object({
  id: v.string(), slate_id: v.string(), visibility: LiveShareVisibilitySchema,
  handle: v.string(), grant_json: v.string(), created_at: v.number(), revoked_at: v.nullable(v.number()),
  mode: ShareModeSchema, grant_revision: v.nullable(v.string()),
});

const AuthorityRow = v.object({ mode: ShareModeSchema, grant_json: v.string(), grant_revision: v.nullable(v.string()) });

/** Whose access a share's server acts with: the viewer's own, or the owner's, approved at one revision. */
export type ShareAuthority = { readonly mode: 'own'; readonly grantRevision: null } | { readonly mode: 'owner'; readonly grantRevision: string };

const OWN: ShareAuthority = { mode: 'own', grantRevision: null };

/** A stored request decodes straight into the record: `calls` is the one column stored as JSON text. */
const RequestRow = v.object({ ...ViewerRequestRecordSchema.entries, calls: v.pipe(v.string(), v.parseJson(), v.array(ViewerCallSchema)) });

const LIVE_SHARES: ShareTable<v.InferOutput<typeof LiveShareRow>, LiveShareRecord> = {
  shares: 'slate_live_shares',
  users: 'slate_live_share_users',
  row: LiveShareRow,
  missing: 'No such share',
  revoked: 'This slate is no longer shared',
  record: (row, users) => ({
    id: row.id, slate: row.slate_id, visibility: row.visibility, handle: row.handle,
    grant: v.parse(ShareGrantSchema, JSON.parse(row.grant_json)),
    createdAt: row.created_at, revokedAt: row.revoked_at, users, mode: row.mode, grantRevision: row.grant_revision,
  }),
};

export class SlateLiveShareStore extends ShareStore<v.InferOutput<typeof LiveShareRow>, LiveShareRecord> {
  constructor(db: SqlExec, now: () => number = () => Date.now()) {
    super(db, now, LIVE_SHARES);
  }

  add(share: { id: string; slate: string; visibility: 'users' | 'public'; handle: string; grant: ShareGrant; authority?: ShareAuthority }): LiveShareRecord {
    const createdAt = this.now();
    const authority = share.authority ?? OWN;

    this.db.exec(
      `INSERT INTO slate_live_shares (id, slate_id, visibility, handle, grant_json, created_at, revoked_at, mode, grant_revision)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      share.id, share.slate, share.visibility, share.handle, JSON.stringify(share.grant), createdAt, authority.mode, authority.grantRevision,
    );
    markStoreChanged(this.db);

    return {
      id: share.id, slate: share.slate, visibility: share.visibility, handle: share.handle,
      grant: share.grant, createdAt, revokedAt: null, users: [], mode: authority.mode, grantRevision: authority.grantRevision,
    };
  }

  /** A live share's mode set: `own`, its grant kept for a later `owner`; `owner`, with the grant its owner approved
   *  now and the revision they approved it at. A revoked share keeps what it had. */
  setAuthority(id: string, authority: ShareAuthority, grant: ShareGrant): void {
    this.db.exec(
      'UPDATE slate_live_shares SET mode = ?, grant_revision = ?, grant_json = ? WHERE id = ? AND revoked_at IS NULL',
      authority.mode, authority.grantRevision, JSON.stringify(grant), id,
    );
    markStoreChanged(this.db);
  }

  /** What each of `slate`'s live shares lets its server act with: the server's authority is read from all of them
   *  together on every call (share-policy.ts `serverAuthority`). A revoked share lends nothing. */
  authoritiesOf(slate: string): LiveShareAuthority[] {
    return this.db.exec('SELECT mode, grant_json, grant_revision FROM slate_live_shares WHERE slate_id = ? AND revoked_at IS NULL', slate).toArray()
      .map((row) => v.parse(AuthorityRow, row))
      .map((row) => ({ mode: row.mode, grant: v.parse(ShareGrantSchema, JSON.parse(row.grant_json)), grantRevision: row.grant_revision }));
  }

  /** A revoked share has no address. */
  byHandle(handle: string): LiveShareRecord | undefined {
    const row = this.db.exec('SELECT * FROM slate_live_shares WHERE handle = ? AND revoked_at IS NULL', handle).toArray()[0];

    if (row === undefined) return undefined;
    const parsed = v.parse(LiveShareRow, row);

    return this.record(parsed, this.users([parsed.id]));
  }

  hasUser(id: string, userId: string): boolean {
    return this.db.exec('SELECT user_id FROM slate_live_share_users WHERE share_id = ? AND user_id = ?', id, userId)
      .toArray().length > 0;
  }

  /** The returned row id is the request number later calls record against. */
  openRequest(input: { share: string; viewer: string; path: string }): number {
    const createdAt = this.now();

    const row = this.db.exec(
      'INSERT INTO slate_viewer_requests (share_id, viewer, path, calls, outcome, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, NULL) RETURNING id',
      input.share, input.viewer, input.path, '[]', 'open', createdAt,
    ).toArray()[0];

    return v.parse(v.object({ id: v.number() }), row).id;
  }

  recordCall(request: number, call: ViewerCall): void {
    return settleSync(Effect.suspend(() => {
      const row = this.db.exec('SELECT calls FROM slate_viewer_requests WHERE id = ?', request).toArray()[0];

      if (row === undefined) return Effect.fail(new KinuError('missing', `No viewer request ${request}`));
      const calls = v.parse(v.array(ViewerCallSchema), JSON.parse(v.parse(v.object({ calls: v.string() }), row).calls));
      calls.push(call);
      this.db.exec('UPDATE slate_viewer_requests SET calls = ? WHERE id = ?', JSON.stringify(calls), request);

      return Effect.void;
    }));
  }

  settleRequest(request: number, outcome: string): void {
    this.db.exec('UPDATE slate_viewer_requests SET outcome = ?, settled_at = ? WHERE id = ?', outcome, this.now(), request);
  }

  requests(share: string): ViewerRequestRecord[] {
    return this.db.exec(`SELECT r.id, r.share_id AS share, r.viewer, s.slate_id AS slate, r.path, r.calls, r.outcome,
      r.created_at AS createdAt, r.settled_at AS settledAt
      FROM slate_viewer_requests r JOIN slate_live_shares s ON s.id = r.share_id
      WHERE r.share_id = ? ORDER BY r.id DESC`, share)
      .toArray().map((row) => v.parse(RequestRow, row));
  }
}
