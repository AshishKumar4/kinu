/**
 * Client-safe half of slate sharing: nothing here imports the vendored runtime.
 * Blueprints carry no credentials and warn on secret-shaped text rather than promise none (S8).
 */
import * as v from 'valibot';
import type { Impact } from '@agent-core/core/facets';
import { LiveShareVisibilitySchema } from './live-share-visibility';
import { ShareModeSchema, ShareStartSchema } from './share-modes';
import { GalleryCategorySchema } from './gallery-api';


const SHARE_KINDS = ['blueprint', 'live'] as const;

export type ShareKind = (typeof SHARE_KINDS)[number];

export { type LiveShareVisibility } from './live-share-visibility';


/** What a call does, in agent-core's words; a share approves and shows each member by it. */
const ImpactSchema = v.picklist(['observe', 'mutate', 'externalSend', 'execute', 'delegate', 'administer'] as const satisfies readonly Impact[]);

/** A member of a namespace on the slate's surface: `memory`, `workspace`, `mcp.<server>`, `slates.<id>`. */
const ShareGrantMemberSchema = v.object({
  slate: v.string(),
  namespace: v.string(),
  member: v.string(),
  impact: ImpactSchema,
});

export type ShareGrantMember = v.InferOutput<typeof ShareGrantMemberSchema>;

/**
 * An "Always for this slate" decision: its owner's standing approval of one shape of call the shared server makes on
 * their access (a member, on one root, as `partCallRoot` reads it) at one revision of the shared slate. Held on the
 * shared slate's `owner` shares; written only by the owner's answer to an effect's ask; void once the shared slate is at
 * another revision (share-policy.ts `preapprovedEffect`).
 */
const SharePreapprovalSchema = v.object({
  /** The slate that makes the call, as grant members name it: the shared slate, or one it hops to. */
  slate: v.string(),
  namespace: v.string(),
  member: v.string(),
  root: v.record(v.string(), v.string()),
  /** The shared slate's revision it was given at. */
  revision: v.string(),
});

export type SharePreapproval = v.InferOutput<typeof SharePreapprovalSchema>;

export const ShareGrantSchema = v.object({
  slates: v.array(v.string()),
  members: v.array(ShareGrantMemberSchema),
  /** Absent on old rows means forkable (D4). */
  fork: v.optional(v.boolean()),
  /** An `owner` share's standing approvals; absent means none. */
  preapproved: v.optional(v.array(SharePreapprovalSchema)),
});

export type ShareGrant = v.InferOutput<typeof ShareGrantSchema>;

const SlateGraphMemberSchema = v.object({
  member: v.string(),
  impact: ImpactSchema,
  risk: v.object({ public: v.string(), users: v.string() }),
});

export type SlateGraphMember = v.InferOutput<typeof SlateGraphMemberSchema>;

/** One namespace a slate has called, with the members it called there. */
const SlateGraphNamespaceSchema = v.object({
  slate: v.string(),
  namespace: v.string(),
  /** How the namespace reads to a person: an MCP server by its title. */
  title: v.string(),
  members: v.array(SlateGraphMemberSchema),
  problem: v.optional(v.string()),
});

export type SlateGraphNamespace = v.InferOutput<typeof SlateGraphNamespaceSchema>;

const SlateCapabilityGraphSchema = v.object({
  slate: v.string(),
  slates: v.array(v.string()),
  namespaces: v.array(SlateGraphNamespaceSchema),
});

export type SlateCapabilityGraph = v.InferOutput<typeof SlateCapabilityGraphSchema>;

/** What a share's server can reach, as the share sheet lists it before the owner turns on `owner` mode: the graph,
 *  and the revision of the slate it was read at, which approving names (null: the slate never built, so no reach can
 *  be approved). */
export const SlateReachSchema = v.object({ ...SlateCapabilityGraphSchema.entries, revision: v.nullable(v.string()) });

export type SlateReach = v.InferOutput<typeof SlateReachSchema>;

/** A share's numbers, from who opened it through its link (`slate_share_views`): its owner's to see, never who. */
const ShareViewsSchema = v.object({
  /** Distinct people signed in. */
  viewers: v.number(),
  /** Every open, signed out included. */
  opens: v.number(),
  /** Of `opens`, those by someone signed out, who are never counted as viewers. */
  signedOutOpens: v.number(),
});

export type ShareViews = v.InferOutput<typeof ShareViewsSchema>;

/** A live share as its store holds it. Its owner is answered it with what holds of it now (`OwnedLiveShareSchema`). */
const LiveShareRecordSchema = v.object({
  id: v.string(),
  slate: v.string(),
  visibility: LiveShareVisibilitySchema,
  handle: v.string(),
  grant: ShareGrantSchema,
  createdAt: v.number(),
  revokedAt: v.nullable(v.number()),
  users: v.array(v.string()),
  /** Of `users`, those added to edit the slate too. */
  editors: v.optional(v.array(v.string()), []),
  /** Whose access its server acts with (docs/SLATE-SHARING-NIMBUS.md §2). */
  mode: ShareModeSchema,
  /** `owner` mode: the revision whose reach the owner approved; null in `own` mode. */
  grantRevision: v.nullable(v.string()),
  /** The last editor of an unapproved batch, from the slate's edit mark; null once approved or rolled back. */
  editedBy: v.nullable(v.string()),
  /** Its card's words while its owner lists it in the Gallery; null when not listed, and always on an `owner` share. */
  gallery: v.nullable(v.object({ line: v.string(), category: GalleryCategorySchema })),
});

export type LiveShareRecord = v.InferOutput<typeof LiveShareRecordSchema>;

/**
 * A live share as its owner reads it, on their share sheet: its record, and what holds of it now, never stored. Every
 * answer that hands its owner a share is one (`SlateController.owned`): its list, its making, and each change to it.
 */
export const OwnedLiveShareSchema = v.object({
  ...LiveShareRecordSchema.entries,
  /** Its spend for today is spent: it answers no one until tomorrow. */
  paused: v.boolean(),
  /** `owner` mode whose slate was built anew since its reach was approved: its server acts with nothing until the owner
   *  approves again. */
  stale: v.boolean(),
  /** Who opened it. */
  views: ShareViewsSchema,
});

export type OwnedLiveShare = v.InferOutput<typeof OwnedLiveShareSchema>;

const ApprovedMembersSchema = v.array(v.strictObject({ slate: v.string(), namespace: v.string(), member: v.string() }));

/** `POST /api/shared/live`, its owner's: a slate shared live, in `own` mode unless they turn on `owner` over the reach
 *  they read at `revision` (its `SlateReach`). */
export const LiveShareBodySchema = v.object({
  workspace: v.string(),
  slate: v.string(),
  visibility: v.picklist(['users', 'public']),
  emails: v.optional(v.array(v.pipe(v.string(), v.trim(), v.email()))),
  /** Of the people a `users` share names, those added to edit the slate too; each is added if `emails` left them out. */
  editors: v.optional(v.array(v.pipe(v.string(), v.trim(), v.email()))),
  approved: v.optional(ApprovedMembersSchema),
  fork: v.optional(v.boolean()),
  mode: v.optional(ShareModeSchema),
  revision: v.optional(v.string()),
  /** H7, offered at a slate's first share: `empty` shares a copy made now, code only (`share.slate` is the copy's). */
  start: v.optional(ShareStartSchema),
});

export type LiveShareBody = v.InferOutput<typeof LiveShareBodySchema>;

/** `POST`, its owner's: a live share's mode set, or its reach approved again at the slate's revision now. */
export const LIVE_SHARE_MODE_PATH = '/api/shared/live/mode';

/** Its body: `owner` names the acting members approved and the revision the reach was read at. */
export const LiveShareModeBodySchema = v.variant('mode', [
  v.object({ workspace: v.string(), share: v.string(), mode: v.literal('own') }),
  v.object({
    workspace: v.string(), share: v.string(), mode: v.literal('owner'), revision: v.string(), approved: ApprovedMembersSchema,
  }),
]);

export type LiveShareModeBody = v.InferOutput<typeof LiveShareModeBodySchema>;

/** `POST`, its owner's: a live share listed in the Gallery with its card's words, or taken off it. Only an `own` share is
 *  listed (§2): one on its owner's access reaches what its owner reaches, which no listing may offer anyone. */
export const LIVE_SHARE_LISTING_PATH = '/api/shared/live/listing';

export const LiveShareListingBodySchema = v.variant('listed', [
  v.object({ workspace: v.string(), share: v.string(), listed: v.literal(true), line: v.pipe(v.string(), v.maxLength(140)), category: GalleryCategorySchema }),
  v.object({ workspace: v.string(), share: v.string(), listed: v.literal(false) }),
]);

export type LiveShareListingBody = v.InferOutput<typeof LiveShareListingBodySchema>;

/** `POST`, signed in: where a live share opens for this person (a public share's address, else their signed entry to
 *  one that names them), with the slate it serves and its title, which the page that frames it names it by. */
export const LIVE_SHARE_OPEN_PATH = '/api/shared/live/open';

export const LiveShareOpenSchema = v.object({ url: v.string(), slate: v.string(), title: v.string() });

export type LiveShareOpen = v.InferOutput<typeof LiveShareOpenSchema>;

/** `POST`, its owner's: the standing approvals of a slate's shared server that stand now, as its share sheet lists
 *  them beside the reach. */
export const LIVE_SHARE_PREAPPROVALS_PATH = '/api/shared/live/preapprovals';

export const SlatePreapprovalsBodySchema = v.object({ workspace: v.string(), slate: v.string() });

/** `POST`, its owner's: one standing approval taken back, from every share of the shared slate; answered as they stand
 *  after. */
export const LIVE_SHARE_PREAPPROVAL_WITHDRAW_PATH = '/api/shared/live/preapprovals/withdraw';

export const SlatePreapprovalWithdrawSchema = v.object({
  workspace: v.string(),
  /** The shared slate, whose sheet it is. */
  slate: v.string(),
  entry: v.object({ slate: v.string(), namespace: v.string(), member: v.string(), root: v.record(v.string(), v.string()) }),
});

export type SlatePreapprovalWithdraw = v.InferOutput<typeof SlatePreapprovalWithdrawSchema>;

/** A shared slate's standing approvals at its revision now (null where it has not built), one of each, whichever share
 *  holds it. */
export const SlatePreapprovalsSchema = v.object({
  slate: v.string(),
  revision: v.nullable(v.string()),
  preapproved: v.array(SharePreapprovalSchema),
});

export type SlatePreapprovals = v.InferOutput<typeof SlatePreapprovalsSchema>;

export const LiveShareCreatedSchema = v.object({
  share: OwnedLiveShareSchema,
  /** Its one link: the app's page for it (`APP_ROUTES.sharedLive`), which frames its host; null with no app origin. */
  url: v.nullable(v.string()),
});

export type LiveShareCreated = v.InferOutput<typeof LiveShareCreatedSchema>;

export const ViewerCallSchema = v.object({
  slate: v.string(),
  namespace: v.string(),
  member: v.string(),
  impact: ImpactSchema,
  ok: v.boolean(),
});

export type ViewerCall = v.InferOutput<typeof ViewerCallSchema>;

export const ViewerRequestRecordSchema = v.object({
  id: v.number(),
  share: v.string(),
  viewer: v.string(),
  slate: v.string(),
  path: v.string(),
  calls: v.array(ViewerCallSchema),
  outcome: v.string(),
  createdAt: v.number(),
  settledAt: v.nullable(v.number()),
});

export type ViewerRequestRecord = v.InferOutput<typeof ViewerRequestRecordSchema>;

/** `consented` is true only for the consent-page cookie; a ticket-minted cookie has not seen the disclaimer. */
export const ShareViewerClaimSchema = v.object({
  userId: v.nullable(v.string()),
  source: v.string(),
  consented: v.boolean(),
});

export type ShareViewerClaim = v.InferOutput<typeof ShareViewerClaimSchema>;

export const VIEWER_EXCHANGE_PATH = '/__kinu/viewer';

/**
 * The app's entry to a workspace preview, `?to=<the preview's URL>`: it knows its visitor, and sends the workspace's
 * owner on to the preview with a ticket for its host. A browser is sent to the page; a CLI asks the route.
 */
export const PREVIEW_ENTRY_PATH = '/__kinu/preview';

export const CLI_PREVIEW_ENTRY_PATH = '/api/cli/preview';

/** Viewer bounds (docs/SLATE-SHARING.md §2): per-viewer request rate and a per-share spend bound renewing each UTC day. */
export const SHARE_VIEWER_REQUESTS_PER_MINUTE = 120;

export const SHARE_SPEND_CAP_USD_PER_DAY = 2;

/** The ledger is cumulative, so the UTC day is part of the label. */
export function shareSpendLabel(share: string, day = new Date().toISOString().slice(0, 10)): string {
  return `share:${share}:${day}`;
}

/** The token is checked at the edge, so a forged address is refused without waking a workspace. */
export interface BlueprintAddress {
  readonly workspace: string;
  readonly share: string;
  readonly token: string;
}

const BLUEPRINT_ID_SEPARATOR = '~';

/** `~` is unambiguous: workspace names, nanoid and base32 bodies never contain it. */
const BLUEPRINT_ID = /^([A-Za-z0-9._-]{1,64})~([A-Za-z0-9_-]{1,64})~([a-z2-7]{15})$/;

export function formatBlueprintId(address: BlueprintAddress): string {
  return [address.workspace, address.share, address.token].join(BLUEPRINT_ID_SEPARATOR);
}

export function parseBlueprintId(id: string): BlueprintAddress | null {
  const match = BLUEPRINT_ID.exec(id);

  if (match === null) return null;

  return { workspace: match[1], share: match[2], token: match[3] };
}

export function blueprintPagePath(id: string): string {
  return `/shared/blueprint/${encodeURIComponent(id)}`;
}

export function liveSharePagePath(workspace: string, share: string): string {
  return `/shared/live/${encodeURIComponent(workspace)}/${encodeURIComponent(share)}`;
}

const SecretSightingSchema = v.object({
  path: v.string(), line: v.number(), pattern: v.string(), message: v.string(),
});

const BlueprintEntrySchema = v.object({
  path: v.string(),
  kind: v.picklist(['file', 'directory', 'symlink']),
  included: v.boolean(),
});

export type BlueprintEntry = v.InferOutput<typeof BlueprintEntrySchema>;

export const BlueprintInspectionSchema = v.object({
  slate: v.string(),
  version: v.string(),
  title: v.string(),
  description: v.string(),
  entries: v.array(BlueprintEntrySchema),
  /** The namespaces the slate has been seen calling: what a forker's own workspace must offer. */
  reaches: v.array(v.string()),
  warnings: v.array(SecretSightingSchema),
});

export type BlueprintInspection = v.InferOutput<typeof BlueprintInspectionSchema>;

export const SlateShareRecordSchema = v.object({
  id: v.string(),
  slate: v.string(),
  publication: v.string(),
  included: v.array(v.string()),
  createdAt: v.number(),
  revokedAt: v.nullable(v.number()),
  users: v.array(v.string()),
});

export type SlateShareRecord = v.InferOutput<typeof SlateShareRecordSchema>;

export const PublishedBlueprintSchema = v.object({
  share: SlateShareRecordSchema,
  inspection: BlueprintInspectionSchema,
});

export type PublishedBlueprint = v.InferOutput<typeof PublishedBlueprintSchema>;

export const BlueprintViewSchema = v.object({
  id: v.string(),
  title: v.string(),
  description: v.string(),
  reaches: v.array(v.string()),
  entries: v.array(BlueprintEntrySchema),
  warnings: v.array(SecretSightingSchema),
  createdAt: v.number(),
});

export type BlueprintView = v.InferOutput<typeof BlueprintViewSchema>;

const SharedRowSchema = v.object({
  id: v.string(),
  kind: v.picklist(SHARE_KINDS),
  share: v.string(),
  title: v.string(),
  description: v.string(),
  createdAt: v.number(),
  visibility: v.optional(LiveShareVisibilitySchema),
  workspace: v.optional(v.string()),
  /** A live share's slate, so a share of yours can show that slate's picture. */
  slate: v.optional(v.string()),
  users: v.optional(v.array(v.string())),
  owner: v.optional(v.string()),
  /** A live share's fork switch: false when it is closed to forks. */
  fork: v.optional(v.boolean()),
  /** A share given to this account since it last opened Shared. */
  unseen: v.optional(v.literal(true)),
});

export type SharedRow = v.InferOutput<typeof SharedRowSchema>;

/** A share as its recipient's Drive holds it, written only by the owner's account; `owner` is the owner's email. */
export const ShareCardSchema = v.object({
  kind: v.picklist(SHARE_KINDS),
  title: v.string(),
  description: v.string(),
  createdAt: v.number(),
  owner: v.string(),
  visibility: v.optional(LiveShareVisibilitySchema),
  fork: v.optional(v.boolean()),
});

export type ShareCard = v.InferOutput<typeof ShareCardSchema>;

const OwnedSlateSchema = v.object({
  id: v.string(),
  title: v.string(),
  workspace: v.string(),
  visibility: v.optional(LiveShareVisibilitySchema),
  picture: v.optional(v.string()),
});

export type OwnedSlate = v.InferOutput<typeof OwnedSlateSchema>;

export const SharedLibrarySchema = v.object({
  slates: v.array(OwnedSlateSchema),
  mine: v.array(SharedRowSchema),
  received: v.array(SharedRowSchema),
});

export type SharedLibrary = v.InferOutput<typeof SharedLibrarySchema>;

/** `requirements` is the runtime's canonical unsatisfied set: a namespace each, which the forker's workspace answers. */
export const BlueprintForkSchema = v.object({
  workspace: v.string(),
  slate: v.string(),
  title: v.string(),
  requirements: v.array(v.object({ name: v.string(), facet: v.string() })),
});

export type BlueprintFork = v.InferOutput<typeof BlueprintForkSchema>;

/** No slate id, workspace or credential: a bundle names nothing on the owner's side. */
export const BlueprintBundleSchema = v.object({
  skeleton: v.object({
    sourceDigest: v.string(),
    bindings: v.array(v.object({
      name: v.string(), facet: v.string(), compat: v.object({ spec: v.string(), host: v.string() }),
    })),
  }),
  tree: v.string(),
  blobs: v.record(v.string(), v.string()),
});

export type BlueprintBundle = v.InferOutput<typeof BlueprintBundleSchema>;


/** A share as the workspace overview lists it: a published blueprint, or a live share titled by its slate. */
export const SlateShareCardSchema = v.object({
  kind: v.picklist(SHARE_KINDS),
  share: v.string(),
  slate: v.string(),
  title: v.string(),
  description: v.string(),
  createdAt: v.number(),
  users: v.array(v.string()),
  visibility: v.optional(LiveShareVisibilitySchema),
  fork: v.optional(v.boolean()),
});

export type SlateShareCard = v.InferOutput<typeof SlateShareCardSchema>;

/**
 * Why a shared slate does not run, as its owner and the people it is shared with read it: a shared slate runs only what
 * its own folder builds alone (`scope: 'tree'`), and this one's does not.
 */
export function sharedBuildRefusal(slate: string): string {
  return `${slate} can't run while it's shared: its files in /slates/${slate} don't build on their own. Fix them, or ask the agent to, then open it again.`;
}
