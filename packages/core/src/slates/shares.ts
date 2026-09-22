/** A blueprint exists exactly while its row stands unrevoked; every read asks this table again (S6). */
import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import { KinuError } from '../obs/error';
import { SHARE_KINDS, type ShareKind, type SlateShareRecord } from './sharing';

export function initSlateShareTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS slate_shares (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('blueprint')),
    publication_id TEXT NOT NULL, included_paths TEXT NOT NULL,
    created_at INTEGER NOT NULL, revoked_at INTEGER
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_share_users (
    share_id TEXT NOT NULL REFERENCES slate_shares(id), user_id TEXT NOT NULL, email TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (share_id, user_id)
  )`);
}

const ShareRow = v.object({
  id: v.string(), slate_id: v.string(), kind: v.picklist(SHARE_KINDS), publication_id: v.string(),
  included_paths: v.string(), created_at: v.number(), revoked_at: v.nullable(v.number()),
});

const UserRow = v.object({ share_id: v.string(), email: v.string() });

export interface ShareUser {
  readonly userId: string;
  readonly email: string;
}

export interface NewSlateShare {
  readonly id: string;
  readonly slate: string;
  readonly kind: ShareKind;
  readonly publication: string;
  readonly included: readonly string[];
}

export class SlateShareStore {
  constructor(private readonly db: SqlExec, private readonly now: () => number = () => Date.now()) {}

  add(share: NewSlateShare): SlateShareRecord {
    const createdAt = this.now();
    this.db.exec(
      'INSERT INTO slate_shares (id, slate_id, kind, publication_id, included_paths, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      share.id, share.slate, share.kind, share.publication, JSON.stringify(share.included), createdAt,
    );

    return { id: share.id, slate: share.slate, kind: share.kind, publication: share.publication, included: [...share.included], createdAt, revokedAt: null, users: [] };
  }

  /** The row, revoked or not. Callers that serve a viewer use `live`. */
  get(id: string): SlateShareRecord | undefined {
    const row = this.db.exec('SELECT * FROM slate_shares WHERE id = ?', id).toArray()[0];

    return row === undefined ? undefined : this.record(v.parse(ShareRow, row), this.users([id]));
  }

  /** Present and unrevoked, re-read on this call. */
  live(id: string): SlateShareRecord {
    const share = this.get(id);

    if (share === undefined) throw new KinuError('missing', 'No such blueprint');

    if (share.revokedAt !== null) throw new KinuError('denied', 'This blueprint is no longer shared');

    return share;
  }

  list(): SlateShareRecord[] {
    const rows = this.db.exec('SELECT * FROM slate_shares ORDER BY created_at DESC, id').toArray().map((row) => v.parse(ShareRow, row));
    const users = this.users(rows.map((row) => row.id));

    return rows.map((row) => this.record(row, users));
  }

  revoke(id: string): SlateShareRecord {
    const share = this.get(id);

    if (share === undefined) throw new KinuError('missing', 'No such blueprint');

    if (share.revokedAt !== null) return share;
    const revokedAt = this.now();
    this.db.exec('UPDATE slate_shares SET revoked_at = ? WHERE id = ?', revokedAt, id);

    return { ...share, revokedAt };
  }

  addUsers(id: string, users: readonly ShareUser[]): SlateShareRecord {
    const share = this.live(id);
    const createdAt = this.now();

    for (const user of users) {
      this.db.exec(
        'INSERT INTO slate_share_users (share_id, user_id, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (share_id, user_id) DO NOTHING',
        id, user.userId, user.email, createdAt,
      );
    }

    return { ...share, users: this.users([id]).filter((row) => row.share_id === id).map((row) => row.email) };
  }

  private users(ids: readonly string[]): v.InferOutput<typeof UserRow>[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');

    return this.db.exec(`SELECT share_id, email FROM slate_share_users WHERE share_id IN (${placeholders}) ORDER BY created_at, email`, ...ids)
      .toArray().map((row) => v.parse(UserRow, row));
  }

  private record(row: v.InferOutput<typeof ShareRow>, users: readonly v.InferOutput<typeof UserRow>[]): SlateShareRecord {
    return {
      id: row.id, slate: row.slate_id, kind: row.kind, publication: row.publication_id,
      included: v.parse(v.array(v.string()), JSON.parse(row.included_paths)),
      createdAt: row.created_at, revokedAt: row.revoked_at,
      users: users.filter((user) => user.share_id === row.id).map((user) => user.email),
    };
  }
}
