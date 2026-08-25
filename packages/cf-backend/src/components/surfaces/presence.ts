/**
 * Which surfaces have content, and where selection lands when the one the
 * reader is on empties. Pure decisions, kept apart from the switcher chrome
 * so the contract is testable without mounting the strip.
 */
import type { ForkNode, TabPresence } from "@/lib/protocol";
import type { SurfaceKind } from "./WorkSurface";

/** Where selection lands when the surface it was on loses its content. */
const DEFAULT_SURFACE: SurfaceKind = "Work";

/**
 * Whether a surface currently has content to show.
 *
 * Releases and Exploration are GATED: hidden until their ledger has a row.
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
): boolean {
	if (surface === "Releases") return tabPresence?.releases ?? true;
	if (surface === "Exploration") return (tabPresence?.explorations ?? true) || mctsTrees.size > 0;
	return true;
}

/**
 * The surface to actually be on. An ACTIVE tab whose content just became
 * empty must not strand the reader on a tab that no longer exists: selection
 * falls back to {@link DEFAULT_SURFACE}. Only the two gated surfaces can
 * vanish under the reader; everything else always has content.
 */
export function resolveGatedSurface(
	surface: SurfaceKind,
	tabPresence: TabPresence | undefined,
	mctsTrees: ReadonlyMap<string, ForkNode>,
): SurfaceKind {
	return surfaceHasContent(surface, tabPresence, mctsTrees) ? surface : DEFAULT_SURFACE;
}
