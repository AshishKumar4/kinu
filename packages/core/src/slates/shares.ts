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

type UserRowOf = v.InferOutput<typeof UserRow>;

export interface ShareTable<Row, Rec> {
  readonly shares: string;
  readonly users: string;
  readonly row: v.GenericSchema<unknown, Row>;
  readonly missing: string;
  readonly revoked: string;
  readonly record: (row: Row, users: string[]) => Rec;
}

export class ShareStore<Row extends { id: string }, Rec extends { revokedAt: number | null; users: string[] }> {
  constructor(
    protected readonly db: SqlExec,
    protected readonly now: () => number,
    private readonly table: ShareTable<Row, Rec>,
  ) {}

  /** The row, revoked or not. Callers that serve a viewer use `live`. */
  get(id: string): Rec | undefined {
    const row = this.db.exec(`SELECT * FROM ${this.table.shares} WHERE id = ?`, id).toArray()[0];

    return row === undefined ? undefined : this.record(v.parse(this.table.row, row), this.users([id]));
  }

  /** Present and unrevoked, re-read on this call. */
  live(id: string): Rec {
    const share = this.get(id);

    if (share === undefined) throw new KinuError('missing', this.table.missing);

    if (share.revokedAt !== null) throw new KinuError('denied', this.table.revoked);

    return share;
  }

  list(): Rec[] {
    const rows = this.db.exec(`SELECT * FROM ${this.table.shares} ORDER BY created_at DESC, id`).toArray()
      .map((row) => v.parse(this.table.row, row));

    const users = this.users(rows.map((row) => row.id));

    return rows.map((row) => this.record(row, users));
  }

  revoke(id: string): Rec {
    const share = this.get(id);

    if (share === undefined) throw new KinuError('missing', this.table.missing);

    if (share.revokedAt !== null) return share;
    const revokedAt = this.now();
    this.db.exec(`UPDATE ${this.table.shares} SET revoked_at = ? WHERE id = ?`, revokedAt, id);

    return { ...share, revokedAt };
  }

  addUsers(id: string, users: readonly ShareUser[]): Rec {
    const share = this.live(id);
    const createdAt = this.now();

    for (const user of users) {
      this.db.exec(
        `INSERT INTO ${this.table.users} (share_id, user_id, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (share_id, user_id) DO NOTHING`,
        id, user.userId, user.email, createdAt,
      );
    }

    return { ...share, users: this.users([id]).filter((row) => row.share_id === id).map((row) => row.email) };
  }

  protected users(ids: readonly string[]): UserRowOf[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');

    return this.db.exec(`SELECT share_id, email FROM ${this.table.users} WHERE share_id IN (${placeholders}) ORDER BY created_at, email`, ...ids)
      .toArray().map((row) => v.parse(UserRow, row));
  }

  protected record(row: Row, users: readonly UserRowOf[]): Rec {
    return this.table.record(row, users.filter((user) => user.share_id === row.id).map((user) => user.email));
  }
}

const BLUEPRINT_SHARES: ShareTable<v.InferOutput<typeof ShareRow>, SlateShareRecord> = {
  shares: 'slate_shares',
  users: 'slate_share_users',
  row: ShareRow,
  missing: 'No such blueprint',
  revoked: 'This blueprint is no longer shared',
  record: (row, users) => ({
    id: row.id, slate: row.slate_id, kind: row.kind, publication: row.publication_id,
    included: v.parse(v.array(v.string()), JSON.parse(row.included_paths)),
    createdAt: row.created_at, revokedAt: row.revoked_at, users,
  }),
};

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

export class SlateShareStore extends ShareStore<v.InferOutput<typeof ShareRow>, SlateShareRecord> {
  constructor(db: SqlExec, now: () => number = () => Date.now()) {
    super(db, now, BLUEPRINT_SHARES);
  }

  add(share: NewSlateShare): SlateShareRecord {
    const createdAt = this.now();
    this.db.exec(
      'INSERT INTO slate_shares (id, slate_id, kind, publication_id, included_paths, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      share.id, share.slate, share.kind, share.publication, JSON.stringify(share.included), createdAt,
    );

    return { id: share.id, slate: share.slate, kind: share.kind, publication: share.publication, included: [...share.included], createdAt, revokedAt: null, users: [] };
  }
}
