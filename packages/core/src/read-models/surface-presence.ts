import type { PinnedPreviewPort } from "../preview/preview-ports";
import type { ForkNode, TabPresence } from "../protocol";
import type { SlateSummary } from "../slates/rpc";

export const SLATE_PREFIX = "slate:";

export const SURFACES = ["Work", "Changes", "Files", "Swarms", "Agent", "Environment"] as const;

export const ACTIVITY_SURFACE = "Activity";

export type SlateSurfaceKind = `${typeof SLATE_PREFIX}${string}`;

export type SurfaceKind = (typeof SURFACES)[number] | typeof ACTIVITY_SURFACE | SlateSurfaceKind | `preview:${string}`;

export interface SurfaceContent {
	tabPresence: TabPresence | undefined;
	mctsTrees: ReadonlyMap<string, ForkNode>;
	slates: readonly SlateSummary[] | undefined;
	hasChanges?: boolean;
}

/** Changes gates on the change-set the tab has read, not `TabPresence`. */
export function surfaceHasContent(surface: SurfaceKind, content: SurfaceContent): boolean {
	if (surface === "Work") return content.tabPresence?.work ?? true;

	if (surface === "Swarms") return (content.tabPresence?.explorations ?? true) || content.mctsTrees.size > 0;

	if (surface === "Changes") return content.hasChanges ?? false;

	if (surface.startsWith(SLATE_PREFIX)) {
		const id = surface.slice(SLATE_PREFIX.length);

		return content.slates?.some((slate) => slate.id === id) ?? false;
	}

	return true;
}

function firstVisibleSurface(content: SurfaceContent): SurfaceKind {
	return SURFACES.find((surface) => surfaceHasContent(surface, content)) ?? "Files";
}

/** Before the panel settles, an empty gated tab yields to the first with content; after, the tab asked for
 *  stays. A gone preview or Slate always yields. */
export function landedSurface(
	requested: SurfaceKind,
	content: SurfaceContent,
	ports: readonly PinnedPreviewPort[],
	settled: boolean,
): SurfaceKind {
	if (requested.startsWith("preview:")) {
		const fronted = content.slates?.find((slate) => `preview:workspace:${slate.port}` === requested);

		if (fronted !== undefined) return `${SLATE_PREFIX}${fronted.id}`;

		return openPortOf(requested, ports) === undefined ? firstVisibleSurface(content) : requested;
	}

	if (settled && !requested.startsWith(SLATE_PREFIX)) return requested;

	return surfaceHasContent(requested, content) ? requested : firstVisibleSurface(content);
}

export function openPortOf(surface: SurfaceKind, ports: readonly PinnedPreviewPort[]): PinnedPreviewPort | undefined {
	return ports.find((port) => surface === `preview:${port.executor}:${port.port}`);
}

export function pruneSlateReloads(
	previous: ReadonlyMap<string, number>,
	slates: readonly SlateSummary[],
): ReadonlyMap<string, number> {
	if (previous.size === 0) return previous;
	const ids = new Set<string>();

	for (const slate of slates) ids.add(slate.id);
	let next: Map<string, number> | undefined;

	for (const id of previous.keys()) {
		if (ids.has(id)) continue;
		next ??= new Map(previous);
		next.delete(id);
	}

	return next ?? previous;
}
