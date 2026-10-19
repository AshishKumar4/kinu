import { markStoreChanged } from '@kinu.run/agent-utils';
/** Live-share rows, separate from `slate_shares` (blueprints). `slate_viewer_requests` is the audit trail of what admission did. */
import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { ShareStore, type ShareTable, type ShareUser } from './shares';
import { LiveShareVisibilitySchema } from './live-share-visibility';
import { ShareModeSchema, type ShareMode } from './share-modes';
import { canonicalRoot, type LiveShareAuthority } from './share-policy';
import { GalleryCategorySchema, type GalleryCategory } from './gallery-api';
import {
  ShareGrantSchema, ViewerCallSchema, ViewerRequestRecordSchema,
  type LiveShareRecord, type ShareGrant, type SharePreapproval, type ShareViews, type ViewerCall, type ViewerRequestRecord,
} from './sharing';

/** One standing approval's shape of call, whatever revision it was given at. */
function preapprovalKey(entry: Omit<SharePreapproval, 'revision'>): string {
  return JSON.stringify([entry.slate, entry.namespace, entry.member, canonicalRoot(entry.root)]);
}

export function initSlateLiveShareTables(execRaw: RawSqlExec): void {
  // `mode` is whose access a viewer's calls act with (docs/SLATE-SHARING-NIMBUS.md §2): `own`, their own, which is
  // every share made before the column; `owner`, the owner's, approved for the one revision `grant_revision` names.
  // `listing_*` are the Gallery card's words its owner wrote, while it is listed: the Gallery's index is their copy
  // (gallery.ts), and only an `own` share is ever listed. The categories are gallery-api.ts `GALLERY_CATEGORIES`.
  execRaw(`CREATE TABLE IF NOT EXISTS slate_live_shares (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('users', 'public')),
    handle TEXT NOT NULL UNIQUE, grant_json TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
    mode TEXT NOT NULL DEFAULT 'own' CHECK (mode IN ('own', 'owner')), grant_revision TEXT,
    listing_line TEXT,
    listing_category TEXT CHECK (listing_category IS NULL OR listing_category IN ('work', 'money', 'home', 'developer', 'fun')),
    CHECK ((mode = 'owner') = (grant_revision IS NOT NULL)),
    CHECK ((listing_line IS NULL) = (listing_category IS NULL)),
    CHECK (listing_line IS NULL OR mode = 'own')
  )`);
  // `role`: `use`, the slate as it is; `edit`, its files too (docs/SLATE-SHARING-NIMBUS.md §2), written in this workspace
  // and built from the slate's own tree. Every person added before the column uses it.
  execRaw(`CREATE TABLE IF NOT EXISTS slate_live_share_users (
    share_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'use' CHECK (role IN ('use', 'edit')),
    PRIMARY KEY (share_id, user_id)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_viewer_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, share_id TEXT NOT NULL, viewer TEXT NOT NULL,
    path TEXT NOT NULL, calls TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_edit_marks (
    slate_id TEXT PRIMARY KEY,
    editor TEXT NOT NULL,
    revision_before TEXT
  )`);
  // Who opened a share through its link (`openLiveShare`): one row per viewer, keyed by a per-share keyed hash of their
  // account that no one can link to them or across shares, or '' for every open by someone signed out. What a share's
  // numbers are is a query over these rows, never a count kept beside them.
  execRaw(`CREATE TABLE IF NOT EXISTS slate_share_views (
    share TEXT NOT NULL,
    viewer TEXT NOT NULL,
    opens INTEGER NOT NULL,
    PRIMARY KEY (share, viewer)
  )`);
}

/** The key of every open by someone signed out: one bucket, which never counts as a viewer. */
export const SIGNED_OUT_VIEWER = '';

const EditMarkRow = v.object({ editor: v.string(), revision_before: v.nullable(v.string()) });

export interface SlateEditMark {
  readonly editor: string;
  readonly revisionBefore: string | null;
}

const LiveShareRow = v.object({
  id: v.string(), slate_id: v.string(), visibility: LiveShareVisibilitySchema,
  handle: v.string(), grant_json: v.string(), created_at: v.number(), revoked_at: v.nullable(v.number()),
  mode: ShareModeSchema, grant_revision: v.nullable(v.string()),
  listing_line: v.nullable(v.string()), listing_category: v.nullable(GalleryCategorySchema),
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
    createdAt: row.created_at, revokedAt: row.revoked_at, users, editors: [], mode: row.mode, grantRevision: row.grant_revision, editedBy: null,
    // A revoked share is listed nowhere, whatever its row still holds.
    gallery: row.revoked_at === null && row.listing_line !== null && row.listing_category !== null ? { line: row.listing_line, category: row.listing_category } : null,
  }),
};

export class SlateLiveShareStore extends ShareStore<v.InferOutput<typeof LiveShareRow>, LiveShareRecord> {
  /**
   * Each slate's sharing generation in this object's life: how many times a live share of it began, ended or changed
   * mode. Every such change advances it in the same synchronous call that writes the row, so no await ever separates a
   * sharing change from its fence (shared-server.ts `SlateLineage`): a process or request of an older generation is
   * refused from the moment the row says otherwise.
   */
  private readonly generations = new Map<string, number>();

  constructor(db: SqlExec, now: () => number = () => Date.now()) {
    super(db, now, LIVE_SHARES);
  }

  /** `slate`'s sharing generation now. */
  generation(slate: string): number {
    return this.generations.get(slate) ?? 0;
  }

  private fence(slate: string): void {
    this.generations.set(slate, this.generation(slate) + 1);
  }

  add(share: { id: string; slate: string; visibility: 'users' | 'public'; handle: string; grant: ShareGrant; authority?: ShareAuthority }): LiveShareRecord {
    const createdAt = this.now();
    const authority = share.authority ?? OWN;

    this.db.exec(
      `INSERT INTO slate_live_shares (id, slate_id, visibility, handle, grant_json, created_at, revoked_at, mode, grant_revision)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      share.id, share.slate, share.visibility, share.handle, JSON.stringify(share.grant), createdAt, authority.mode, authority.grantRevision,
    );
    this.fence(share.slate);
    markStoreChanged(this.db);

    return {
      id: share.id, slate: share.slate, visibility: share.visibility, handle: share.handle,
      grant: share.grant, createdAt, revokedAt: null, users: [], editors: [], mode: authority.mode, grantRevision: authority.grantRevision, editedBy: this.editMark(share.slate)?.editor ?? null, gallery: null,
    };
  }

  /** A live share revoked: its slate's fence advances with the row, in this same call. */
  override revoke(id: string): LiveShareRecord {
    const live = this.get(id)?.revokedAt === null;
    const revoked = super.revoke(id);

    if (live) this.fence(revoked.slate);

    return revoked;
  }

  /** People added to a live share, each to use the slate or to edit it too: one added again takes the role named now. */
  override addUsers(id: string, users: readonly ShareUser[]): LiveShareRecord {
    super.addUsers(id, users);

    for (const user of users) this.db.exec('UPDATE slate_live_share_users SET role = ? WHERE share_id = ? AND user_id = ?', user.role ?? 'use', id, user.userId);
    markStoreChanged(this.db);

    return this.live(id);
  }

  /** Whether `userId` may edit `slate` now: a live share of it adds them to edit. */
  editsSlate(slate: string, userId: string): boolean {
    return this.db.exec(
      `SELECT 1 AS x FROM slate_live_share_users AS person JOIN slate_live_shares AS share ON share.id = person.share_id
       WHERE share.slate_id = ? AND share.revoked_at IS NULL AND person.user_id = ? AND person.role = 'edit'`,
      slate, userId,
    ).toArray().length > 0;
  }

  /** Whether any live share of `slate` adds someone to edit it. */
  hasEditors(slate: string): boolean {
    return this.db.exec(
      `SELECT 1 AS x FROM slate_live_share_users AS person JOIN slate_live_shares AS share ON share.id = person.share_id
       WHERE share.slate_id = ? AND share.revoked_at IS NULL AND person.role = 'edit'`,
      slate,
    ).toArray().length > 0;
  }

  /** Whether `slate` is shared now, by any live share. */
  isShared(slate: string): boolean {
    return this.db.exec('SELECT 1 AS x FROM slate_live_shares WHERE slate_id = ? AND revoked_at IS NULL', slate).toArray().length > 0;
  }

  protected override record(row: v.InferOutput<typeof LiveShareRow>, users: Parameters<ShareStore<v.InferOutput<typeof LiveShareRow>, LiveShareRecord>['record']>[1]): LiveShareRecord {
    const editors = this.db.exec(`SELECT email FROM slate_live_share_users WHERE share_id = ? AND role = 'edit' ORDER BY created_at, email`, row.id).toArray()
      .map((each) => v.parse(v.object({ email: v.string() }), each).email);

    return { ...super.record(row, users), editors, editedBy: this.editMark(row.slate_id)?.editor ?? null };
  }

  /** The latest unapproved batch's prior built revision fences approval until that batch has built. */
  editMark(slate: string): SlateEditMark | null {
    const row = this.db.exec('SELECT editor, revision_before FROM slate_edit_marks WHERE slate_id = ?', slate).toArray()[0];

    if (row === undefined) return null;
    const mark = v.parse(EditMarkRow, row);

    return { editor: mark.editor, revisionBefore: mark.revision_before };
  }

  markEdit(slate: string, editor: string, revisionBefore: string | null): void {
    this.db.exec(`INSERT INTO slate_edit_marks (slate_id, editor, revision_before) VALUES (?, ?, ?)
      ON CONFLICT(slate_id) DO UPDATE SET editor = excluded.editor, revision_before = excluded.revision_before`, slate, editor, revisionBefore);
    markStoreChanged(this.db);
  }

  /** Used only by a complete rollback, or to remove a mark on current-revision approval or slate deletion. */
  restoreEditMark(slate: string, mark: SlateEditMark | null): void {
    this.db.exec('DELETE FROM slate_edit_marks WHERE slate_id = ?', slate);

    if (mark !== null) this.markEdit(slate, mark.editor, mark.revisionBefore);
    markStoreChanged(this.db);
  }

  /** A live share listed in the Gallery with its card's words, or taken off it (null). A slate is listed once, so
   *  listing one share takes its slate's others off. Only a live `own` share is listed; whether it is, after. */
  setListing(id: string, listing: { readonly line: string; readonly category: GalleryCategory } | null): boolean {
    const held = this.get(id);

    if (held === undefined || held.revokedAt !== null || (listing !== null && held.mode !== 'own')) return false;

    if (listing !== null) this.db.exec('UPDATE slate_live_shares SET listing_line = NULL, listing_category = NULL WHERE slate_id = ? AND id <> ?', held.slate, id);
    this.db.exec('UPDATE slate_live_shares SET listing_line = ?, listing_category = ? WHERE id = ?', listing?.line ?? null, listing?.category ?? null, id);
    markStoreChanged(this.db);

    return true;
  }

  /**
   * A listed public share on each viewer's own access, as its Gallery picture may be taken through it: its slate and
   * handle, and whether that still holds (`held`), read where a picture taken now would be kept: still listed, public
   * and `own`, and its slate's sharing not changed since (`generation`). Null for any other share.
   */
  galleryCapture(id: string): { readonly slate: string; readonly handle: string; readonly held: () => boolean } | null {
    const listed = (): LiveShareRecord | null => {
      const share = this.get(id);

      return share?.revokedAt === null && share.gallery !== null && share.visibility === 'public' && share.mode === 'own' ? share : null;
    };

    const share = listed();

    if (share === null) return null;
    const generation = this.generation(share.slate);

    return { slate: share.slate, handle: share.handle, held: () => listed() !== null && this.generation(share.slate) === generation };
  }

  /** A live share's mode set: `own`, its grant kept for a later `owner`; `owner`, with the grant its owner approved
   *  now and the revision they approved it at. A revoked share keeps what it had. */
  setAuthority(id: string, authority: ShareAuthority, grant: ShareGrant): void {
    const held = this.get(id);

    this.db.exec(
      'UPDATE slate_live_shares SET mode = ?, grant_revision = ?, grant_json = ? WHERE id = ? AND revoked_at IS NULL',
      authority.mode, authority.grantRevision, JSON.stringify(grant), id,
    );

    if (held?.revokedAt === null && held.mode !== authority.mode) this.fence(held.slate);
    markStoreChanged(this.db);
  }

  /**
   * "Always for this slate": `entry` stands on every live `owner` share of `shared`, beside the others at its revision;
   * any at another revision is void, so it goes. The shares it now stands on.
   */
  preapprove(shared: string, entry: SharePreapproval): string[] {
    return this.rewriteGrants(shared, 'owner', (held) => [
      ...held.filter((each) => each.revision === entry.revision && preapprovalKey(each) !== preapprovalKey(entry)),
      entry,
    ]);
  }

  /** A standing approval taken back from every live share of `shared`, at any revision. The shares it was taken from. */
  withdrawPreapproval(shared: string, entry: Omit<SharePreapproval, 'revision'>): string[] {
    return this.rewriteGrants(shared, null, (held) => {
      const kept = held.filter((each) => preapprovalKey(each) !== preapprovalKey(entry));

      return kept.length === held.length ? null : kept;
    });
  }

  /** `shared`'s standing approvals at its `revision`, one of each, whichever live `owner` share holds it; none where it
   *  has no revision. */
  preapprovalsOf(shared: string, revision: string | null): SharePreapproval[] {
    const found = new Map<string, SharePreapproval>();

    for (const { mode, grant } of revision === null ? [] : this.authoritiesOf(shared)) {
      for (const each of mode === 'owner' ? grant.preapproved ?? [] : []) if (each.revision === revision) found.set(preapprovalKey(each), each);
    }

    return [...found.values()];
  }

  /** Each live share of `slate` (in `mode` where named) has its standing approvals rewritten by `change`, which answers
   *  null to leave one as it is. The shares rewritten. */
  private rewriteGrants(slate: string, mode: ShareMode | null, change: (held: readonly SharePreapproval[]) => SharePreapproval[] | null): string[] {
    const rows = this.db.exec('SELECT id, mode, grant_json FROM slate_live_shares WHERE slate_id = ? AND revoked_at IS NULL', slate).toArray()
      .map((row) => v.parse(v.object({ id: v.string(), mode: ShareModeSchema, grant_json: v.string() }), row));

    const rewritten: string[] = [];

    for (const row of rows.filter((each) => mode === null || each.mode === mode)) {
      const grant = v.parse(ShareGrantSchema, JSON.parse(row.grant_json));
      const preapproved = change(grant.preapproved ?? []);

      if (preapproved === null) continue;
      this.db.exec('UPDATE slate_live_shares SET grant_json = ? WHERE id = ?', JSON.stringify({ ...grant, preapproved }), row.id);
      rewritten.push(row.id);
    }

    if (rewritten.length > 0) markStoreChanged(this.db);

    return rewritten;
  }

  /** What each of `slate`'s live shares lets its server act with: the server's authority is read from all of them
   *  together on every call (share-policy.ts `serverAuthority`). A revoked share lends nothing. */
  authoritiesOf(slate: string): LiveShareAuthority[] {
    const mark = this.editMark(slate);

    return this.db.exec('SELECT mode, grant_json, grant_revision FROM slate_live_shares WHERE slate_id = ? AND revoked_at IS NULL', slate).toArray()
      .map((row) => v.parse(AuthorityRow, row))
      .map((row) => ({
        mode: row.mode, grant: v.parse(ShareGrantSchema, JSON.parse(row.grant_json)),
        grantRevision: mark !== null && row.mode === 'owner' ? null : row.grant_revision,
        ...(mark !== null && row.mode === 'owner' && { editedBy: mark.editor }),
      }));
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
  /** `viewer` ({@link SIGNED_OUT_VIEWER} for someone signed out) opened `share` through its link. */
  opened(share: string, viewer: string): void {
    this.db.exec(
      `INSERT INTO slate_share_views (share, viewer, opens) VALUES (?, ?, 1)
       ON CONFLICT (share, viewer) DO UPDATE SET opens = opens + 1`,
      share, viewer,
    );
  }

  /** How many people opened `share`, and how often: signed-out opens counted, never as viewers. */
  views(share: string): ShareViews {
    const row = this.db.exec(
      `SELECT COUNT(*) FILTER (WHERE viewer <> ?) AS viewers, COALESCE(SUM(opens), 0) AS opens,
              COALESCE(SUM(opens) FILTER (WHERE viewer = ?), 0) AS signed_out
         FROM slate_share_views WHERE share = ?`,
      SIGNED_OUT_VIEWER, SIGNED_OUT_VIEWER, share,
    ).toArray()[0];

    const counted = v.parse(v.object({ viewers: v.number(), opens: v.number(), signed_out: v.number() }), row);

    return { viewers: counted.viewers, opens: counted.opens, signedOutOpens: counted.signed_out };
  }

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
