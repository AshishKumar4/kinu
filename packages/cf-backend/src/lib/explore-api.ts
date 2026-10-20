/**
 * Explore: one feed of apps to open (listed slates, the Gallery's) and workspaces to install (workspace blueprints),
 * Kinu's own first. `/api/explore` answers both kinds ranked together; a workspace blueprint has a page of its own and
 * an install. An app's own page is the Gallery's (`/gallery/:workspace/:slate`).
 */
import * as v from "valibot";
import { Effect } from "effect";
import {
  workspaceBlueprintPath, BlueprintPageSchema, explorePath, ExplorePageSchema, GALLERY_SORTS,
  type BlueprintPage, type ExploreKind, type ExplorePage, type GalleryCategory, type GallerySort,
} from "@kinu.run/core";
import { settle } from "@kinu.run/core/obs";
import { posted, request } from "./http";

export { EXPLORE_KINDS } from "@kinu.run/core";

export type { BlueprintPage, ExploreItem, ExploreKind, ExplorePage, WorkspaceCard } from "@kinu.run/core";

export type ExploreNeed = BlueprintPage["workspace"]["needs"][number];

export function readExplore(query: { q: string; kind: ExploreKind | null; category: GalleryCategory | null; sort: GallerySort; page: number }): Promise<ExplorePage> {
  return settle(request(ExplorePageSchema, explorePath(query)));
}

export function readBlueprint(id: string): Promise<BlueprintPage> {
  return settle(request(BlueprintPageSchema, workspaceBlueprintPath(id)));
}

/** Stars or unstars one of Kinu's workspace blueprints, as the signed-in person. */
export function starBlueprint(id: string, on: boolean): Promise<void> {
  return settle(posted(`${workspaceBlueprintPath(id)}/star`, { on }));
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
    method: "POST", json: { ...choice, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  }), (installed) => installed.workspace));
}

const AssistantSchema = v.object({ workspace: v.nullable(v.string()) });

/** The workspace Home opens on, or null: the owner's Personal assistant while it is theirs. */
export function readInstalledAssistant(): Promise<string | null> {
  return settle(Effect.map(request(AssistantSchema, "/api/user/assistant"), (read) => read.workspace));
}

export { GALLERY_SORTS };
