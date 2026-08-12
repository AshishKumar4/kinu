/**
 * The MCTS tree's read model — everything the tree view needs that is not
 * drawing. It lives beside the component rather than inside it so the
 * decisions that carry the meaning (which line won, how big a node is, what a
 * label says) are testable without a DOM, and so the two surfaces that render
 * this tree share one copy of them.
 */
import type { ForkNode } from "@/lib/protocol";

/**
 * One readable line out of an agent-authored string. Actions and observations
 * are model prose — headings, bullets, backticks, hard wraps — and a node
 * label is a single line of it.
 */
export function cleanNodeLabel(value: string | null | undefined, fallback: string): string {
	const raw = (value || fallback || "").split("\n").find((line) => line.trim().length > 0) ?? fallback;
	const cleaned = raw
		.replace(/^\s{0,3}#{1,6}\s*/, "")
		.replace(/^\s*[-*>]+\s*/, "")
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : fallback;
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Whether this fork scored its branches against each other. Only a competition
 * does; a merge sends every head's findings into one synthesis and ranks
 * nothing. Everything that reads as "which branch won" — the spine, the score
 * ramp, the size scale — is gated on this, because drawing those from a merge's
 * absent numbers invents a verdict the fork never reached.
 */
export function isCompeted(root: ForkNode): boolean {
	return root.value !== null || root.children.some((child) => child.value !== null);
}

/**
 * The line the search actually paid for: from the root, always the child with
 * the most rollouts, ties broken by mean value. This is MCTS's own answer to
 * "which branch is winning", and finding it is the first thing a reader of a
 * hundred-node tree needs to do.
 *
 * A fork that scored nothing has no such line — and picking one anyway (the
 * first child, since every comparison of nulls is false) would draw a brass
 * spine down an arbitrary head. Empty is the honest answer.
 */
export function principalVariation(root: ForkNode): Set<string> {
	if (!isCompeted(root)) return new Set<string>();
	const ids = new Set<string>([root.id]);
	let node = root;
	while (node.children.length > 0) {
		let best = node.children[0]!;
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

/**
 * The ids between the root and `id`, root first, the node itself excluded —
 * the branches that have to be open for it to be on screen.
 */
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

/** Node count and deepest depth — the two numbers both tree surfaces report. */
export function treeStats(root: ForkNode): { nodes: number; depth: number } {
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

/** The busiest node in the tree — the denominator of every size scale. Zero
 *  for an unscored fork, which flattens radius and edge width to their floor:
 *  no branch there was rolled out more than any other. */
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
 * Every abandoned branch that still carries a subtree. Folding these away is
 * what makes a search of several hundred nodes readable: they are the dense
 * low-value clusters, and the search already decided they do not matter.
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
	walk(root);
	return ids;
}

/* ── Visual scales ──────────────────────────────────────────────── */

/** Radii bracket: small enough that a hundred rows stay distinct, large
 *  enough that a heavily-rolled-out node is unmistakable. */
export const NODE_R_MIN = 3.5;
export const NODE_R_MAX = 11;
/** Every branch of an unscored fork is the same size, because none of them was
 *  paid for more than another. Mid-bracket rather than the floor: a handful of
 *  3.5px specks reads as a broken render, not as a merge. */
export const NODE_R_UNSCORED = 6.5;
const LINK_W_MIN = 0.7;
const LINK_W_MAX = 4.5;

/** Area, not radius, tracks visits — a diameter ramp reads a 4-visit node as
 *  four times the weight of a 1-visit one. */
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
