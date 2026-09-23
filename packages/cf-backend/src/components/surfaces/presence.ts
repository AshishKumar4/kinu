import type { PinnedPreviewPort, SlateSummary } from "@kinu.run/core";
import type { ForkNode, TabPresence } from "@kinu.run/core";
import type { SurfaceKind } from "./WorkSurface";

export const SLATE_PREFIX = "slate:";

export const SURFACES = ["Work", "Diffs", "Files", "Releases", "Swarms", "Agent", "Environment"] as const;

/** `hasDiffs` is absent where no change-set is mounted. */
export interface SurfaceContent {
	tabPresence: TabPresence | undefined;
	mctsTrees: ReadonlyMap<string, ForkNode>;
	slates: readonly SlateSummary[] | undefined;
	hasDiffs?: boolean;
}

/** Diffs answers off the strip's mounted tree count, the only gate not carried by `TabPresence`. */
export function surfaceHasContent(surface: SurfaceKind, content: SurfaceContent): boolean {
	if (surface === "Work") return content.tabPresence?.work ?? true;

	if (surface === "Releases") return content.tabPresence?.releases ?? true;

	if (surface === "Swarms") return (content.tabPresence?.explorations ?? true) || content.mctsTrees.size > 0;

	if (surface === "Diffs") return content.hasDiffs ?? false;

	if (surface.startsWith(SLATE_PREFIX)) {
		const id = surface.slice(SLATE_PREFIX.length);

		return content.slates?.some((slate) => slate.id === id) ?? false;
	}

	return true;
}

function firstVisibleSurface(content: SurfaceContent): SurfaceKind {
	return SURFACES.find((surface) => surfaceHasContent(surface, content)) ?? "Files";
}

function resolveGatedSurface(surface: SurfaceKind, content: SurfaceContent): SurfaceKind {
	return surfaceHasContent(surface, content) ? surface : firstVisibleSurface(content);
}

export function landedSurface(
	requested: SurfaceKind,
	content: SurfaceContent,
	ports: readonly PinnedPreviewPort[],
): SurfaceKind {
	if (!requested.startsWith("preview:")) return resolveGatedSurface(requested, content);
	const fronted = content.slates?.find((slate) => `preview:workspace:${slate.port}` === requested);

	if (fronted !== undefined) return `${SLATE_PREFIX}${fronted.id}`;

	return openPortOf(requested, ports) === undefined ? firstVisibleSurface(content) : requested;
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
