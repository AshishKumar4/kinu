/**
 * The Gallery's client API: what its pages, the Drive and the share sheet read and send. The Gallery lists live shares
 * in `own` mode alone (docs/SLATE-SHARING-NIMBUS.md §2): a listing is always their-own-access, so it reaches nothing of
 * its author's. Its index answers a list or a search without asking any workspace; what only the slate's share knows is
 * read from the share when a slate's own page is opened.
 */
import * as v from 'valibot';
import { RoomServiceSchema } from './room-api';

export const GALLERY_CATEGORIES = ['work', 'money', 'home', 'developer', 'fun'] as const;

export const GalleryCategorySchema = v.picklist(GALLERY_CATEGORIES);

export type GalleryCategory = v.InferOutput<typeof GalleryCategorySchema>;

const GalleryListingSchema = v.object({
  workspace: v.string(),
  slate: v.string(),
  /** The live share it opens: `slate_live_shares.id`. */
  share: v.string(),
  title: v.string(),
  line: v.string(),
  category: GalleryCategorySchema,
  owner: v.object({ name: v.string() }),
  stars: v.number(),
  starred: v.boolean(),
  listedAt: v.number(),
  /** Its picture's digest, taken from a fresh visit, once there is one: {@link galleryPicturePath}. */
  picture: v.optional(v.string()),
  /** One of this week's top two by trending. */
  featured: v.boolean(),
  /** Its link, the one way in: the app's page for its share, which frames the share's host. Unlisted the moment the
   *  share goes off. */
  url: v.string(),
});

export type GalleryListing = v.InferOutput<typeof GalleryListingSchema>;

export const GALLERY_SORTS = ['trending', 'new', 'stars'] as const;

/** Listings a Gallery page holds. */
export const GALLERY_PAGE_SIZE = 24;

/** The last page whose offset (`page * GALLERY_PAGE_SIZE`) is still a safe integer: the index has no other bound. */
export const GALLERY_LAST_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / GALLERY_PAGE_SIZE);

export type GallerySort = (typeof GALLERY_SORTS)[number];

/** One page of the Gallery: `next` is the page after it, null at the end. */
export const GalleryPageSchema = v.object({ listings: v.array(GalleryListingSchema), next: v.nullable(v.number()) });

export type GalleryPage = v.InferOutput<typeof GalleryPageSchema>;

/** `GET`, public: one page of listings, matching `q` and in `category` when given. */
export function galleryPath(query: { q: string; sort: GallerySort; category: GalleryCategory | null; page: number }): string {
  const search = new URLSearchParams({ sort: query.sort, page: String(query.page) });

  if (query.q !== '') search.set('q', query.q);

  if (query.category !== null) search.set('category', query.category);

  return `/api/gallery?${search.toString()}`;
}

/** A listed slate's own page, as the index holds it. */
export const GallerySlateSchema = v.object({
  listing: GalleryListingSchema,
  /** The connections a visitor's own parts will ask them for, read from its share when the page is opened: a listed
   *  share is on each visitor's own access, so these are theirs, never its owner's. Absent when it could not be read. */
  needs: v.optional(v.array(RoomServiceSchema)),
  forks: v.optional(v.number()),
  /** People who used it this week. */
  people: v.optional(v.number()),
});

export type GallerySlate = v.InferOutput<typeof GallerySlateSchema>;

/** `GET`, public: a listed slate's {@link GallerySlate}. */
export function gallerySlatePath(workspace: string, slate: string): string {
  return `/api/gallery/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}`;
}

/** `GET`, public: a listed slate's picture by its digest. */
export function galleryPicturePath(workspace: string, slate: string, picture: string): string {
  return `${gallerySlatePath(workspace, slate)}/picture/${encodeURIComponent(picture)}`;
}

/** `POST` {@link GalleryStar}, signed in: stars a listed slate, or takes the star back. */
export const GALLERY_STAR_PATH = '/api/gallery/star';

export interface GalleryStar {
  readonly workspace: string;
  readonly slate: string;
  readonly on: boolean;
}

/** `POST` {@link GalleryReport}, signed in: reports a listed slate to the operators. */
export const GALLERY_REPORT_PATH = '/api/gallery/report';

export interface GalleryReport {
  readonly workspace: string;
  readonly slate: string;
  readonly reason: string;
}
