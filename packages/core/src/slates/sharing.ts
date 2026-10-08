/**
 * Client-safe half of slate sharing: nothing here imports the vendored runtime.
 * Blueprints carry no credentials and warn on secret-shaped text rather than promise none (S8).
 */
import * as v from 'valibot';
import type { Impact } from '@agent-core/core/facets';
import { LiveShareVisibilitySchema } from './live-share-visibility';


export const SHARE_KINDS = ['blueprint', 'live'] as const;

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

export const ShareGrantSchema = v.object({
  slates: v.array(v.string()),
  members: v.array(ShareGrantMemberSchema),
  /** Absent on old rows means forkable (D4). */
  fork: v.optional(v.boolean()),
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

export const SlateCapabilityGraphSchema = v.object({
  slate: v.string(),
  slates: v.array(v.string()),
  namespaces: v.array(SlateGraphNamespaceSchema),
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

