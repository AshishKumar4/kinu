/**
 * Explore's index, in the control plane's own database: one listing per listed item, of two kinds. An app is a listed
 * slate, written only through its workspace's share ({@link GalleryListingSync}): its share's address, the one way in,
 * so it grants nothing, and it goes the moment its share goes off. A workspace is a workspace blueprint; Kinu's own are
 * written from code each time the control plane starts ({@link GalleryIndex.syncKinu}). Stars and reports are people's
 * own, kept by their email; installs by their account; all three forgotten with it.
 *
 * The listings are a cache, refilled by their syncs.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import { textContains } from '../utils/text-match';
import {
  EXPLORE_KINDS, GALLERY_CATEGORIES, GALLERY_PAGE_SIZE,
  type ExploreItem, type ExploreKind, type ExplorePage, type GalleryCategory, type GalleryListing, type GalleryPage, type GallerySlate,
  type GallerySort, type WorkspaceCard,
} from './gallery-api';
import type { GalleryListingSync } from './share-modes';

export function initGalleryTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_listings ( /* regenerable cache, refilled by each listing's sync */
    kind TEXT NOT NULL CHECK (kind IN ('app', 'workspace')),
    workspace TEXT NOT NULL,
    item TEXT NOT NULL, /* an app's slate id; a workspace blueprint's id */
    share TEXT NOT NULL,
    title TEXT NOT NULL,
    line TEXT NOT NULL,
    category TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    maker TEXT NOT NULL DEFAULT 'person' CHECK (maker IN ('person', 'kinu')),
    url TEXT NOT NULL,
    picture TEXT,
    needs TEXT, /* JSON: what an install asks of the person (BlueprintNeed[]) */
    listed_at INTEGER NOT NULL,
    viewers INTEGER NOT NULL DEFAULT 0, /* a projection: the owner workspace's distinct signed-in viewers of the share (slate_share_views), as its last listing sync carried them */
    PRIMARY KEY (kind, workspace, item)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_stars (
    kind TEXT NOT NULL CHECK (kind IN ('app', 'workspace')),
    workspace TEXT NOT NULL,
    item TEXT NOT NULL,
    email TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (kind, workspace, item, email)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS gallery_stars_email ON gallery_stars (email)');
  execRaw('CREATE INDEX IF NOT EXISTS gallery_stars_at ON gallery_stars (at)');
  // One report per person per listing, its latest reason: reporting again replaces it. Kept past an unlist, for the
  // operators.
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_reports (
    kind TEXT NOT NULL CHECK (kind IN ('app', 'workspace')),
    workspace TEXT NOT NULL,
    item TEXT NOT NULL,
    email TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (kind, workspace, item, email)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS gallery_reports_email ON gallery_reports (email)');
  // Who installed what, once each: a listing's installs are its count here.
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_installs (
    kind TEXT NOT NULL CHECK (kind IN ('app', 'workspace')),
    workspace TEXT NOT NULL,
    item TEXT NOT NULL,
    user_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (kind, workspace, item, user_id)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS gallery_installs_user ON gallery_installs (user_id)');
}

/** Where Kinu's own blueprints are listed: a name no workspace has, since a workspace's name is a hostname label. */
export const KINU_LISTINGS = '_kinu';

/** One of Kinu's own workspace blueprints as its listing holds it (blueprints/kinu.ts). */
export interface KinuListing {
  readonly id: string;
  readonly title: string;
  readonly line: string;
  readonly category: GalleryCategory;
  readonly picture: string | null;
  readonly needs: WorkspaceCard['needs'];
}

const NeedsSchema = v.pipe(v.string(), v.parseJson(), v.array(v.object({
  connection: v.nullable(v.string()), secret: v.nullable(v.string()), access: v.picklist(['read', 'write']), why: v.string(),
})));

/** The window stars count toward trending, and toward this week's featured two. */
const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const ListingRow = v.object({
  kind: v.picklist(EXPLORE_KINDS), workspace: v.string(), item: v.string(), share: v.string(), title: v.string(), line: v.string(),
  category: v.picklist(GALLERY_CATEGORIES), owner_name: v.string(), maker: v.picklist(['person', 'kinu']), url: v.string(),
  picture: v.nullable(v.string()), needs: v.nullable(v.string()), listed_at: v.number(), viewers: v.number(),
  stars: v.number(), recent: v.number(), starred: v.number(), installs: v.number(),
});

type Row = v.InferOutput<typeof ListingRow>;

export class GalleryIndex {
  constructor(private readonly db: SqlExec) {}

  /** What a workspace says of one share: listed, its slate's listing written again (its stars and its listing time
   *  stay); unlisted, the listing that share made taken down with its stars. A word about a share other than the one a
   *  slate is listed under touches nothing of it, so an old share's late unlisting never takes down a new one's. */
  sync(sync: GalleryListingSync, now: number): void {
    const { workspace, slate, share } = sync;

    if (!sync.listed) {
      const held = this.db.exec("SELECT 1 FROM gallery_listings WHERE kind = 'app' AND workspace = ? AND item = ? AND share = ?", workspace, slate, share).toArray();

      if (held.length === 0) return;
      this.db.exec("DELETE FROM gallery_listings WHERE kind = 'app' AND workspace = ? AND item = ?", workspace, slate);
      this.db.exec("DELETE FROM gallery_stars WHERE kind = 'app' AND workspace = ? AND item = ?", workspace, slate);

      return;
    }

    const { card } = sync;

    this.db.exec(
      `INSERT INTO gallery_listings (kind, workspace, item, share, title, line, category, owner_name, url, picture, listed_at, viewers)
       VALUES ('app', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, workspace, item) DO UPDATE SET share = excluded.share, title = excluded.title, line = excluded.line,
         category = excluded.category, owner_name = excluded.owner_name, url = excluded.url, picture = excluded.picture,
         viewers = excluded.viewers`,
      workspace, slate, share, card.title, card.line, card.category, card.ownerName, sync.url, card.picture, now, card.viewers,
    );
  }

  /** Kinu's own workspace blueprints, as this build keeps them: each written again (its stars, installs and listing time
   *  stay), and one this build no longer keeps taken down. */
  syncKinu(listings: readonly KinuListing[], now: number): void {
    for (const listing of listings) {
      this.db.exec(
        `INSERT INTO gallery_listings (kind, workspace, item, share, title, line, category, owner_name, maker, url, picture, needs, listed_at)
         VALUES ('workspace', ?, ?, ?, ?, ?, ?, 'Kinu', 'kinu', ?, ?, ?, ?)
         ON CONFLICT (kind, workspace, item) DO UPDATE SET title = excluded.title, line = excluded.line, category = excluded.category,
           url = excluded.url, picture = excluded.picture, needs = excluded.needs`,
        KINU_LISTINGS, listing.id, listing.id, listing.title, listing.line, listing.category, `/explore/workspaces/${listing.id}`,
        listing.picture, JSON.stringify(listing.needs), now,
      );
    }

    const kept = new Set(listings.map((listing) => listing.id));

    const held = this.db.exec("SELECT item FROM gallery_listings WHERE kind = 'workspace' AND workspace = ?", KINU_LISTINGS).toArray()
      .map((row) => v.parse(v.object({ item: v.string() }), row).item);

    for (const gone of held.filter((item) => !kept.has(item))) {
      this.db.exec("DELETE FROM gallery_listings WHERE kind = 'workspace' AND workspace = ? AND item = ?", KINU_LISTINGS, gone);
    }
  }

  /** An install of a listed item by `userId`, counted once; false when it is not listed. */
  installed(install: { readonly kind: ExploreKind; readonly workspace: string; readonly item: string; readonly userId: string }, now: number): boolean {
    const { kind, workspace, item, userId } = install;

    if (!this.holds(kind, workspace, item)) return false;
    this.db.exec('INSERT OR IGNORE INTO gallery_installs (kind, workspace, item, user_id, at) VALUES (?, ?, ?, ?, ?)', kind, workspace, item, userId, now);

    return true;
  }

  /** Removed workspaces' listings, and the stars on them: a removed workspace sends no more syncs, so a listing it left
   *  would be found forever. */
  forgetWorkspaces(workspaces: readonly string[]): void {
    for (const workspace of workspaces) {
      this.db.exec('DELETE FROM gallery_listings WHERE workspace = ?', workspace);
      this.db.exec('DELETE FROM gallery_stars WHERE workspace = ?', workspace);
    }
  }

  /** A deleted account's stars, reports and installs: neither its email nor its id is kept here after it. */
  forget(person: { readonly email: string; readonly userId: string }): void {
    this.db.exec('DELETE FROM gallery_stars WHERE email = ?', person.email);
    this.db.exec('DELETE FROM gallery_reports WHERE email = ?', person.email);
    this.db.exec('DELETE FROM gallery_installs WHERE user_id = ?', person.userId);
  }

  /** One page, newest first, most starred, or most starred this week; `viewer` sees their own stars. */
  page(query: { readonly q: string; readonly sort: GallerySort; readonly category: GalleryCategory | null; readonly page: number },
    viewer: string | null, now: number): GalleryPage {
    const where: string[] = [];
    const params: (string | number)[] = [];

    // Its words anywhere in the title or the line.
    if (query.q !== '') {
      where.push(`(${textContains('l.title')} OR ${textContains('l.line')})`);
      params.push(query.q, query.q);
    }

    if (query.category !== null) {
      where.push('l.category = ?');
      params.push(query.category);
    }

    const order = { new: 'l.listed_at DESC', stars: 'stars DESC, l.listed_at DESC', trending: 'recent DESC, stars DESC, l.listed_at DESC' }[query.sort];
    const offset = Math.max(0, query.page) * GALLERY_PAGE_SIZE;

    const rows = this.rows(`WHERE ${["l.kind = 'app'", ...where].join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, GALLERY_PAGE_SIZE + 1, offset], viewer, now);

    const featured = this.featured(now);

    return {
      listings: rows.slice(0, GALLERY_PAGE_SIZE).map((row) => listingOf(row, featured)),
      next: rows.length > GALLERY_PAGE_SIZE ? query.page + 1 : null,
    };
  }

  /** One page of Explore: both kinds ranked together, or one kind, Kinu's own first; `viewer` sees their own stars. */
  explore(query: { readonly q: string; readonly kind: ExploreKind | null; readonly sort: GallerySort; readonly category: GalleryCategory | null; readonly page: number },
    viewer: string | null, now: number): ExplorePage {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.q !== '') {
      where.push(`(${textContains('l.title')} OR ${textContains('l.line')})`);
      params.push(query.q, query.q);
    }

    if (query.kind !== null) {
      where.push('l.kind = ?');
      params.push(query.kind);
    }

    if (query.category !== null) {
      where.push('l.category = ?');
      params.push(query.category);
    }

    const order = { new: 'l.listed_at DESC', stars: 'stars DESC, l.listed_at DESC', trending: 'recent DESC, installs DESC, stars DESC, l.listed_at DESC' }[query.sort];
    const offset = Math.max(0, query.page) * GALLERY_PAGE_SIZE;

    const rows = this.rows(`${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY l.maker = 'kinu' DESC, ${order}, l.item ASC LIMIT ? OFFSET ?`,
      [...params, GALLERY_PAGE_SIZE + 1, offset], viewer, now);

    const featured = this.featured(now);

    return {
      items: rows.slice(0, GALLERY_PAGE_SIZE).map((row) => itemOf(row, featured)),
      next: rows.length > GALLERY_PAGE_SIZE ? query.page + 1 : null,
    };
  }

  /** A listed workspace blueprint's card, or null when it is not listed. */
  workspaceCard(workspace: string, item: string, viewer: string | null, now: number): WorkspaceCard | null {
    const [row] = this.rows("WHERE l.kind = 'workspace' AND l.workspace = ? AND l.item = ?", [workspace, item], viewer, now);

    return row === undefined ? null : cardOf(row, this.featured(now));
  }

  /** A listed slate's own page, or null when it is not listed. */
  slate(workspace: string, slate: string, viewer: string | null, now: number): GallerySlate | null {
    const [row] = this.rows("WHERE l.kind = 'app' AND l.workspace = ? AND l.item = ?", [workspace, slate], viewer, now);

    if (row === undefined) return null;

    return { listing: listingOf(row, this.featured(now)) };
  }

  /** Whether `workspace`'s slate is listed, and if so by which share, and its picture's digest. */
  listed(workspace: string, slate: string): { readonly share: string; readonly picture: string | null } | null {
    const row = this.db.exec("SELECT share, picture FROM gallery_listings WHERE kind = 'app' AND workspace = ? AND item = ?", workspace, slate).toArray()[0];

    return row === undefined ? null : v.parse(v.object({ share: v.string(), picture: v.nullable(v.string()) }), row);
  }

  /** A star from `email`, or its withdrawal; a slate that is not listed takes none. */
  /** A star on a listed item, an app's unless `kind` says; false when it is not listed. */
  star(star: { readonly email: string; readonly workspace: string; readonly slate: string; readonly on: boolean; readonly kind?: ExploreKind }, now: number): boolean {
    const { email, workspace, slate, on, kind = 'app' } = star;

    if (!this.holds(kind, workspace, slate)) return false;

    if (on) this.db.exec('INSERT OR IGNORE INTO gallery_stars (kind, workspace, item, email, at) VALUES (?, ?, ?, ?, ?)', kind, workspace, slate, email, now);
    else this.db.exec('DELETE FROM gallery_stars WHERE kind = ? AND workspace = ? AND item = ? AND email = ?', kind, workspace, slate, email);

    return true;
  }

  private holds(kind: ExploreKind, workspace: string, item: string): boolean {
    return this.db.exec('SELECT 1 FROM gallery_listings WHERE kind = ? AND workspace = ? AND item = ?', kind, workspace, item).toArray().length > 0;
  }

  /** The listings `email` starred, newest star first. */
  starred(email: string, now: number): GalleryListing[] {
    const featured = this.featured(now);

    return this.rows("WHERE l.kind = 'app' AND l.rowid IN (SELECT gl.rowid FROM gallery_listings gl JOIN gallery_stars gs ON gs.kind = gl.kind AND gs.workspace = gl.workspace AND gs.item = gl.item WHERE gs.email = ?) ORDER BY l.listed_at DESC",
      [email], email, now).map((row) => listingOf(row, featured));
  }

  /** A person's report of a listing: one per person per listing, and reporting it again replaces their reason. */
  report(report: { readonly email: string; readonly workspace: string; readonly slate: string; readonly reason: string }, now: number): boolean {
    const { email, workspace, slate, reason } = report;

    if (this.listed(workspace, slate) === null) return false;
    this.db.exec(
      "INSERT INTO gallery_reports (kind, workspace, item, email, reason, at) VALUES ('app', ?, ?, ?, ?, ?) ON CONFLICT (kind, workspace, item, email) DO UPDATE SET reason = excluded.reason, at = excluded.at",
      workspace, slate, email, reason.slice(0, 2000), now,
    );

    return true;
  }

  private rows(tail: string, params: readonly (string | number)[], viewer: string | null, now: number): Row[] {
    const since = now - TRENDING_WINDOW_MS;

    return this.db.exec(
      `SELECT l.*,
         (SELECT count(*) FROM gallery_stars s WHERE s.kind = l.kind AND s.workspace = l.workspace AND s.item = l.item) AS stars,
         (SELECT count(*) FROM gallery_stars s WHERE s.kind = l.kind AND s.workspace = l.workspace AND s.item = l.item AND s.at >= ?) AS recent,
         (SELECT count(*) FROM gallery_stars s WHERE s.kind = l.kind AND s.workspace = l.workspace AND s.item = l.item AND s.email = ?) AS starred,
         (SELECT count(*) FROM gallery_installs i WHERE i.kind = l.kind AND i.workspace = l.workspace AND i.item = l.item) AS installs
       FROM gallery_listings l ${tail}`,
      since, viewer ?? '', ...params,
    ).toArray().map((row) => v.parse(ListingRow, row));
  }

  /** This week's two most starred listings, by key. */
  private featured(now: number): ReadonlySet<string> {
    const since = now - TRENDING_WINDOW_MS;

    const rows = this.db.exec(
      `SELECT kind, workspace, item, count(*) AS recent FROM gallery_stars WHERE at >= ? GROUP BY kind, workspace, item ORDER BY recent DESC LIMIT 2`, since,
    ).toArray().map((row) => v.parse(v.object({ kind: v.string(), workspace: v.string(), item: v.string(), recent: v.number() }), row));

    return new Set(rows.map((row) => `${row.kind}/${row.workspace}/${row.item}`));
  }
}

const keyOf = (row: Row) => `${row.kind}/${row.workspace}/${row.item}`;

function listingOf(row: Row, featured: ReadonlySet<string>): GalleryListing {
  return {
    workspace: row.workspace, slate: row.item, share: row.share, title: row.title, line: row.line, category: row.category,
    owner: { name: row.owner_name }, stars: row.stars, starred: row.starred > 0, viewers: row.viewers, listedAt: row.listed_at,
    featured: featured.has(keyOf(row)), url: row.url,
    ...(row.picture !== null && { picture: row.picture }),
  };
}

function cardOf(row: Row, featured: ReadonlySet<string>): WorkspaceCard {
  return {
    id: row.item, title: row.title, line: row.line, category: row.category, maker: { name: row.owner_name, kinu: row.maker === 'kinu' },
    picture: row.picture, installs: row.installs, stars: row.stars, starred: row.starred > 0,
    needs: row.needs === null ? [] : v.parse(NeedsSchema, row.needs), listedAt: row.listed_at, featured: featured.has(keyOf(row)),
  };
}

function itemOf(row: Row, featured: ReadonlySet<string>): ExploreItem {
  return row.kind === 'app'
    ? { kind: 'app', app: listingOf(row, featured), needs: [] }
    : { kind: 'workspace', workspace: cardOf(row, featured) };
}
