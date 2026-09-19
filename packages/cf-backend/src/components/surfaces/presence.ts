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

/** Whether a surface currently has content to show. Diffs answers off the
 *  mounted tree count the strip already holds — the only gate not carried
 *  by `TabPresence`. */
export function surfaceHasContent(
	surface: SurfaceKind,
	tabPresence: TabPresence | undefined,
	mctsTrees: ReadonlyMap<string, ForkNode>,
	slates: readonly SlateSummary[] | undefined,
	hasDiffs = false,
): boolean {
	if (surface === "Work") return tabPresence?.work ?? true;

	if (surface === "Releases") return tabPresence?.releases ?? true;

	if (surface === "Swarms") return (tabPresence?.explorations ?? true) || mctsTrees.size > 0;

	if (surface === "Diffs") return hasDiffs;

	if (surface.startsWith(SLATE_PREFIX)) {
		const id = surface.slice(SLATE_PREFIX.length);

		return slates?.some((slate) => slate.id === id) ?? false;
	}

	return true;
}

/** The first surface in strip order that still has content — where an
 *  emptied selection lands. */
export function firstVisibleSurface(
	tabPresence: TabPresence | undefined,
	mctsTrees: ReadonlyMap<string, ForkNode>,
	slates: readonly SlateSummary[] | undefined,
	hasDiffs = false,
): SurfaceKind {
	return SURFACES.find((surface) => surfaceHasContent(surface, tabPresence, mctsTrees, slates, hasDiffs)) ?? "Files";
}

/** An active gated tab that empties falls back to the first visible tab. */
export function resolveGatedSurface(
	surface: SurfaceKind,
	tabPresence: TabPresence | undefined,
	mctsTrees: ReadonlyMap<string, ForkNode>,
	slates: readonly SlateSummary[] | undefined,
	hasDiffs = false,
): SurfaceKind {
	return surfaceHasContent(surface, tabPresence, mctsTrees, slates, hasDiffs)
		? surface
		: firstVisibleSurface(tabPresence, mctsTrees, slates, hasDiffs);
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
