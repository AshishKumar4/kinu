/**
 * Which surfaces have content, and where selection lands when the one the
 * reader is on empties. Pure decisions, kept apart from the switcher chrome
 * so the contract is testable without mounting the strip.
 */
import type { SlateSummary } from "@kinu.run/core";
import type { ForkNode, TabPresence } from "@kinu.run/core";
import type { SurfaceKind } from "./WorkSurface";

export const SLATE_PREFIX = "slate:";

/** The strip's own order — the sequence a falling-back selection walks. */
export const SURFACES = ["Work", "Diffs", "Files", "Releases", "Swarms", "Agent", "Environment"] as const;

/** Everything the gates below read: the server's per-tab flags, the trees the
 *  strip has mounted, the listed Slates, and whether the change-set has content.
 *  `hasDiffs` is absent where no change-set is mounted. */
export interface SurfaceContent {
	tabPresence: TabPresence | undefined;
	mctsTrees: ReadonlyMap<string, ForkNode>;
	slates: readonly SlateSummary[] | undefined;
	hasDiffs?: boolean;
}

/** Whether a surface currently has content to show. Diffs answers off the
 *  mounted tree count the strip already holds — the only gate not carried
 *  by `TabPresence`. */
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

/** The first surface in strip order that still has content — where an
 *  emptied selection lands. */
export function firstVisibleSurface(content: SurfaceContent): SurfaceKind {
	return SURFACES.find((surface) => surfaceHasContent(surface, content)) ?? "Files";
}

/** An active gated tab that empties falls back to the first visible tab. */
export function resolveGatedSurface(surface: SurfaceKind, content: SurfaceContent): SurfaceKind {
	return surfaceHasContent(surface, content) ? surface : firstVisibleSurface(content);
}

/** Keeps only reload counters that still name a listed Slate. */
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
