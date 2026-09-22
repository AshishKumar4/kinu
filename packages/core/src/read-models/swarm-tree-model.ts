/** MCTS tree read model: the non-drawing decisions shared by both tree surfaces. */
import { type ForkNode } from '../protocol';

/** One score ladder for bar grades and swarm-node fills. */
export function scoreBand(value: number): 'success' | 'warning' | 'danger' {
  if (value >= 0.7) return 'success';

  if (value >= 0.4) return 'warning';

  return 'danger';
}

/** Selection by id: polling replaces node objects, and a node id is unique only within its run. */
export interface ExplorerSelection {
	runId: string;
	nodeId: string;
}

/** One readable line from agent-authored markdown prose. */
export function cleanNodeLabel(value: string | null | undefined, fallback: string): string {
	const text = value === null || value === undefined || value === "" ? fallback : value;
	const raw = text.split("\n").find((line) => line.trim().length > 0) ?? fallback;

	const cleaned = raw
		.replace(/^\s{0,3}#{1,6}\s*/, "")
		.replace(/^\s*[-*>]+\s*/, "")
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();

	return cleaned.length > 0 ? cleaned : fallback;
}

/** `text` clipped with an ellipsis to `room` pixels as measured by `advance`. */
export function clipToWidth(text: string, room: number, advance: (text: string) => number): string {
	if (room <= 0) return "";

	if (advance(text) <= room) return text;
	// Bisection, not a ratio: glyph widths are proportional, and the ellipsis must fit too.
	let keep = 0;
	let high = text.length;

	while (keep < high) {
		const mid = (keep + high + 1) >> 1;

		if (advance(`${text.slice(0, mid)}…`) <= room) keep = mid;
		else high = mid - 1;
	}

	return keep === 0 ? "" : `${text.slice(0, keep)}…`;
}

/**
 * Whether the fork scored branches against each other. A merge ranks nothing, so winner visuals
 * (spine, score ramp, size scale) are gated on this.
 */
export function isCompeted(root: ForkNode): boolean {
	return root.value !== null || root.children.some((child) => child.value !== null);
}

/** MCTS principal variation: most-visited child, ties by value. Empty for an unscored fork. */
export function principalVariation(root: ForkNode): Set<string> {
	if (!isCompeted(root)) return new Set<string>();
	const ids = new Set<string>([root.id]);
	let node = root;

	while (node.children.length > 0) {
		let best = node.children[0];

		if (best === undefined) break;

		for (const child of node.children) {
			const cv = child.visits ?? 0, bv = best.visits ?? 0;

			if (cv > bv || (cv === bv && (child.value ?? 0) > (best.value ?? 0))) best = child;
		}

		if (ids.has(best.id)) break; // a malformed tree must not spin here
		ids.add(best.id);
		node = best;
	}

	return ids;
}

/** Ids from root to `id`, root first, `id` excluded. */
export function ancestorIds(root: ForkNode, id: string): string[] {
	const walk = (node: ForkNode, trail: string[]): string[] | null => {
		if (node.id === id) return trail;
		const next = [...trail, node.id];

		for (const child of node.children) {
			const found = walk(child, next);

			if (found) return found;
		}

		return null;
	};

	return walk(root, []) ?? [];
}

/** Selection state stores ids, never node objects, so live polling cannot leave details stale. */
export function findForkNode(root: ForkNode, id: string): ForkNode | null {
	if (root.id === id) return root;

	for (const child of root.children) {
		const found = findForkNode(child, id);

		if (found) return found;
	}

	return null;
}

/** The settled search's chosen branch; null while running, so a provisional score is never a winner. */
export function terminalForkNode(root: ForkNode): ForkNode | null {
	let chosen: ForkNode | null = null;

	const walk = (node: ForkNode): void => {
		if (
			node.status === "terminal"
			&& (chosen === null || (node.value ?? Number.NEGATIVE_INFINITY) > (chosen.value ?? Number.NEGATIVE_INFINITY))
		) {
			chosen = node;
		}

		for (const child of node.children) walk(child);
	};

	walk(root);

	return chosen;
}

export function treeStats(root: ForkNode) {
	let nodes = 0;
	let depth = 0;

	const walk = (node: ForkNode): void => {
		nodes++;

		if (node.depth > depth) depth = node.depth;

		for (const child of node.children) walk(child);
	};

	walk(root);

	return { nodes, depth };
}

/** Denominator of every size scale; zero for an unscored fork, flattening sizes to the floor. */
export function maxVisits(root: ForkNode): number {
	let max = 0;

	const walk = (node: ForkNode): void => {
		if ((node.visits ?? 0) > max) max = node.visits ?? 0;

		for (const child of node.children) walk(child);
	};

	walk(root);

	return max;
}

/** Descendants hidden behind a collapsed node. */
export function subtreeCount(node: ForkNode): number {
	return node.children.reduce((sum, child) => sum + 1 + subtreeCount(child), 0);
}

/**
 * Every abandoned branch that still carries a subtree. The root is excluded: settling retires
 * every open node including the root, which would otherwise hide the whole search.
 */
export function losingBranchIds(root: ForkNode): Set<string> {
	const ids = new Set<string>();

	const walk = (node: ForkNode): void => {
		if (node.children.length > 0 && (node.status === "pruned" || node.status === "failed")) {
			ids.add(node.id);

			return; // the topmost abandoned node hides the rest of its cluster
		}

		for (const child of node.children) walk(child);
	};

	for (const child of root.children) walk(child);

	return ids;
}

const NODE_R_MIN = 3.5;

export const NODE_R_MAX = 11;

export const NODE_R_UNSCORED = 6.5;

const LINK_W_MIN = 0.7;

const LINK_W_MAX = 4.5;

/** Area, not radius, tracks visits. */
function sqrtScale(value: number, max: number, lo: number, hi: number): number {
	if (max <= 0) return lo;

	return lo + (hi - lo) * Math.sqrt(Math.min(Math.max(value, 0), max) / max);
}

export function nodeRadius(visits: number | null, max: number): number {
	return sqrtScale(visits ?? 0, max, NODE_R_MIN, NODE_R_MAX);
}

export function linkWidth(visits: number | null, max: number): number {
	return sqrtScale(visits ?? 0, max, LINK_W_MIN, LINK_W_MAX);
}

/** Below this zoom a label is under ~8px on screen. */
export const LABEL_MIN_SCALE = 0.72;

/** One-line note when labels are hidden or the tree extends past the view, instead of a silent crop. */
export function viewNoteFor(
	band: { x0: number; x1: number },
	k: number,
	availW: number,
): string | null {
	const illegible = k < LABEL_MIN_SCALE;
	const tooWide = (band.x1 - band.x0) * k > availW;

	if (illegible && tooWide) return "too small to label · deeper columns pan right";

	if (illegible) return "too small to label · zoom in to read";

	if (tooWide) return "deeper columns continue right · drag to pan";

	return null;
}
