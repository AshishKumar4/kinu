/**
 * A slate room's client API: what the live page, the share sheet, a part frame, the Drive and the Gallery read and call.
 * Client-safe: valibot and nothing of the runtime.
 *
 * Every slate runs in its room (`SlateRoom`, one per slate), which is the one caretaker of who may do what with it
 * (docs/SLATE-SHARING-SECURITY.md; the model is `lean/Kinu/Sharing/Model.lean`). A person's page holds one socket to the
 * room. The room pushes that session's whole {@link RoomView} after every change that touches it; a call answers only
 * whether it was done, and the next view carries its effect. Nothing polls.
 *
 * Words: the room gives facts (a service's title, a tool's title, a scope, whether a call changes anything); the UI writes
 * the sentences around them.
 */
import * as v from 'valibot';

/** Who someone is to a room. People are named by email: an account id is derived from it (`accountIdFor`). */
const RoomPersonSchema = v.object({
  email: v.string(),
  /** Their display name, once they have opened the slate; null while only invited. */
  name: v.nullable(v.string()),
});

export type RoomPerson = v.InferOutput<typeof RoomPersonSchema>;

const ROOM_ROLES = ['edit', 'use'] as const;

/** What the owner gives someone they add: Edit changes the code with their own agent; Use uses the slate. */
const RoomRoleSchema = v.picklist(ROOM_ROLES);

export type RoomRole = v.InferOutput<typeof RoomRoleSchema>;

/** How this session holds the slate: as its owner, as someone the owner added, or through the link. */
const RoomAccessSchema = v.picklist(['owner', 'edit', 'use', 'link'] as const);

export type RoomAccess = v.InferOutput<typeof RoomAccessSchema>;

/** The sheet's three audiences: derived from the room's people and its link, and set in one call. */
const RoomAudienceSchema = v.picklist(['only-you', 'people', 'anyone'] as const);

export type RoomAudience = v.InferOutput<typeof RoomAudienceSchema>;

// ── What a grant reaches ────────────────────────────────────────────────────────────────────────────────────────

/** A connection as people know it: GitHub, an MCP server by its title, the workspace's own model. */
const RoomServiceSchema = v.object({
  title: v.string(),
  kind: v.picklist(['github', 'mcp', 'ai', 'workspace'] as const),
});

export type RoomService = v.InferOutput<typeof RoomServiceSchema>;

const RoomToolSchema = v.object({
  name: v.string(),
  title: v.string(),
  /** Changes nothing, by the connection's own declaration. */
  readOnly: v.boolean(),
});

export type RoomTool = v.InferOutput<typeof RoomToolSchema>;

/**
 * Where data comes from, as one tag of a label: whose connection read it, the service, and the scope it is fixed to
 * (`acme/secret`), null for the whole service. `label` is the words a person sees: the scope, else the service's title.
 */
const RoomSourceSchema = v.object({
  holder: RoomPersonSchema,
  service: RoomServiceSchema,
  scope: v.nullable(v.string()),
  label: v.string(),
  /** The service can say whether this session's person reads the scope directly, with their own connection (`check`). */
  checkable: v.boolean(),
});

export type RoomSource = v.InferOutput<typeof RoomSourceSchema>;

/** What one grant reaches: a service, the tools it may call there, its scope, and whether any tool changes anything. */
const RoomReachSchema = v.object({
  service: RoomServiceSchema,
  tools: v.array(RoomToolSchema),
  scope: v.nullable(v.string()),
  effect: v.boolean(),
});

export type RoomReach = v.InferOutput<typeof RoomReachSchema>;

// ── The share sheet (the owner's) ───────────────────────────────────────────────────────────────────────────────

export const GALLERY_CATEGORIES = ['work', 'money', 'home', 'developer', 'fun'] as const;

const GalleryCategorySchema = v.picklist(GALLERY_CATEGORIES);

export type GalleryCategory = v.InferOutput<typeof GalleryCategorySchema>;

/** A function the owner lends: anyone using the slate calls it, and it runs with the owner's grant in a run of its own. */
const SheetLendSchema = v.object({
  fn: v.string(),
  reach: RoomReachSchema,
  /** Someone types its input (its contract takes free text), and that input reaches the service. */
  free: v.boolean(),
  /** Who sees what it returns: everyone who can open the slate, or the owner alone. */
  shown: v.picklist(['everyone', 'holder'] as const),
  on: v.boolean(),
  /** Whose edit suspended it, until the owner lends it again; null while it runs as lent. */
  suspendedBy: v.nullable(RoomPersonSchema),
});

export type SheetLend = v.InferOutput<typeof SheetLendSchema>;

/** Who called a lent function, and how often. */
const SheetLendUseSchema = v.object({
  fn: v.string(),
  person: RoomPersonSchema,
  calls: v.number(),
  lastAt: v.number(),
});

export type SheetLendUse = v.InferOutput<typeof SheetLendUseSchema>;

const SheetMemberSchema = v.object({
  person: RoomPersonSchema,
  role: RoomRoleSchema,
});

export type SheetMember = v.InferOutput<typeof SheetMemberSchema>;

const SheetViewSchema = v.object({
  audience: RoomAudienceSchema,
  /** The link while it is on: open to anyone who has it. */
  url: v.nullable(v.string()),
  people: v.array(SheetMemberSchema),
  /** Whose private items the slate holds: they stay hidden from link visitors. */
  privateOf: v.array(RoomPersonSchema),
  /** The Gallery listing, while the slate is listed. */
  listing: v.nullable(v.object({ line: v.string(), category: GalleryCategorySchema })),
  lends: v.array(SheetLendSchema),
  uses: v.array(SheetLendUseSchema),
  /** A secret's shape in the current code: while one is there the link stays off. */
  secret: v.nullable(v.object({ file: v.string(), line: v.number(), kind: v.string() })),
});

export type SheetView = v.InferOutput<typeof SheetViewSchema>;

// ── The live slate ──────────────────────────────────────────────────────────────────────────────────────────────

const RoomSessionSchema = v.object({
  /** Null for a visitor who has not signed in. */
  me: v.nullable(RoomPersonSchema),
  access: RoomAccessSchema,
  title: v.string(),
  owner: RoomPersonSchema,
  /** Edit: the owner, or someone added with Edit. */
  mayEdit: v.boolean(),
  /** Anyone signed in may fork: a fork is the code alone. */
  mayFork: v.boolean(),
  /** The people added, the owner included: "everyone here now" for a show. Empty for a link visitor. */
  members: v.array(RoomPersonSchema),
  /** The slate's own page, for the live page's frame: its own host, entered as this session's person. */
  frame: v.string(),
});

export type RoomSession = v.InferOutput<typeof RoomSessionSchema>;

const RoomPresenceSchema = v.object({
  /** People here now, signed in, the session's own person included. */
  here: v.array(v.object({
    person: RoomPersonSchema,
    /** Where in the slate, in its own words, as its page reports it. */
    where: v.nullable(v.string()),
    typing: v.nullable(v.string()),
  })),
  /** Visitors here who have not signed in: counted, never named. */
  signedOut: v.number(),
});

export type RoomPresence = v.InferOutput<typeof RoomPresenceSchema>;

/** The parts a holder is asked about: someone asks to see one, an effect waits, or their own data would leave them. */
const RoomAskSchema = v.variant('kind', [
  v.object({
    kind: v.literal('show'),
    id: v.string(),
    from: RoomPersonSchema,
    part: v.object({ key: v.string(), fn: v.string() }),
    source: RoomSourceSchema,
  }),
  v.object({
    kind: v.literal('effect'),
    id: v.string(),
    from: RoomPersonSchema,
    fn: v.string(),
    service: RoomServiceSchema,
    tool: RoomToolSchema,
    scope: v.nullable(v.string()),
    /** The exact argument the call would send, as text. */
    argument: v.string(),
  }),
  /** Someone asks the holder to lend a function again, after another person's edit suspended it. */
  v.object({
    kind: v.literal('lend'),
    id: v.string(),
    from: RoomPersonSchema,
    fn: v.string(),
    editor: RoomPersonSchema,
  }),
  v.object({
    kind: v.literal('outflow'),
    id: v.string(),
    fn: v.string(),
    source: RoomSourceSchema,
    service: RoomServiceSchema,
    tool: RoomToolSchema,
    /** The argument that would leave, as text: it names where it goes. */
    argument: v.string(),
  }),
]);

export type RoomAsk = v.InferOutput<typeof RoomAskSchema>;

/** Why this session's slate is gone: the owner removed this person, or stopped sharing. */
const RoomEndedSchema = v.object({
  kind: v.picklist(['removed', 'stopped'] as const),
  by: RoomPersonSchema,
});

export type RoomEnded = v.InferOutput<typeof RoomEndedSchema>;

/**
 * One part as this session sees it. A part is one function of the slate on one input; its key is the room's. Content
 * with a label reaches a person only in the script-free frame at `content`, never in the slate's own code.
 */
const PartViewSchema = v.variant('state', [
  /** Computing. */
  v.object({ state: v.literal('running'), key: v.string(), fn: v.string() }),
  /** Shown. `from` names the others whose data it holds, shown to this person by them; empty for public data. */
  v.object({ state: v.literal('shown'), key: v.string(), fn: v.string(), from: v.array(RoomSourceSchema), content: v.string() }),
  /** This person's own private data: shown to them alone, or as far as they chose to show it. */
  v.object({
    state: v.literal('mine'), key: v.string(), fn: v.string(), source: RoomSourceSchema,
    shownTo: v.picklist(['me', 'members', 'anyone'] as const), content: v.string(),
  }),
  /** Data this person cannot read: whose it is, and whether they asked. */
  v.object({
    state: v.literal('placeholder'), key: v.string(), fn: v.string(),
    sources: v.array(RoomSourceSchema), asked: v.boolean(),
  }),
  /** The part needs this person's own connection: connected but not allowed here, or not connected at all. */
  v.object({
    state: v.literal('needs-connection'), key: v.string(), fn: v.string(), reach: RoomReachSchema, connected: v.boolean(),
  }),
  /** A visitor who has not signed in asked for something only a signed-in person may do. */
  v.object({ state: v.literal('needs-sign-in'), key: v.string(), fn: v.string() }),
  /** Someone else changed this part's code: this person's grant waits until they use it again. */
  v.object({ state: v.literal('edited'), key: v.string(), fn: v.string(), editor: RoomPersonSchema, reach: RoomReachSchema }),
  /** A lend this part runs with waits for its holder to lend it again, after someone else's edit. */
  v.object({ state: v.literal('waiting'), key: v.string(), fn: v.string(), holder: RoomPersonSchema }),
  /** It ran and failed, in the slate's own words. */
  v.object({ state: v.literal('failed'), key: v.string(), fn: v.string(), message: v.string() }),
]);

export type PartView = v.InferOutput<typeof PartViewSchema>;

/** Everything one session reads, pushed whole on every change. */
export const RoomViewSchema = v.object({
  session: RoomSessionSchema,
  presence: RoomPresenceSchema,
  /** The parts this session has opened, by key. */
  parts: v.record(v.string(), PartViewSchema),
  /** What this person, as a holder, is asked to decide. */
  asks: v.array(RoomAskSchema),
  /** Set once, when the room ends this session. */
  ended: v.nullable(RoomEndedSchema),
  /** The owner's sheet; null for everyone else. */
  sheet: v.nullable(SheetViewSchema),
});

export type RoomView = v.InferOutput<typeof RoomViewSchema>;

// ── Calls ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Everyone here now" is the people added at that moment; "anyone" is anyone who can open the slate, link visitors too. */
const ShowScopeSchema = v.picklist(['members', 'anyone'] as const);

export type ShowScope = v.InferOutput<typeof ShowScopeSchema>;

export const RoomCallSchema = v.variant('op', [
  // The owner's.
  v.object({ op: v.literal('setAudience'), audience: RoomAudienceSchema }),
  v.object({ op: v.literal('invite'), email: v.string(), role: RoomRoleSchema }),
  v.object({ op: v.literal('setRole'), email: v.string(), role: RoomRoleSchema }),
  /** Ends every session they hold and keeps them off the link until they are added again. */
  v.object({ op: v.literal('remove'), email: v.string() }),
  v.object({ op: v.literal('list'), line: v.string(), category: GalleryCategorySchema }),
  v.object({ op: v.literal('unlist') }),
  v.object({ op: v.literal('setLend'), fn: v.string(), on: v.boolean() }),
  v.object({ op: v.literal('setLendShown'), fn: v.string(), shown: v.picklist(['everyone', 'holder'] as const) }),
  // Anyone's, on a part.
  v.object({ op: v.literal('open'), part: v.string() }),
  /** Asks the holders of what the part hides to show it; on a waiting part, asks the lend's holder to lend it again. */
  v.object({ op: v.literal('ask'), part: v.string() }),
  /** Runs the reader check of the part's checkable sources with this person's own connection. */
  v.object({ op: v.literal('check'), part: v.string() }),
  /** Mints this person's own grant for the part, after they saw what it reaches; also "use it again" after an edit. */
  v.object({ op: v.literal('allow'), part: v.string() }),
  v.object({ op: v.literal('show'), part: v.string(), scope: ShowScopeSchema }),
  v.object({ op: v.literal('unshow'), part: v.string() }),
  // A holder's, on an ask.
  v.object({ op: v.literal('showTo'), ask: v.string() }),
  v.object({ op: v.literal('showToMembers'), ask: v.string() }),
  /** An effect goes ahead; on a lend ask, the function is lent again at the code as it now stands. */
  v.object({ op: v.literal('approve'), ask: v.string() }),
  v.object({ op: v.literal('send'), ask: v.string() }),
  v.object({ op: v.literal('decline'), ask: v.string() }),
  // Anyone's, about themselves.
  v.object({ op: v.literal('here'), where: v.nullable(v.string()), typing: v.nullable(v.string()) }),
  v.object({ op: v.literal('leave') }),
]);

export type RoomCall = v.InferOutput<typeof RoomCallSchema>;

/** A refusal in the room's words, with a code the UI can act on. */
const RoomRefusalSchema = v.object({
  reason: v.picklist(['denied', 'missing', 'bad_input', 'unavailable'] as const),
  message: v.string(),
});

export const RoomClientFrameSchema = v.object({ id: v.number(), call: RoomCallSchema });

export type RoomClientFrame = v.InferOutput<typeof RoomClientFrameSchema>;

/** A call's answer (`refusal` null: done) or a pushed view. */
export const RoomServerFrameSchema = v.union([
  v.object({ id: v.number(), refusal: v.nullable(RoomRefusalSchema) }),
  v.object({ view: RoomViewSchema }),
]);

export type RoomServerFrame = v.InferOutput<typeof RoomServerFrameSchema>;

// ── Addresses ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The live page: open to the owner and the people added; `k` is the link's key, which admits anyone while it is on. */
export function roomPagePath(workspace: string, slate: string, key?: string): string {
  const path = `/s/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}`;

  return key === undefined ? path : `${path}?k=${encodeURIComponent(key)}`;
}

/** The room's socket on the app's origin: the session cookie names the person, `k` admits a link visitor. */
export function roomSocketPath(workspace: string, slate: string): string {
  return `/api/rooms/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}`;
}

/**
 * Before the socket: whether this session may open the room. 200 answers a {@link RoomEntry}; 401 means sign in first,
 * 403 that the slate is not shared with this signed-in person, 404 that no such slate or link exists, 410 that its link
 * was stopped.
 */
export function roomEntryPath(workspace: string, slate: string): string {
  return `${roomSocketPath(workspace, slate)}/entry`;
}

export const RoomEntrySchema = v.object({ title: v.string(), owner: RoomPersonSchema, access: RoomAccessSchema });

export type RoomEntry = v.InferOutput<typeof RoomEntrySchema>;

/** GET answers a {@link ForkPreview}; POST `{ workspace }` forks into that workspace of the caller's and answers {@link Forked}. */
export function roomForkPath(workspace: string, slate: string): string {
  return `${roomSocketPath(workspace, slate)}/fork`;
}

// ── Drive, Gallery, fork ────────────────────────────────────────────────────────────────────────────────────────

/** A slate in someone's Drive that is not theirs: shared with them, or used through its link. */
const DriveRoomCardSchema = v.object({
  workspace: v.string(),
  slate: v.string(),
  title: v.string(),
  owner: RoomPersonSchema,
  relation: v.picklist(['shared', 'used'] as const),
  /** Shared only. */
  role: v.optional(RoomRoleSchema),
  at: v.number(),
  /** Shared with this person since they last opened Shared. */
  unseen: v.optional(v.literal(true)),
  /** Where it opens: {@link roomPagePath} when shared, the link with its key when used through it. */
  url: v.string(),
});

export type DriveRoomCard = v.InferOutput<typeof DriveRoomCardSchema>;

const GalleryListingSchema = v.object({
  workspace: v.string(),
  slate: v.string(),
  title: v.string(),
  line: v.string(),
  category: GalleryCategorySchema,
  owner: v.object({ name: v.string() }),
  stars: v.number(),
  starred: v.boolean(),
  listedAt: v.number(),
  /** The services a fork asks its forker to connect, one per kind. */
  needs: v.array(RoomServiceSchema),
  /** Its picture's digest, taken from a fresh visit, once there is one: {@link galleryPicturePath}. */
  picture: v.optional(v.string()),
  /** One of this week's top two by trending. */
  featured: v.boolean(),
  /** Its link, the one way in: `/s/<ws>/<slate>?k=<key>`. Unlisted the moment the link goes off. */
  url: v.string(),
});

export type GalleryListing = v.InferOutput<typeof GalleryListingSchema>;

export const GALLERY_SORTS = ['trending', 'new', 'stars'] as const;

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

/** A listed slate's own page: what a fork gets, and whether any part runs with its author's own lend. */
export const GallerySlateSchema = v.object({
  listing: GalleryListingSchema,
  /** The files a fork gets. */
  files: v.array(v.string()),
  /** When the version its link opens was published. */
  updatedAt: v.number(),
  readsAuthor: v.boolean(),
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

/** A slate of this person's own, as the Drive lists it: its audience once its room has one. */
const DriveSlateSchema = v.object({
  id: v.string(),
  title: v.string(),
  workspace: v.string(),
  audience: v.optional(RoomAudienceSchema),
  picture: v.optional(v.string()),
});

export type DriveSlate = v.InferOutput<typeof DriveSlateSchema>;

/** `GET /api/shared`: the person's own slates, the ones shared with them, the ones they used, and the ones they starred. */
export const DriveLibrarySchema = v.object({
  slates: v.array(DriveSlateSchema),
  shared: v.array(DriveRoomCardSchema),
  used: v.array(DriveRoomCardSchema),
  starred: v.array(GalleryListingSchema),
});

export type DriveLibrary = v.InferOutput<typeof DriveLibrarySchema>;

/** What forking a slate brings: its code; per part, whether it ran with someone's lend, which the fork does not keep. */
export const ForkPreviewSchema = v.object({
  title: v.string(),
  owner: RoomPersonSchema,
  parts: v.array(v.object({ fn: v.string(), lent: v.boolean(), needs: v.nullable(RoomServiceSchema) })),
});

export type ForkPreview = v.InferOutput<typeof ForkPreviewSchema>;

export const ForkedSchema = v.object({ workspace: v.string(), slate: v.string() });

export type Forked = v.InferOutput<typeof ForkedSchema>;
