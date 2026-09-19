/**
 * Slate sharing, the client-safe half: the share kinds, the blueprint address
 * grammar and the wire shapes every page reads. Nothing here imports the
 * vendored runtime, so the browser can value-import it through the root barrel.
 *
 * A BLUEPRINT is a committed slate version exported with every binding
 * unmapped: source, `package.json`, assets, nothing else. It carries no
 * credential — bindings travel as requirements, and a fork resolves each one
 * as the forker (S8). What the export cannot prove absent is a secret someone
 * pasted into the source, so a blueprint WARNS about secret-shaped text
 * (`secretSightings`) instead of promising there is none.
 */
import * as v from 'valibot';
import type { SecretSighting } from '../safety/secret-patterns';
import { SLATE_BINDING_KINDS, type SlateBindingDeclaration } from './project';
import { LiveShareVisibilitySchema } from './live-share-visibility';


/** The share kinds the row discriminates on: a blueprint exports a committed
 *  version's bytes; a live share admits viewers to the running slate under a
 *  grant. */
export const SHARE_KINDS = ['blueprint', 'live'] as const;

export type ShareKind = (typeof SHARE_KINDS)[number];

export { type LiveShareVisibility } from './live-share-visibility';


const SlateMemberEffectSchema = v.picklist(['read', 'mutate']);

/** One member of one binding on one slate that a live share grants. */
const ShareGrantMemberSchema = v.object({
  slate: v.string(),
  binding: v.string(),
  member: v.string(),
  effect: SlateMemberEffectSchema,
});

export type ShareGrantMember = v.InferOutput<typeof ShareGrantMemberSchema>;

/** What a live share admits: the slates a viewer may enter (the root plus
 *  every slate it reaches through an app binding) and the members each may
 *  call. */
export const ShareGrantSchema = v.object({
  slates: v.array(v.string()),
  members: v.array(ShareGrantMemberSchema),
  /** Whether a viewer may copy the slate's skeleton into a workspace of
   *  theirs (D4). Absent on rows written before the flag existed, and an
   *  absent flag means what it means for blueprints: forkable. */
  fork: v.optional(v.boolean()),
});

export type ShareGrant = v.InferOutput<typeof ShareGrantSchema>;

/** The other side of one binding, as the capability graph names it. */
const SlateCapabilitySchema = v.variant('kind', [
  v.object({ kind: v.literal('executor'), namespace: v.string() }),
  v.object({ kind: v.literal('mcp'), server: v.string(), title: v.string() }),
  v.object({ kind: v.literal('tool'), name: v.string() }),
  v.object({ kind: v.literal('memory') }),
  v.object({ kind: v.literal('tasks') }),
  v.object({ kind: v.literal('web') }),
  v.object({ kind: v.literal('rpc') }),
  v.object({ kind: v.literal('agent') }),
  v.object({ kind: v.literal('model'), tier: v.string() }),
  v.object({ kind: v.literal('slate'), id: v.string() }),
]);

export type SlateCapability = v.InferOutput<typeof SlateCapabilitySchema>;

/** One callable member of a graphed binding. `risk` says what a viewer
 *  triggering it does, once per visibility; a read member carries no risk
 *  text because there is nothing to warn about. */
const SlateGraphMemberSchema = v.object({
  member: v.string(),
  effect: SlateMemberEffectSchema,
  risk: v.object({ public: v.string(), users: v.string() }),
});

export type SlateGraphMember = v.InferOutput<typeof SlateGraphMemberSchema>;

/** One declared binding rendered for the share dialog: what it reaches, the
 *  members a grant could name, and the reason it cannot be granted when the
 *  workspace cannot honour it. */
const SlateGraphBindingSchema = v.object({
  slate: v.string(),
  name: v.string(),
  kind: v.picklist(SLATE_BINDING_KINDS),
  capability: SlateCapabilitySchema,
  members: v.array(SlateGraphMemberSchema),
  problem: v.optional(v.string()),
});

export type SlateGraphBinding = v.InferOutput<typeof SlateGraphBindingSchema>;

/** The whole grant surface of a share: the root slate's bindings plus every
 *  slate an app binding reaches, in walk order, root first. */
export const SlateCapabilityGraphSchema = v.object({
  slate: v.string(),
  slates: v.array(v.string()),
  bindings: v.array(SlateGraphBindingSchema),
});

export type SlateCapabilityGraph = v.InferOutput<typeof SlateCapabilityGraphSchema>;

/** A `slate_live_shares` row as the owner's surfaces read it. */
export const LiveShareRecordSchema = v.object({
  id: v.string(),
  slate: v.string(),
  visibility: LiveShareVisibilitySchema,
  handle: v.string(),
  grant: ShareGrantSchema,
  createdAt: v.number(),
  revokedAt: v.nullable(v.number()),
  /** Emails the owner named on this share, in the order they were added. */
  users: v.array(v.string()),
  /** True while the share's per-day spend bound is spent; the viewer route
   *  refuses until the bound renews. Set where the row is answered, never
   *  stored — the bound is computed, not recorded. */
  paused: v.optional(v.boolean()),
});

export type LiveShareRecord = v.InferOutput<typeof LiveShareRecordSchema>;

export const LiveShareCreatedSchema = v.object({
  share: LiveShareRecordSchema,
  url: v.nullable(v.string()),
});

export type LiveShareCreated = v.InferOutput<typeof LiveShareCreatedSchema>;

/** One binding call a viewer made inside a request, as the audit row records
 *  it. */
export const ViewerCallSchema = v.object({
  slate: v.string(),
  binding: v.string(),
  member: v.string(),
  effect: SlateMemberEffectSchema,
  ok: v.boolean(),
});

export type ViewerCall = v.InferOutput<typeof ViewerCallSchema>;

/** A `slate_viewer_requests` row: one open preview request and the calls it
 *  made, newest settled state on the row itself. */
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

/** Who a request on a share origin belongs to: the account a valid viewer
 *  cookie names, or null, plus the anonymous opener attributed by a signed
 *  hash of its source. `consented` is true only when the cookie is the one
 *  the consent page mints: a ticket-minted cookie names a user but has never
 *  seen the disclaimer, and a share that reaches anything credentialed shows
 *  the consent page until it arrives. The edge builds it, the socket upgrade
 *  carries it URL-encoded past the RPC boundary, and the host parses it back
 *  through this schema — so it lives in core, where both sides can name it
 *  without a worker-only import. */
export const ShareViewerClaimSchema = v.object({
  userId: v.nullable(v.string()),
  source: v.string(),
  consented: v.boolean(),
});

export type ShareViewerClaim = v.InferOutput<typeof ShareViewerClaimSchema>;

/** On a share origin: `?ticket=…` mints the identity cookie, `?consent=1` the
 *  consent one, both 303 `/`. Wire shape, so it lives beside the claim the
 *  same exchange produces rather than in the edge file that happens to mint
 *  it. */
export const VIEWER_EXCHANGE_PATH = '/__kinu/viewer';

/** The viewer bounds every live share runs under (docs/SLATE-SHARING.md §2):
 *  a fixed-minute request rate per viewer — the account a viewer cookie
 *  names, or the anonymous source hash — and a per-share spend bound that
 *  renews each UTC day. One viewer inside the bound is the share working;
 *  one viewer past it is one viewer refused, never the share paused. */
export const SHARE_VIEWER_REQUESTS_PER_MINUTE = 120;

export const SHARE_SPEND_CAP_USD_PER_DAY = 2;

/** The mission-budget label a share's spend debits under, per UTC day — the
 *  ledger is cumulative, so the day is part of the label. `share` is the
 *  share row id, `day` is YYYY-MM-DD. */
export function shareSpendLabel(share: string, day = new Date().toISOString().slice(0, 10)): string {
  return `share:${share}:${day}`;
}

/**
 * A blueprint's public address: the workspace that holds the row, the row's
 * id and a token the app host signs over the pair. The token is checked at
 * the edge before anything touches an object, so a guessed or revoked-and-
 * reforged address is refused without waking a workspace.
 */
export interface BlueprintAddress {
  readonly workspace: string;
  readonly share: string;
  readonly token: string;
}

const BLUEPRINT_ID_SEPARATOR = '~';

/** The workspace-name grammar (`identity/naming.ts`) admits no `~`, and the
 *  share id and token are nanoid / base32 bodies, so the separator is
 *  unambiguous in every position. */
const BLUEPRINT_ID = /^([A-Za-z0-9._-]{1,64})~([A-Za-z0-9_-]{1,64})~([a-z2-7]{15})$/;

export function formatBlueprintId(address: BlueprintAddress): string {
  return [address.workspace, address.share, address.token].join(BLUEPRINT_ID_SEPARATOR);
}

export function parseBlueprintId(id: string): BlueprintAddress | null {
  const match = BLUEPRINT_ID.exec(id);

  if (match === null) return null;

  return { workspace: match[1], share: match[2], token: match[3] };
}

/** The app-host page for one blueprint. */
export function blueprintPagePath(id: string): string {
  return `/shared/blueprint/${encodeURIComponent(id)}`;
}

const SecretSightingSchema = v.object({
  path: v.string(), line: v.number(), pattern: v.string(), message: v.string(),
});

const SlateBindingDeclarationSchema = v.object({
  name: v.string(),
  kind: v.picklist(SLATE_BINDING_KINDS),
  target: v.string(),
  credentialed: v.boolean(),
});

/** One entry of a version's tree as the share dialog and the blueprint page
 *  list it. `included` is the owner's choice for the dialog; a published
 *  blueprint lists included entries only. */
const BlueprintEntrySchema = v.object({
  path: v.string(),
  kind: v.picklist(['file', 'directory', 'symlink']),
  included: v.boolean(),
});

export type BlueprintEntry = v.InferOutput<typeof BlueprintEntrySchema>;

/**
 * What publishing a version would export, before anything is written: the
 * tree with the owner's include choice applied, the declared bindings, and
 * the secret shapes the included text carries. The dialog shows this and asks
 * for confirmation; `publish` answers the same shape for what it wrote.
 */
export const BlueprintInspectionSchema = v.object({
  slate: v.string(),
  version: v.string(),
  title: v.string(),
  description: v.string(),
  entries: v.array(BlueprintEntrySchema),
  bindings: v.array(SlateBindingDeclarationSchema),
  /** The section-3 set: what a forker must connect, and what the dialog names (S4). */
  credentialed: v.array(SlateBindingDeclarationSchema),
  warnings: v.array(SecretSightingSchema),
});

export type BlueprintInspection = v.InferOutput<typeof BlueprintInspectionSchema>;

/** The `slate_shares` row, as the owner's surfaces read it. */
export const SlateShareRecordSchema = v.object({
  id: v.string(),
  slate: v.string(),
  kind: v.picklist(SHARE_KINDS),
  publication: v.string(),
  included: v.array(v.string()),
  createdAt: v.number(),
  revokedAt: v.nullable(v.number()),
  /** Emails the owner named on this share, in the order they were added. */
  users: v.array(v.string()),
});

export type SlateShareRecord = v.InferOutput<typeof SlateShareRecordSchema>;

export const PublishedBlueprintSchema = v.object({
  share: SlateShareRecordSchema,
  inspection: BlueprintInspectionSchema,
});

export type PublishedBlueprint = v.InferOutput<typeof PublishedBlueprintSchema>;

/** The read-only page: everything a viewer without an account may see. */
export const BlueprintViewSchema = v.object({
  id: v.string(),
  title: v.string(),
  description: v.string(),
  bindings: v.array(SlateBindingDeclarationSchema),
  credentialed: v.array(SlateBindingDeclarationSchema),
  entries: v.array(BlueprintEntrySchema),
  warnings: v.array(SecretSightingSchema),
  createdAt: v.number(),
});

export type BlueprintView = v.InferOutput<typeof BlueprintViewSchema>;

/** One row of the Shared page: `kind` says whether it opens a blueprint page
 *  or a running slate, `share` is the row id in the owner's workspace, and
 *  `workspace` names that workspace wherever the app host needs to open the
 *  row — the owner's own rows, received rows and public rows alike. `owner`
 *  names who shared a received row. */
const SharedRowSchema = v.object({
  id: v.string(),
  kind: v.picklist(SHARE_KINDS),
  share: v.string(),
  title: v.string(),
  description: v.string(),
  createdAt: v.number(),
  bindings: v.number(),
  visibility: v.optional(LiveShareVisibilitySchema),
  workspace: v.optional(v.string()),
  users: v.optional(v.array(v.string())),
  owner: v.optional(v.string()),
});

export type SharedRow = v.InferOutput<typeof SharedRowSchema>;

/** The four lists of the Shared page: the owner's own rows, rows shared with
 *  the owner, public rows, and rows from people the owner knows. */
export const SharedLibrarySchema = v.object({
  mine: v.array(SharedRowSchema),
  received: v.array(SharedRowSchema),
  public: v.array(SharedRowSchema),
  known: v.array(SharedRowSchema),
});

export type SharedLibrary = v.InferOutput<typeof SharedLibrarySchema>;

/** What admitting a blueprint into a workspace produced: the new slate and the
 *  bindings the forker must connect before it can run. `requirements` is the
 *  vendored runtime's own unsatisfied set, named canonically; `bindings` is the
 *  same set as `package.json` declares it, which is what the panel shows. */
export const BlueprintForkSchema = v.object({
  workspace: v.string(),
  slate: v.string(),
  title: v.string(),
  requirements: v.array(v.object({ name: v.string(), facet: v.string() })),
  bindings: v.array(SlateBindingDeclarationSchema),
});

export type BlueprintFork = v.InferOutput<typeof BlueprintForkSchema>;

/**
 * The bytes a fork carries: the tree exactly as the publisher's content store
 * serialised it (its digest is the skeleton's `sourceDigest`), every file blob
 * by digest, and the skeleton's own data. No slate id, no workspace, no
 * credential: a bundle names nothing on the owner's side.
 */
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

export type BlueprintWarning = SecretSighting;

export type { SlateBindingDeclaration };
