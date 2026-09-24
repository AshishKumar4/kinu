/**
 * Client-safe half of slate sharing: nothing here imports the vendored runtime.
 * Blueprints carry no credentials and warn on secret-shaped text rather than promise none (S8).
 */
import * as v from 'valibot';
import type { SecretSighting } from '../safety/secret-patterns';
import { SLATE_BINDING_KINDS, type SlateBindingDeclaration } from './project';
import { LiveShareVisibilitySchema } from './live-share-visibility';


export const SHARE_KINDS = ['blueprint', 'live'] as const;

export type ShareKind = (typeof SHARE_KINDS)[number];

export { type LiveShareVisibility } from './live-share-visibility';


const SlateMemberEffectSchema = v.picklist(['read', 'mutate']);

const ShareGrantMemberSchema = v.object({
  slate: v.string(),
  binding: v.string(),
  member: v.string(),
  effect: SlateMemberEffectSchema,
});

export type ShareGrantMember = v.InferOutput<typeof ShareGrantMemberSchema>;

export const ShareGrantSchema = v.object({
  slates: v.array(v.string()),
  members: v.array(ShareGrantMemberSchema),
  /** Absent on old rows means forkable (D4). */
  fork: v.optional(v.boolean()),
});

export type ShareGrant = v.InferOutput<typeof ShareGrantSchema>;

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

const SlateGraphMemberSchema = v.object({
  member: v.string(),
  effect: SlateMemberEffectSchema,
  risk: v.object({ public: v.string(), users: v.string() }),
});

export type SlateGraphMember = v.InferOutput<typeof SlateGraphMemberSchema>;

const SlateGraphBindingSchema = v.object({
  slate: v.string(),
  name: v.string(),
  kind: v.picklist(SLATE_BINDING_KINDS),
  capability: SlateCapabilitySchema,
  members: v.array(SlateGraphMemberSchema),
  problem: v.optional(v.string()),
});

export type SlateGraphBinding = v.InferOutput<typeof SlateGraphBindingSchema>;

export const SlateCapabilityGraphSchema = v.object({
  slate: v.string(),
  slates: v.array(v.string()),
  bindings: v.array(SlateGraphBindingSchema),
});

export type SlateCapabilityGraph = v.InferOutput<typeof SlateCapabilityGraphSchema>;

export const LiveShareRecordSchema = v.object({
  id: v.string(),
  slate: v.string(),
  visibility: LiveShareVisibilitySchema,
  handle: v.string(),
  grant: ShareGrantSchema,
  createdAt: v.number(),
  revokedAt: v.nullable(v.number()),
  users: v.array(v.string()),
  /** Computed where the row is answered, never stored. */
  paused: v.optional(v.boolean()),
});

export type LiveShareRecord = v.InferOutput<typeof LiveShareRecordSchema>;

export const LiveShareCreatedSchema = v.object({
  share: LiveShareRecordSchema,
  url: v.nullable(v.string()),
});

export type LiveShareCreated = v.InferOutput<typeof LiveShareCreatedSchema>;

export const ViewerCallSchema = v.object({
  slate: v.string(),
  binding: v.string(),
  member: v.string(),
  effect: SlateMemberEffectSchema,
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

const SecretSightingSchema = v.object({
  path: v.string(), line: v.number(), pattern: v.string(), message: v.string(),
});

const SlateBindingDeclarationSchema = v.object({
  name: v.string(),
  kind: v.picklist(SLATE_BINDING_KINDS),
  target: v.string(),
  credentialed: v.boolean(),
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
  bindings: v.array(SlateBindingDeclarationSchema),
  credentialed: v.array(SlateBindingDeclarationSchema),
  warnings: v.array(SecretSightingSchema),
});

export type BlueprintInspection = v.InferOutput<typeof BlueprintInspectionSchema>;

export const SlateShareRecordSchema = v.object({
  id: v.string(),
  slate: v.string(),
  kind: v.picklist(SHARE_KINDS),
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
  bindings: v.array(SlateBindingDeclarationSchema),
  credentialed: v.array(SlateBindingDeclarationSchema),
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
  bindings: v.number(),
  visibility: v.optional(LiveShareVisibilitySchema),
  workspace: v.optional(v.string()),
  users: v.optional(v.array(v.string())),
  owner: v.optional(v.string()),
  /** A live share's fork switch: false when it is closed to forks. */
  fork: v.optional(v.boolean()),
});

export type SharedRow = v.InferOutput<typeof SharedRowSchema>;

/** No user-level slate index exists: each owned workspace is asked for its own. */
const OwnedSlateSchema = v.object({
  id: v.string(),
  title: v.string(),
  workspace: v.string(),
  bindings: v.number(),
  visibility: v.optional(LiveShareVisibilitySchema),
});

export type OwnedSlate = v.InferOutput<typeof OwnedSlateSchema>;

export const SharedLibrarySchema = v.object({
  slates: v.array(OwnedSlateSchema),
  mine: v.array(SharedRowSchema),
  received: v.array(SharedRowSchema),
});

export type SharedLibrary = v.InferOutput<typeof SharedLibrarySchema>;

/** `requirements` is the runtime's canonical unsatisfied set; `bindings` is the same set as `package.json` declares it. */
export const BlueprintForkSchema = v.object({
  workspace: v.string(),
  slate: v.string(),
  title: v.string(),
  requirements: v.array(v.object({ name: v.string(), facet: v.string() })),
  bindings: v.array(SlateBindingDeclarationSchema),
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

export type BlueprintWarning = SecretSighting;

export type { SlateBindingDeclaration };
