/**
 * Explore: one feed of apps to open (listed slates, the Gallery's) and workspaces to install (workspace blueprints),
 * Kinu's own first. `/api/explore` answers both kinds ranked together; a workspace blueprint has a page of its own and
 * an install. The routes are this design's (docs/HOME-EXPLORE.md); the Gallery's stay as they are.
 */
import * as v from "valibot";
import { Effect } from "effect";
import { GalleryPageSchema, GALLERY_CATEGORIES, GALLERY_SORTS, type GallerySort } from "@kinu.run/core";
import { settle } from "@kinu.run/core/obs";
import { request } from "./http";

/** A listed slate, as the Gallery answers it. */
const GalleryListingSchema = GalleryPageSchema.entries.listings.item;

export const EXPLORE_KINDS = ["app", "workspace"] as const;

export type ExploreKind = (typeof EXPLORE_KINDS)[number];

/** Who made it: a person, or Kinu itself for the blueprints it keeps (managed: updated by Kinu, never by a fork). */
const MakerSchema = v.object({ name: v.string(), kinu: v.boolean() });

/** What an install asks of you: a connection (an MCP preset) at a level of access, or a secret by name; and why. */
const NeedSchema = v.object({
  connection: v.nullable(v.string()),
  secret: v.nullable(v.string()),
  access: v.picklist(["read", "write"]),
  why: v.string(),
});

export type ExploreNeed = v.InferOutput<typeof NeedSchema>;

const WorkspaceCardSchema = v.object({
  id: v.string(),
  title: v.string(),
  line: v.string(),
  category: v.picklist(GALLERY_CATEGORIES),
  maker: MakerSchema,
  /** A picture of the workspace at work, or null for its logo. */
  picture: v.nullable(v.string()),
  installs: v.number(),
  stars: v.number(),
  starred: v.boolean(),
  needs: v.array(NeedSchema),
  listedAt: v.number(),
  featured: v.boolean(),
});

export type WorkspaceCard = v.InferOutput<typeof WorkspaceCardSchema>;

const ExploreItemSchema = v.variant("kind", [
  v.object({ kind: v.literal("app"), app: GalleryListingSchema, needs: v.array(NeedSchema) }),
  v.object({ kind: v.literal("workspace"), workspace: WorkspaceCardSchema }),
]);

export type ExploreItem = v.InferOutput<typeof ExploreItemSchema>;

const ExplorePageSchema = v.object({ items: v.array(ExploreItemSchema), next: v.nullable(v.number()) });

export type ExplorePage = v.InferOutput<typeof ExplorePageSchema>;

/** What a workspace blueprint holds, as its page shows it before you install it. */
const InsideSchema = v.object({
  agents: v.array(v.object({ name: v.string(), about: v.string() })),
  /** Its schedules and watches: when each runs and what it does. */
  automations: v.array(v.object({ label: v.string(), when: v.string(), does: v.string() })),
  slates: v.array(v.object({ title: v.string(), about: v.string() })),
  layout: v.picklist(["workbench", "focus"]),
  soul: v.string(),
});

const BlueprintPageSchema = v.object({
  workspace: WorkspaceCardSchema,
  about: v.array(v.object({ title: v.string(), body: v.string() })),
  inside: InsideSchema,
  /** What it stops and asks you before doing. */
  asks: v.array(v.string()),
  version: v.string(),
  updatedAt: v.number(),
});

export type BlueprintPage = v.InferOutput<typeof BlueprintPageSchema>;

export function readExplore(query: { q: string; kind: ExploreKind | null; category: string | null; sort: GallerySort; page: number }): Promise<ExplorePage> {
  const search = new URLSearchParams({ q: query.q, sort: query.sort, page: String(query.page) });

  if (query.kind !== null) search.set("kind", query.kind);

  if (query.category !== null) search.set("category", query.category);

  return settle(request(ExplorePageSchema, `/api/explore?${search.toString()}`));
}

export function readBlueprint(id: string): Promise<BlueprintPage> {
  return settle(request(BlueprintPageSchema, `/api/explore/workspaces/${encodeURIComponent(id)}`));
}

const InstalledSchema = v.object({ workspace: v.string() });

/** What an install chose; the owner's offset from UTC is this browser's, so their 08:00 is theirs. */
export interface InstallChoice {
  readonly displayName?: string;
  readonly agent?: string;
  readonly brief?: string;
  readonly home?: boolean;
}

/** Installs a workspace blueprint as a new workspace of yours; the Personal assistant may also become your Home. */
export function installBlueprint(id: string, choice: InstallChoice): Promise<string> {
  return settle(Effect.map(request(InstalledSchema, `/api/user/blueprints/${encodeURIComponent(id)}/install`, {
    method: "POST", json: { ...choice, utcOffsetMinutes: -new Date().getTimezoneOffset() },
  }), (installed) => installed.workspace));
}

const AssistantSchema = v.object({ workspace: v.nullable(v.string()) });

/** The workspace Home opens on, or null: the owner's Personal assistant while it is theirs. */
export function readInstalledAssistant(): Promise<string | null> {
  return settle(Effect.map(request(AssistantSchema, "/api/user/assistant"), (read) => read.workspace));
}

export { GALLERY_SORTS };
