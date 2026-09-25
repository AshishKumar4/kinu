/** Live-share rows, separate from `slate_shares` (blueprints). `slate_viewer_requests` is the audit trail of what admission did. */
import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import { KinuError } from '../obs/error';
import { ShareStore, type ShareTable } from './shares';
import { LiveShareVisibilitySchema } from './live-share-visibility';
import {
  ShareGrantSchema, ViewerCallSchema,
  type LiveShareRecord, type ShareGrant, type ViewerCall, type ViewerRequestRecord,
} from './sharing';

export function initSlateLiveShareTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS slate_live_shares (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('users', 'public')),
    handle TEXT NOT NULL UNIQUE, grant_json TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_live_share_users (
    share_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (share_id, user_id)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_viewer_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, share_id TEXT NOT NULL, viewer TEXT NOT NULL, slate_id TEXT NOT NULL,
    path TEXT NOT NULL, calls TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER
  )`);
}

const LiveShareRow = v.object({
  id: v.string(), slate_id: v.string(), visibility: LiveShareVisibilitySchema,
  handle: v.string(), grant_json: v.string(), created_at: v.number(), revoked_at: v.nullable(v.number()),
});

const RequestRow = v.object({
  id: v.number(), share_id: v.string(), viewer: v.string(), slate_id: v.string(), path: v.string(),
  calls: v.string(), outcome: v.string(), created_at: v.number(), settled_at: v.nullable(v.number()),
});

const LIVE_SHARES: ShareTable<v.InferOutput<typeof LiveShareRow>, LiveShareRecord> = {
  shares: 'slate_live_shares',
  users: 'slate_live_share_users',
  row: LiveShareRow,
  missing: 'No such share',
  revoked: 'This slate is no longer shared',
  record: (row, users) => ({
    id: row.id, slate: row.slate_id, visibility: row.visibility, handle: row.handle,
    grant: v.parse(ShareGrantSchema, JSON.parse(row.grant_json)),
    createdAt: row.created_at, revokedAt: row.revoked_at, users,
  }),
};

export class SlateLiveShareStore extends ShareStore<v.InferOutput<typeof LiveShareRow>, LiveShareRecord> {
  constructor(db: SqlExec, now: () => number = () => Date.now()) {
    super(db, now, LIVE_SHARES);
  }

  add(share: { id: string; slate: string; visibility: 'users' | 'public'; handle: string; grant: ShareGrant }): LiveShareRecord {
    const createdAt = this.now();
    this.db.exec(
      'INSERT INTO slate_live_shares (id, slate_id, visibility, handle, grant_json, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      share.id, share.slate, share.visibility, share.handle, JSON.stringify(share.grant), createdAt,
    );

    return {
      id: share.id, slate: share.slate, visibility: share.visibility, handle: share.handle,
      grant: share.grant, createdAt, revokedAt: null, users: [],
    };
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
  openRequest(input: { share: string; viewer: string; slate: string; path: string }): number {
    const createdAt = this.now();

    const row = this.db.exec(
      'INSERT INTO slate_viewer_requests (share_id, viewer, slate_id, path, calls, outcome, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) RETURNING id',
      input.share, input.viewer, input.slate, input.path, '[]', 'open', createdAt,
    ).toArray()[0];

    return v.parse(v.object({ id: v.number() }), row).id;
  }

  recordCall(request: number, call: ViewerCall): void {
    const row = this.db.exec('SELECT calls FROM slate_viewer_requests WHERE id = ?', request).toArray()[0];

    if (row === undefined) throw new KinuError('missing', `No viewer request ${request}`);
    const calls = v.parse(v.array(ViewerCallSchema), JSON.parse(v.parse(v.object({ calls: v.string() }), row).calls));
    calls.push(call);
    this.db.exec('UPDATE slate_viewer_requests SET calls = ? WHERE id = ?', JSON.stringify(calls), request);
  }

  settleRequest(request: number, outcome: string): void {
    this.db.exec('UPDATE slate_viewer_requests SET outcome = ?, settled_at = ? WHERE id = ?', outcome, this.now(), request);
  }

  requests(share: string): ViewerRequestRecord[] {
    return this.db.exec('SELECT * FROM slate_viewer_requests WHERE share_id = ? ORDER BY id DESC', share)
      .toArray().map((row) => this.request(v.parse(RequestRow, row)));
  }

  private request(row: v.InferOutput<typeof RequestRow>): ViewerRequestRecord {
    return {
      id: row.id, share: row.share_id, viewer: row.viewer, slate: row.slate_id, path: row.path,
      calls: v.parse(v.array(ViewerCallSchema), JSON.parse(row.calls)),
      outcome: row.outcome, createdAt: row.created_at, settledAt: row.settled_at,
    };
  }
}
