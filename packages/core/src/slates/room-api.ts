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
export const RoomPersonSchema = v.object({
  email: v.string(),
  /** Their display name, once they have opened the slate; null while only invited. */
  name: v.nullable(v.string()),
});

export type RoomPerson = v.InferOutput<typeof RoomPersonSchema>;

export const ROOM_ROLES = ['edit', 'use'] as const;

/** What the owner gives someone they add: Edit changes the code with their own agent; Use uses the slate. */
export const RoomRoleSchema = v.picklist(ROOM_ROLES);

export type RoomRole = v.InferOutput<typeof RoomRoleSchema>;

/** How this session holds the slate: as its owner, as someone the owner added, or through the link. */
export const RoomAccessSchema = v.picklist(['owner', 'edit', 'use', 'link'] as const);

export type RoomAccess = v.InferOutput<typeof RoomAccessSchema>;

/** The sheet's three audiences: derived from the room's people and its link, and set in one call. */
export const RoomAudienceSchema = v.picklist(['only-you', 'people', 'anyone'] as const);

export type RoomAudience = v.InferOutput<typeof RoomAudienceSchema>;

// ── What a grant reaches ────────────────────────────────────────────────────────────────────────────────────────

/** A connection as people know it: GitHub, an MCP server by its title, the workspace's own model. */
export const RoomServiceSchema = v.object({
  title: v.string(),
  kind: v.picklist(['github', 'mcp', 'ai', 'workspace'] as const),
});

export type RoomService = v.InferOutput<typeof RoomServiceSchema>;

export const RoomToolSchema = v.object({
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
export const RoomSourceSchema = v.object({
  holder: RoomPersonSchema,
  service: RoomServiceSchema,
  scope: v.nullable(v.string()),
  label: v.string(),
});

export type RoomSource = v.InferOutput<typeof RoomSourceSchema>;

/** What one grant reaches: a service, the tools it may call there, its scope, and whether any tool changes anything. */
export const RoomReachSchema = v.object({
  service: RoomServiceSchema,
  tools: v.array(RoomToolSchema),
  scope: v.nullable(v.string()),
  effect: v.boolean(),
});

export type RoomReach = v.InferOutput<typeof RoomReachSchema>;

// ── The share sheet (the owner's) ───────────────────────────────────────────────────────────────────────────────

export const GALLERY_CATEGORIES = ['work', 'money', 'home', 'developer', 'fun'] as const;

export const GalleryCategorySchema = v.picklist(GALLERY_CATEGORIES);

export type GalleryCategory = v.InferOutput<typeof GalleryCategorySchema>;

/** A function the owner lends: anyone using the slate calls it, and it runs with the owner's grant in a run of its own. */
export const SheetLendSchema = v.object({
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
export const SheetLendUseSchema = v.object({
  fn: v.string(),
  person: RoomPersonSchema,
  calls: v.number(),
  lastAt: v.number(),
});

export type SheetLendUse = v.InferOutput<typeof SheetLendUseSchema>;

export const SheetMemberSchema = v.object({
  person: RoomPersonSchema,
  role: RoomRoleSchema,
});

export type SheetMember = v.InferOutput<typeof SheetMemberSchema>;

export const SheetViewSchema = v.object({
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

export const RoomSessionSchema = v.object({
  /** Null for a visitor who has not signed in. */
  me: v.nullable(RoomPersonSchema),
  access: RoomAccessSchema,
  title: v.string(),
  owner: RoomPersonSchema,
  /** Edit: the owner, or someone added with Edit. */
  mayEdit: v.boolean(),
  /** Anyone signed in may fork: a fork is the code alone. */
  mayFork: v.boolean(),
  /** The slate's own page, for the live page's frame: its own host, entered as this session's person. */
  frame: v.string(),
});

export type RoomSession = v.InferOutput<typeof RoomSessionSchema>;

export const RoomPresenceSchema = v.object({
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
export const RoomAskSchema = v.variant('kind', [
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
export const RoomEndedSchema = v.object({
  kind: v.picklist(['removed', 'stopped'] as const),
  by: RoomPersonSchema,
});

export type RoomEnded = v.InferOutput<typeof RoomEndedSchema>;

/**
 * One part as this session sees it. A part is one function of the slate on one input; its key is the room's. Content
 * with a label reaches a person only in the script-free frame at `content`, never in the slate's own code.
 */
export const PartViewSchema = v.variant('state', [
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
export const ShowScopeSchema = v.picklist(['members', 'anyone'] as const);

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
  v.object({ op: v.literal('ask'), part: v.string() }),
  /** Mints this person's own grant for the part, after they saw what it reaches; also "use it again" after an edit. */
  v.object({ op: v.literal('allow'), part: v.string() }),
  v.object({ op: v.literal('show'), part: v.string(), scope: ShowScopeSchema }),
  v.object({ op: v.literal('unshow'), part: v.string() }),
  // A holder's, on an ask.
  v.object({ op: v.literal('showTo'), ask: v.string() }),
  v.object({ op: v.literal('showToMembers'), ask: v.string() }),
  v.object({ op: v.literal('approve'), ask: v.string() }),
  v.object({ op: v.literal('send'), ask: v.string() }),
  v.object({ op: v.literal('decline'), ask: v.string() }),
  // Anyone's, about themselves.
  v.object({ op: v.literal('here'), where: v.nullable(v.string()), typing: v.nullable(v.string()) }),
  v.object({ op: v.literal('leave') }),
]);

export type RoomCall = v.InferOutput<typeof RoomCallSchema>;

/** A refusal in the room's words, with a code the UI can act on. */
export const RoomRefusalSchema = v.object({
  reason: v.picklist(['denied', 'missing', 'bad_input', 'conflict'] as const),
  message: v.string(),
});

export const RoomClientFrameSchema = v.object({ id: v.number(), call: RoomCallSchema });

export type RoomClientFrame = v.InferOutput<typeof RoomClientFrameSchema>;

export const RoomServerFrameSchema = v.union([
  v.object({ id: v.number(), ok: v.literal(true) }),
  v.object({ id: v.number(), ok: v.literal(false), refusal: RoomRefusalSchema }),
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

/** A part's frame: the app's page for one part, embedded by the slate's own page. */
export function roomPartPath(workspace: string, slate: string, part: string): string {
  return `/s/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}/parts/${encodeURIComponent(part)}`;
}

// ── Drive, Gallery, fork ────────────────────────────────────────────────────────────────────────────────────────

/** A slate in someone's Drive that is not theirs: shared with them, or used through its link. */
export const DriveRoomCardSchema = v.object({
  workspace: v.string(),
  slate: v.string(),
  title: v.string(),
  owner: RoomPersonSchema,
  relation: v.picklist(['shared', 'used'] as const),
  /** Shared only. */
  role: v.optional(RoomRoleSchema),
  at: v.number(),
});

export type DriveRoomCard = v.InferOutput<typeof DriveRoomCardSchema>;

export const GalleryListingSchema = v.object({
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
});

export type GalleryListing = v.InferOutput<typeof GalleryListingSchema>;

export const GALLERY_SORTS = ['trending', 'new', 'stars'] as const;

export const GallerySortSchema = v.picklist(GALLERY_SORTS);

export type GallerySort = v.InferOutput<typeof GallerySortSchema>;

/** What forking a slate brings: its code; per part, whether it ran with someone's lend, which the fork does not keep. */
export const ForkPreviewSchema = v.object({
  title: v.string(),
  owner: RoomPersonSchema,
  parts: v.array(v.object({ fn: v.string(), lent: v.boolean(), needs: v.nullable(RoomServiceSchema) })),
});

export type ForkPreview = v.InferOutput<typeof ForkPreviewSchema>;

export const ForkedSchema = v.object({ workspace: v.string(), slate: v.string() });

export type Forked = v.InferOutput<typeof ForkedSchema>;
