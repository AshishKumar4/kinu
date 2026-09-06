/**
 * Which surfaces have content, and where selection lands when the one the
 * reader is on empties. Pure decisions, kept apart from the switcher chrome
 * so the contract is testable without mounting the strip.
 */
import type { SlateSummary } from "@kinu.run/core";
import type { ForkNode, TabPresence } from "@/lib/protocol";
import type { SurfaceKind } from "./WorkSurface";

export const SLATE_PREFIX = "slate:";

/** Where selection lands when the surface it was on loses its content. */
const DEFAULT_SURFACE: SurfaceKind = "Work";

/** Whether a surface currently has content to show. */
export function surfaceHasContent(
	surface: SurfaceKind,
	tabPresence: TabPresence | undefined,
	mctsTrees: ReadonlyMap<string, ForkNode>,
	slates: readonly SlateSummary[] | undefined,
): boolean {
	if (surface === "Releases") return tabPresence?.releases ?? true;
	if (surface === "Exploration") return (tabPresence?.explorations ?? true) || mctsTrees.size > 0;
	if (surface.startsWith(SLATE_PREFIX)) {
		const id = surface.slice(SLATE_PREFIX.length);
		return slates?.some((slate) => slate.id === id) ?? false;
	}
	return true;
}

/** An active gated tab that empties falls back to Work. */
export function resolveGatedSurface(
	surface: SurfaceKind,
	tabPresence: TabPresence | undefined,
	mctsTrees: ReadonlyMap<string, ForkNode>,
	slates: readonly SlateSummary[] | undefined,
): SurfaceKind {
	return surfaceHasContent(surface, tabPresence, mctsTrees, slates) ? surface : DEFAULT_SURFACE;
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
