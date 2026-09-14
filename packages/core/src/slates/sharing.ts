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

/** The share kinds the row discriminates on. Phase 1 ships blueprints only. */
export const SHARE_KINDS = ['blueprint'] as const;

export type ShareKind = (typeof SHARE_KINDS)[number];

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

/** One row of the Shared page. `workspace` and `users` are set on the owner's
 *  own rows; `owner` names who shared a received row. */
const SharedRowSchema = v.object({
  id: v.string(),
  title: v.string(),
  description: v.string(),
  createdAt: v.number(),
  bindings: v.number(),
  workspace: v.optional(v.string()),
  users: v.optional(v.array(v.string())),
  owner: v.optional(v.string()),
});

export type SharedRow = v.InferOutput<typeof SharedRowSchema>;

/** The two Phase 1 lists. Public and "from people I know" are later lists on
 *  the same page. */
export const SharedLibrarySchema = v.object({
  mine: v.array(SharedRowSchema),
  received: v.array(SharedRowSchema),
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
