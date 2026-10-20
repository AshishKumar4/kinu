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
  /** How many people signed in have opened it, as its workspace last said: refreshed by its listing sync, at most hourly. */
  viewers: v.number(),
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

/** Explore's two kinds: an app opens a listed slate's share; a workspace installs a workspace blueprint. */
export const EXPLORE_KINDS = ['app', 'workspace'] as const;

export type ExploreKind = (typeof EXPLORE_KINDS)[number];

/** What an install reaches of the person's: a connection (an MCP preset id) or a secret by name, read or written, and
 *  why. A workspace blueprint declares it, its listing keeps it, and its card shows it. */
export const ExploreNeedSchema = v.strictObject({
  connection: v.nullable(v.string()),
  secret: v.nullable(v.string()),
  access: v.picklist(['read', 'write']),
  why: v.string(),
});

export type ExploreNeed = v.InferOutput<typeof ExploreNeedSchema>;

/** A workspace blueprint as Explore lists it. `maker.kinu`: one Kinu keeps. */
const WorkspaceCardSchema = v.object({
  id: v.string(),
  title: v.string(),
  line: v.string(),
  category: GalleryCategorySchema,
  maker: v.object({ name: v.string(), kinu: v.boolean() }),
  /** Its picture by name, or null for none. */
  picture: v.nullable(v.string()),
  installs: v.number(),
  stars: v.number(),
  starred: v.boolean(),
  needs: v.array(ExploreNeedSchema),
  listedAt: v.number(),
  featured: v.boolean(),
});

export type WorkspaceCard = v.InferOutput<typeof WorkspaceCardSchema>;

const ExploreItemSchema = v.variant('kind', [
  v.object({ kind: v.literal('app'), app: GalleryListingSchema, needs: v.array(ExploreNeedSchema) }),
  v.object({ kind: v.literal('workspace'), workspace: WorkspaceCardSchema }),
]);

export type ExploreItem = v.InferOutput<typeof ExploreItemSchema>;

/** One page of Explore, both kinds ranked together and Kinu's own first: `next` is the page after it, null at the end. */
export const ExplorePageSchema = v.object({ items: v.array(ExploreItemSchema), next: v.nullable(v.number()) });

export type ExplorePage = v.InferOutput<typeof ExplorePageSchema>;

/** `GET`, public: one page of Explore, of one kind when given. */
export function explorePath(query: { q: string; kind: ExploreKind | null; sort: GallerySort; category: GalleryCategory | null; page: number }): string {
  const search = new URLSearchParams({ q: query.q, sort: query.sort, page: String(query.page) });

  if (query.kind !== null) search.set('kind', query.kind);

  if (query.category !== null) search.set('category', query.category);

  return `/api/explore?${search.toString()}`;
}

/** A workspace blueprint's own page: what it does, what is inside, what it asks before acting. */
export const BlueprintPageSchema = v.object({
  workspace: WorkspaceCardSchema,
  about: v.array(v.object({ title: v.string(), body: v.string() })),
  inside: v.object({
    agents: v.array(v.object({ name: v.string(), about: v.string() })),
    /** Its schedules: when each runs and what it does. */
    automations: v.array(v.object({ label: v.string(), when: v.string(), does: v.string() })),
    slates: v.array(v.object({ title: v.string(), about: v.string() })),
    layout: v.picklist(['workbench', 'focus']),
    soul: v.string(),
  }),
  /** What it stops and asks before doing. */
  asks: v.array(v.string()),
  version: v.string(),
  updatedAt: v.number(),
});

export type BlueprintPage = v.InferOutput<typeof BlueprintPageSchema>;

/** `GET`, public: a workspace blueprint's {@link BlueprintPage}. */
export function workspaceBlueprintPath(id: string): string {
  return `/api/explore/workspaces/${encodeURIComponent(id)}`;
}
