/**
 * Client-safe contracts of slates crossing between people: what a slate reaches (its graph), the preview entry's paths,
 * share cards a recipient's Drive holds, and a fork's bundle. A slate's own sharing is its room's (`room-api.ts`).
 * Nothing here imports the vendored runtime; a fork carries no credential (S8).
 */
import * as v from 'valibot';
import type { Impact } from '@agent-core/core/facets';
import { LiveShareVisibilitySchema } from './live-share-visibility';

const SHARE_KINDS = ['blueprint', 'live'] as const;

export { type LiveShareVisibility } from './live-share-visibility';

/** What a call does, in agent-core's words. */
const ImpactSchema = v.picklist(['observe', 'mutate', 'externalSend', 'execute', 'delegate', 'administer'] as const satisfies readonly Impact[]);

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

export const VIEWER_EXCHANGE_PATH = '/__kinu/viewer';

/**
 * The app's entry to a workspace preview, `?to=<the preview's URL>`: it knows its visitor, and sends the workspace's
 * owner on to the preview with a ticket for its host. A browser is sent to the page; a CLI asks the route.
 */
export const PREVIEW_ENTRY_PATH = '/__kinu/preview';

export const CLI_PREVIEW_ENTRY_PATH = '/api/cli/preview';

/** The per-visitor request rate a workspace preview admits. */
export const SHARE_VIEWER_REQUESTS_PER_MINUTE = 120;

/** A share as its recipient's Drive holds it, written only by the owner's account; `owner` is the owner's email. */
export const ShareCardSchema = v.object({
  kind: v.picklist(SHARE_KINDS),
  title: v.string(),
  description: v.string(),
  createdAt: v.number(),
  owner: v.string(),
  visibility: v.optional(LiveShareVisibilitySchema),
  fork: v.optional(v.boolean()),
  /** A slate room's card: the role it was shared with, or none when it was used through its link. */
  role: v.optional(v.picklist(['edit', 'use'] as const)),
  /** A slate room's card: where it opens. */
  url: v.optional(v.string()),
});

export type ShareCard = v.InferOutput<typeof ShareCardSchema>;

/** `requirements` is the runtime's canonical unsatisfied set: a namespace each, which the forker's workspace answers. */
const BlueprintForkSchema = v.object({
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
