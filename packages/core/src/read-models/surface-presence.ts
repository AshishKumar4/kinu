import type { PinnedPreviewPort } from "../preview/preview-ports";
import type { ForkNode, TabPresence } from "../protocol";
import type { SlateSummary } from "../slates/rpc";
import { ephemeralSlateAddress } from "../slates/ui-blocks";

export const SLATE_PREFIX = "slate:";

export const SURFACES = ["Work", "Changes", "Files", "Swarms", "Agent", "Environment"] as const;

export const ACTIVITY_SURFACE = "Activity";

export type SlateSurfaceKind = `${typeof SLATE_PREFIX}${string}`;

/** A plan revision's own page: its owner's conversation, the plan's id and the revision. */
export type PlanSurfaceKind = `plan:${string}`;

export type SurfaceKind = (typeof SURFACES)[number] | typeof ACTIVITY_SURFACE | SlateSurfaceKind | PlanSurfaceKind | `preview:${string}`;

export interface PlanPageRef {
	readonly owner: string;
	readonly id: string;
	readonly revision: number;
}

export function planSurface({ owner, id, revision }: PlanPageRef): PlanSurfaceKind {
	return `plan:${encodeURIComponent(owner)}:${encodeURIComponent(id)}:${String(revision)}`;
}

/** The plan revision a surface shows; null for any other surface. */
export function planOfSurface(surface: SurfaceKind | null): PlanPageRef | null {
	const match = surface === null ? null : /^plan:([^:]+):([^:]+):(\d+)$/.exec(surface);

	if (match === null) return null;

	return { owner: decodeURIComponent(match[1] ?? ""), id: decodeURIComponent(match[2] ?? ""), revision: Number(match[3]) };
}

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

		// An answer's block is no file, so no listing holds it: the answer that names it is its content.
		return ephemeralSlateAddress(id) !== null || (content.slates?.some((slate) => slate.id === id) ?? false);
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
