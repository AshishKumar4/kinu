/**
 * The Gallery's index: one listing per listed slate, written only by that slate's room, with stars and reports. A
 * listing is its slate's link, the one way in, so it grants nothing (`Confinement.lean`: `a_listing_never_mints`), and
 * the room takes it down the moment its link goes off.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import {
  GALLERY_CATEGORIES, type GalleryCategory, type GalleryListing, type GalleryPage, type GallerySlate, type GallerySort,
  type RoomService,
} from './room-api';

export function initGalleryTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_listings (
    workspace TEXT NOT NULL,
    slate TEXT NOT NULL,
    title TEXT NOT NULL,
    line TEXT NOT NULL,
    category TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    url TEXT NOT NULL,
    needs TEXT NOT NULL,
    files TEXT NOT NULL,
    reads_author INTEGER NOT NULL,
    picture TEXT,
    listed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace, slate)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_stars (
    workspace TEXT NOT NULL,
    slate TEXT NOT NULL,
    email TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (workspace, slate, email)
  )`);
  // One report per person per listing, its latest reason: reporting again replaces it.
  execRaw(`CREATE TABLE IF NOT EXISTS gallery_reports (
    workspace TEXT NOT NULL,
    slate TEXT NOT NULL,
    email TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (workspace, slate, email)
  )`);
}

/** What a room says of its slate when it lists it, and again when a new image is published while it is listed. */
export interface GalleryEntry {
  readonly workspace: string;
  readonly slate: string;
  readonly title: string;
  readonly line: string;
  readonly category: GalleryCategory;
  readonly ownerName: string;
  readonly url: string;
  readonly needs: readonly RoomService[];
  readonly files: readonly string[];
  readonly readsAuthor: boolean;
  /** The picture its workspace last took of its page, if any. */
  readonly picture: string | null;
}

/** One page of listings. */
const GALLERY_PAGE_SIZE = 24;

/** New listings one person may report in a day. */
const REPORTS_PER_DAY = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window stars count toward trending, and toward this week's featured two. */
const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const ListingRow = v.object({
  workspace: v.string(), slate: v.string(), title: v.string(), line: v.string(), category: v.picklist(GALLERY_CATEGORIES),
  owner_name: v.string(), url: v.string(), needs: v.string(), files: v.string(), reads_author: v.number(),
  picture: v.nullable(v.string()), listed_at: v.number(), updated_at: v.number(),
  stars: v.number(), recent: v.number(), starred: v.number(),
});

type Row = v.InferOutput<typeof ListingRow>;

const ServicesSchema = v.array(v.object({ title: v.string(), kind: v.picklist(['github', 'mcp', 'ai', 'workspace'] as const) }));

export class GalleryIndex {
  constructor(private readonly db: SqlExec) {}

  /** Lists `entry`'s slate, or says it again: its stars and its listing time stay. */
  list(entry: GalleryEntry, now: number): void {
    this.db.exec(
      `INSERT INTO gallery_listings (workspace, slate, title, line, category, owner_name, url, needs, files, reads_author, picture, listed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace, slate) DO UPDATE SET title = excluded.title, line = excluded.line, category = excluded.category,
         owner_name = excluded.owner_name, url = excluded.url, needs = excluded.needs, files = excluded.files,
         reads_author = excluded.reads_author, picture = COALESCE(excluded.picture, picture), updated_at = excluded.updated_at`,
      entry.workspace, entry.slate, entry.title, entry.line, entry.category, entry.ownerName, entry.url,
      JSON.stringify(entry.needs), JSON.stringify(entry.files), entry.readsAuthor ? 1 : 0, entry.picture, now, now,
    );
  }

  /** Takes the listing down; its stars go with it. */
  unlist(workspace: string, slate: string): void {
    this.db.exec('DELETE FROM gallery_listings WHERE workspace = ? AND slate = ?', workspace, slate);
    this.db.exec('DELETE FROM gallery_stars WHERE workspace = ? AND slate = ?', workspace, slate);
  }

  /** A deleted account's stars and reports: its email is kept nowhere here after it. */
  forget(email: string): void {
    this.db.exec('DELETE FROM gallery_stars WHERE email = ?', email);
    this.db.exec('DELETE FROM gallery_reports WHERE email = ?', email);
  }

  /** The picture a listing shows, as its room took it from its own page. */
  pictured(workspace: string, slate: string, digest: string): void {
    this.db.exec('UPDATE gallery_listings SET picture = ? WHERE workspace = ? AND slate = ?', digest, workspace, slate);
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

    return {
      listing: listingOf(row, this.featured(now)), files: v.parse(v.array(v.string()), JSON.parse(row.files)),
      updatedAt: row.updated_at, readsAuthor: row.reads_author === 1,
    };
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

  /**
   * A person's report of a listing: one per person per listing, reporting again replaces it, and at most
   * `REPORTS_PER_DAY` new listings a day per person, so no one account fills the Gallery's store.
   */
  report(report: { readonly email: string; readonly workspace: string; readonly slate: string; readonly reason: string }, now: number): 'reported' | 'unlisted' | 'limited' {
    const { email, workspace, slate, reason } = report;

    if (this.listed(workspace, slate) === null) return 'unlisted';
    const again = this.db.exec('SELECT 1 FROM gallery_reports WHERE workspace = ? AND slate = ? AND email = ?', workspace, slate, email).toArray().length > 0;
    const today = v.parse(v.object({ n: v.number() }), this.db.exec('SELECT COUNT(*) AS n FROM gallery_reports WHERE email = ? AND at > ?', email, now - DAY_MS).toArray()[0]).n;

    if (!again && today >= REPORTS_PER_DAY) return 'limited';
    this.db.exec(
      'INSERT INTO gallery_reports (workspace, slate, email, reason, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace, slate, email) DO UPDATE SET reason = excluded.reason, at = excluded.at',
      workspace, slate, email, reason.slice(0, 2000), now,
    );

    return 'reported';
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
    workspace: row.workspace, slate: row.slate, title: row.title, line: row.line, category: row.category,
    owner: { name: row.owner_name }, stars: row.stars, starred: row.starred > 0, listedAt: row.listed_at,
    needs: v.parse(ServicesSchema, JSON.parse(row.needs)), featured: featured.has(`${row.workspace}/${row.slate}`), url: row.url,
    ...(row.picture !== null && { picture: row.picture }),
  };
}
