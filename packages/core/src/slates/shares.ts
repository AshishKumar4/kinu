import { markStoreChanged } from '@kinu.run/agent-utils';
/** A share exists exactly while its row stands unrevoked; every read asks this table again (S6). */
import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { SHARE_KINDS, type ShareKind, type SlateShareRecord } from './sharing';
import { sqlCheckList } from '../utils/sql';

export function initSlateShareTables(execRaw: RawSqlExec): void {
  // One id for every share of either kind, so a revoke, a card or a job that names a share by id names one. A blueprint
  // holds its `publication_id`, whose materialization is what it includes. A live share holds the rest:
  // - `mode` is whose access a viewer's calls act with (docs/SLATE-SHARING-NIMBUS.md §2): `own`, their own; `owner`, the
  //   owner's, approved for the one revision `grant_revision` names.
  // - `listing_*` are the Gallery card's words its owner wrote, while it is listed: the Gallery's index is their copy
  //   (gallery.ts), and only an `own` share is ever listed. The categories are gallery-api.ts `GALLERY_CATEGORIES`.
  execRaw(`CREATE TABLE IF NOT EXISTS slate_shares (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN (${sqlCheckList(SHARE_KINDS)})), slate_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, revoked_at INTEGER,
    publication_id TEXT,
    visibility TEXT CHECK (visibility IN ('users', 'public')), handle TEXT UNIQUE, grant_json TEXT,
    mode TEXT CHECK (mode IN ('own', 'owner')), grant_revision TEXT,
    listing_line TEXT,
    listing_category TEXT CHECK (listing_category IS NULL OR listing_category IN ('work', 'money', 'home', 'developer', 'fun')),
    CHECK ((kind = 'blueprint' AND publication_id IS NOT NULL AND visibility IS NULL AND handle IS NULL AND grant_json IS NULL
        AND mode IS NULL AND grant_revision IS NULL AND listing_line IS NULL AND listing_category IS NULL)
      OR (kind = 'live' AND publication_id IS NULL AND visibility IS NOT NULL AND handle IS NOT NULL AND grant_json IS NOT NULL
        AND mode IS NOT NULL)),
    CHECK ((mode = 'owner') = (grant_revision IS NOT NULL)),
    CHECK ((listing_line IS NULL) = (listing_category IS NULL)),
    CHECK (listing_line IS NULL OR mode = 'own')
  )`);
  // The people a share is given to. `role`, a live share's: `use`, the slate as it is; `edit`, its files too
  // (docs/SLATE-SHARING-NIMBUS.md §2), written in this workspace and built from the slate's own tree. A blueprint's
  // people use it.
  execRaw(`CREATE TABLE IF NOT EXISTS slate_share_users (
    share_id TEXT NOT NULL REFERENCES slate_shares(id), user_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'use' CHECK (role IN ('use', 'edit')),
    PRIMARY KEY (share_id, user_id)
  )`);
}

const ShareRow = v.object({
  id: v.string(), slate_id: v.string(), publication_id: v.string(), created_at: v.number(), revoked_at: v.nullable(v.number()),
});

const UserRow = v.object({ share_id: v.string(), email: v.string() });

type UserRowOf = v.InferOutput<typeof UserRow>;

export interface ShareTable<Row, Rec> {
  readonly kind: ShareKind;
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
    const row = this.db.exec('SELECT * FROM slate_shares WHERE id = ? AND kind = ?', id, this.table.kind).toArray()[0];

    return row === undefined ? undefined : this.record(v.parse(this.table.row, row), this.users([id]));
  }

  /** Present and unrevoked, re-read on this call. */
  live(id: string): Rec {
    return settleSync(Effect.suspend(() => {
      const share = this.get(id);

      if (share === undefined) return Effect.fail(new KinuError('missing', this.table.missing));

      return share.revokedAt === null ? Effect.succeed(share) : Effect.fail(new KinuError('denied', this.table.revoked));
    }));
  }

  /** A deleted account's memberships, in every share here, by its id or its email (lower-cased). */
  forgetUser(person: { readonly userId: string; readonly email: string }): void {
    this.db.exec(`DELETE FROM slate_share_users WHERE (user_id = ? OR lower(email) = ?) AND share_id IN (SELECT id FROM slate_shares WHERE kind = ?)`,
      person.userId, person.email, this.table.kind);
    // What reads the shares rebuilds from these tables, so no cached overview names them again.
    markStoreChanged(this.db);
  }

  list(): Rec[] {
    const rows = this.db.exec('SELECT * FROM slate_shares WHERE kind = ? ORDER BY created_at DESC, id', this.table.kind).toArray()
      .map((row) => v.parse(this.table.row, row));

    const users = this.users(rows.map((row) => row.id));

    return rows.map((row) => this.record(row, users));
  }

  revoke(id: string): Rec {
    return settleSync(Effect.suspend(() => {
      const share = this.get(id);

      if (share === undefined) return Effect.fail(new KinuError('missing', this.table.missing));

      if (share.revokedAt !== null) return Effect.succeed(share);
      const revokedAt = this.now();
      this.db.exec('UPDATE slate_shares SET revoked_at = ? WHERE id = ?', revokedAt, id);
      // A revoked share has no members: nothing reads them after, and none of them is kept naming a person.
      this.db.exec('DELETE FROM slate_share_users WHERE share_id = ?', id);
      markStoreChanged(this.db);

      // Read back, as every record is: what a revoke ends (a live share's listing) is the row's to say.
      return Effect.succeed(this.get(id) ?? { ...share, revokedAt });
    }));
  }

  /** People added to the share; one added again keeps their row and takes the role named now (a live share's). */
  addUsers(id: string, users: readonly ShareUser[]): Rec {
    this.live(id);
    const createdAt = this.now();

    for (const user of users) {
      this.db.exec(
        `INSERT INTO slate_share_users (share_id, user_id, email, role, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (share_id, user_id) DO UPDATE SET role = excluded.role`,
        id, user.userId, user.email, this.table.kind === 'live' ? user.role ?? 'use' : 'use', createdAt,
      );
      markStoreChanged(this.db);
    }

    // Read back, as every record is: who it is given to, and in what role, is the rows' to say.
    return this.live(id);
  }

  protected users(ids: readonly string[]): UserRowOf[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');

    return this.db.exec(`SELECT share_id, email FROM slate_share_users WHERE share_id IN (${placeholders}) ORDER BY created_at, email`, ...ids)
      .toArray().map((row) => v.parse(UserRow, row));
  }

  protected record(row: Row, users: readonly UserRowOf[]): Rec {
    return this.table.record(row, users.filter((user) => user.share_id === row.id).map((user) => user.email));
  }
}

const BLUEPRINT_SHARES: ShareTable<v.InferOutput<typeof ShareRow>, SlateShareRecord> = {
  kind: 'blueprint',
  row: ShareRow,
  missing: 'No such blueprint',
  revoked: 'This blueprint is no longer shared',
  record: (row, users) => ({
    id: row.id, slate: row.slate_id, publication: row.publication_id, createdAt: row.created_at, revokedAt: row.revoked_at, users,
  }),
};

export interface ShareUser {
  readonly userId: string;
  readonly email: string;
  /** A live share's: whether they use the slate or edit it too; `use` when absent. A blueprint's ignores it. */
  readonly role?: 'use' | 'edit';
}

export interface NewSlateShare {
  readonly id: string;
  readonly slate: string;
  readonly publication: string;
}

export class SlateShareStore extends ShareStore<v.InferOutput<typeof ShareRow>, SlateShareRecord> {
  constructor(db: SqlExec, now: () => number = () => Date.now()) {
    super(db, now, BLUEPRINT_SHARES);
  }

  add(share: NewSlateShare): SlateShareRecord {
    const createdAt = this.now();
    this.db.exec(
      "INSERT INTO slate_shares (id, kind, slate_id, publication_id, created_at) VALUES (?, 'blueprint', ?, ?, ?)",
      share.id, share.slate, share.publication, createdAt,
    );
    markStoreChanged(this.db);

    return { id: share.id, slate: share.slate, publication: share.publication, createdAt, revokedAt: null, users: [] };
  }
}
