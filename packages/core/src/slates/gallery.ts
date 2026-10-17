/**
 * The Gallery's index, in the control plane's own database: one listing per listed slate, written only through its
 * workspace's share ({@link GalleryListingSync}), with stars and reports. A listing is its share's address, the one way
 * in, so it grants nothing, and it goes the moment its share goes off.
 *
 * The listings are a cache of the workspaces' shares, which each share's next sync writes again; stars and reports are
 * people's own, kept by their email and forgotten with their account.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import { GALLERY_CATEGORIES, GALLERY_PAGE_SIZE, type GalleryCategory, type GalleryListing, type GalleryPage, type GallerySlate, type GallerySort } from './gallery-api';
import type { GalleryListingSync } from './share-modes';

export function initGalleryTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_listings ( /* regenerable cache, refilled by the workspace's share sync */
    workspace TEXT NOT NULL,
    slate TEXT NOT NULL,
    share TEXT NOT NULL,
    title TEXT NOT NULL,
    line TEXT NOT NULL,
    category TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    url TEXT NOT NULL,
    picture TEXT,
    listed_at INTEGER NOT NULL,
    PRIMARY KEY (workspace, slate)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_stars (
    workspace TEXT NOT NULL,
    slate TEXT NOT NULL,
    email TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (workspace, slate, email)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS gallery_stars_email ON gallery_stars (email)');
  execRaw('CREATE INDEX IF NOT EXISTS gallery_stars_at ON gallery_stars (at)');
  // One report per person per listing, its latest reason: reporting again replaces it. Kept past an unlist, for the
  // operators.
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_reports (
    workspace TEXT NOT NULL,
    slate TEXT NOT NULL,
    email TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (workspace, slate, email)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS gallery_reports_email ON gallery_reports (email)');
}


/** The window stars count toward trending, and toward this week's featured two. */
const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const ListingRow = v.object({
  workspace: v.string(), slate: v.string(), share: v.string(), title: v.string(), line: v.string(), category: v.picklist(GALLERY_CATEGORIES),
  owner_name: v.string(), url: v.string(), picture: v.nullable(v.string()), listed_at: v.number(),
  stars: v.number(), recent: v.number(), starred: v.number(),
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
      const held = this.db.exec('SELECT 1 FROM gallery_listings WHERE workspace = ? AND slate = ? AND share = ?', workspace, slate, share).toArray();

      if (held.length === 0) return;
      this.db.exec('DELETE FROM gallery_listings WHERE workspace = ? AND slate = ?', workspace, slate);
      this.db.exec('DELETE FROM gallery_stars WHERE workspace = ? AND slate = ?', workspace, slate);

      return;
    }

    const { card } = sync;

    this.db.exec(
      `INSERT INTO gallery_listings (workspace, slate, share, title, line, category, owner_name, url, picture, listed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace, slate) DO UPDATE SET share = excluded.share, title = excluded.title, line = excluded.line,
         category = excluded.category, owner_name = excluded.owner_name, url = excluded.url, picture = excluded.picture`,
      workspace, slate, share, card.title, card.line, card.category, card.ownerName, sync.url, card.picture, now,
    );
  }

  /** A deleted account's stars and reports: its email is kept nowhere here after it. */
  forget(email: string): void {
    this.db.exec('DELETE FROM gallery_stars WHERE email = ?', email);
    this.db.exec('DELETE FROM gallery_reports WHERE email = ?', email);
  }

  /** One page, newest first, most starred, or most starred this week; `viewer` sees their own stars. */
  page(query: { readonly q: string; readonly sort: GallerySort; readonly category: GalleryCategory | null; readonly page: number },
    viewer: string | null, now: number): GalleryPage {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.q !== '') {
      where.push('(l.title LIKE ? ESCAPE \'\\\' OR l.line LIKE ? ESCAPE \'\\\')');
      const pattern = `%${query.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

      params.push(pattern, pattern);
    }

    if (query.category !== null) {
      where.push('l.category = ?');
      params.push(query.category);
    }

    const order = { new: 'l.listed_at DESC', stars: 'stars DESC, l.listed_at DESC', trending: 'recent DESC, stars DESC, l.listed_at DESC' }[query.sort];
    const offset = Math.max(0, query.page) * GALLERY_PAGE_SIZE;

    const rows = this.rows(`${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, GALLERY_PAGE_SIZE + 1, offset], viewer, now);

    const featured = this.featured(now);

    return {
      listings: rows.slice(0, GALLERY_PAGE_SIZE).map((row) => listingOf(row, featured)),
      next: rows.length > GALLERY_PAGE_SIZE ? query.page + 1 : null,
    };
  }

  /** A listed slate's own page, or null when it is not listed. */
  slate(workspace: string, slate: string, viewer: string | null, now: number): GallerySlate | null {
    const [row] = this.rows('WHERE l.workspace = ? AND l.slate = ?', [workspace, slate], viewer, now);

    if (row === undefined) return null;

    return { listing: listingOf(row, this.featured(now)) };
  }

  /** Whether `workspace`'s slate is listed, and its picture's digest if so. */
  listed(workspace: string, slate: string): { readonly picture: string | null } | null {
    const row = this.db.exec('SELECT picture FROM gallery_listings WHERE workspace = ? AND slate = ?', workspace, slate).toArray()[0];

    return row === undefined ? null : { picture: v.parse(v.object({ picture: v.nullable(v.string()) }), row).picture };
  }

  /** A star from `email`, or its withdrawal; a slate that is not listed takes none. */
  star(star: { readonly email: string; readonly workspace: string; readonly slate: string; readonly on: boolean }, now: number): boolean {
    const { email, workspace, slate, on } = star;

    if (this.listed(workspace, slate) === null) return false;

    if (on) this.db.exec('INSERT OR IGNORE INTO gallery_stars (workspace, slate, email, at) VALUES (?, ?, ?, ?)', workspace, slate, email, now);
    else this.db.exec('DELETE FROM gallery_stars WHERE workspace = ? AND slate = ? AND email = ?', workspace, slate, email);

    return true;
  }

  /** The listings `email` starred, newest star first. */
  starred(email: string, now: number): GalleryListing[] {
    const featured = this.featured(now);

    return this.rows('WHERE l.rowid IN (SELECT gl.rowid FROM gallery_listings gl JOIN gallery_stars gs ON gs.workspace = gl.workspace AND gs.slate = gl.slate WHERE gs.email = ?) ORDER BY l.listed_at DESC',
      [email], email, now).map((row) => listingOf(row, featured));
  }

  /** A person's report of a listing: one per person per listing, and reporting it again replaces their reason. */
  report(report: { readonly email: string; readonly workspace: string; readonly slate: string; readonly reason: string }, now: number): boolean {
    const { email, workspace, slate, reason } = report;

    if (this.listed(workspace, slate) === null) return false;
    this.db.exec(
      'INSERT INTO gallery_reports (workspace, slate, email, reason, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace, slate, email) DO UPDATE SET reason = excluded.reason, at = excluded.at',
      workspace, slate, email, reason.slice(0, 2000), now,
    );

    return true;
  }

  private rows(tail: string, params: readonly (string | number)[], viewer: string | null, now: number): Row[] {
    const since = now - TRENDING_WINDOW_MS;

    return this.db.exec(
      `SELECT l.*,
         (SELECT count(*) FROM gallery_stars s WHERE s.workspace = l.workspace AND s.slate = l.slate) AS stars,
         (SELECT count(*) FROM gallery_stars s WHERE s.workspace = l.workspace AND s.slate = l.slate AND s.at >= ?) AS recent,
         (SELECT count(*) FROM gallery_stars s WHERE s.workspace = l.workspace AND s.slate = l.slate AND s.email = ?) AS starred
       FROM gallery_listings l ${tail}`,
      since, viewer ?? '', ...params,
    ).toArray().map((row) => v.parse(ListingRow, row));
  }

  /** This week's two most starred listings, by key. */
  private featured(now: number): ReadonlySet<string> {
    const since = now - TRENDING_WINDOW_MS;

    const rows = this.db.exec(
      `SELECT workspace, slate, count(*) AS recent FROM gallery_stars WHERE at >= ? GROUP BY workspace, slate ORDER BY recent DESC LIMIT 2`, since,
    ).toArray().map((row) => v.parse(v.object({ workspace: v.string(), slate: v.string(), recent: v.number() }), row));

    return new Set(rows.map((row) => `${row.workspace}/${row.slate}`));
  }
}

function listingOf(row: Row, featured: ReadonlySet<string>): GalleryListing {
  return {
    workspace: row.workspace, slate: row.slate, share: row.share, title: row.title, line: row.line, category: row.category,
    owner: { name: row.owner_name }, stars: row.stars, starred: row.starred > 0, listedAt: row.listed_at,
    featured: featured.has(`${row.workspace}/${row.slate}`), url: row.url,
    ...(row.picture !== null && { picture: row.picture }),
  };
}
