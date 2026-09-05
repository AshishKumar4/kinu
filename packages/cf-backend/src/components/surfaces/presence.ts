/**
 * Which surfaces have content, and where selection lands when the one the
 * reader is on empties. Pure decisions, kept apart from the switcher chrome
 * so the contract is testable without mounting the strip.
 */
import type { GadgetSummary } from "@kinu.run/core";
import type { ForkNode, TabPresence } from "@/lib/protocol";
import type { SurfaceKind } from "./WorkSurface";

export const GADGET_PREFIX = "gadget:";

/** Where selection lands when the surface it was on loses its content. */
const DEFAULT_SURFACE: SurfaceKind = "Work";

/**
 * Whether a surface currently has content to show.
 *
 * Releases and Exploration are GATED: hidden until their ledger has a row.
 * A gadget tab is gated on its summary: unpublished while open means gone,
 * so the caller always passes the workspace's list explicitly.
 * Everything else is unconditional, and an absent `tabPresence` (the gallery
 * frames that mount this surface against fixtures) keeps both tabs visible.
 * Unknown is not empty, and a fixture frame is not a claim about a ledger.
 * Exploration also reads the live tree map directly: a search in flight
 * appears the moment its first broadcast lands, without waiting for the next
 * presence refresh.
 */
export function surfaceHasContent(
	surface: SurfaceKind,
	tabPresence: TabPresence | undefined,
	mctsTrees: ReadonlyMap<string, ForkNode>,
	gadgets: readonly GadgetSummary[] | undefined,
): boolean {
	if (surface === "Releases") return tabPresence?.releases ?? true;
	if (surface === "Exploration") return (tabPresence?.explorations ?? true) || mctsTrees.size > 0;
	if (surface.startsWith(GADGET_PREFIX)) {
		const slug = surface.slice(GADGET_PREFIX.length);
		return gadgets?.some((gadget) => gadget.slug === slug) ?? false;
	}
	return true;
}

/**
 * The surface to actually be on. An ACTIVE tab whose content just became
 * empty must not strand the reader on a tab that no longer exists: selection
 * falls back to {@link DEFAULT_SURFACE}. The two gated surfaces and an open
 * gadget tab can vanish under the reader; everything else always has content.
 */
export function resolveGatedSurface(
	surface: SurfaceKind,
	tabPresence: TabPresence | undefined,
	mctsTrees: ReadonlyMap<string, ForkNode>,
	gadgets: readonly GadgetSummary[] | undefined,
): SurfaceKind {
	return surfaceHasContent(surface, tabPresence, mctsTrees, gadgets) ? surface : DEFAULT_SURFACE;
}

export function pruneGadgetReloads(
	previous: ReadonlyMap<string, number>,
	gadgets: readonly GadgetSummary[],
): ReadonlyMap<string, number> {
	if (previous.size === 0) return previous;
	const slugs = new Set<string>();
	for (const gadget of gadgets) slugs.add(gadget.slug);
	let next: Map<string, number> | undefined;
	for (const slug of previous.keys()) {
		if (slugs.has(slug)) continue;
		next ??= new Map(previous);
		next.delete(slug);
	}
	return next ?? previous;
}
