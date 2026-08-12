/**
 * The MCTS tree's read model — everything the tree view needs that is not
 * drawing. It lives beside the component rather than inside it so the
 * decisions that carry the meaning (which line won, how big a node is, what a
 * label says) are testable without a DOM, and so the two surfaces that render
 * this tree share one copy of them.
 */
import type { MCTSNode } from "@/lib/protocol";

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
 * The line the search actually paid for: from the root, always the child with
 * the most rollouts, ties broken by mean value. This is MCTS's own answer to
 * "which branch is winning", and finding it is the first thing a reader of a
 * hundred-node tree needs to do.
 */
export function principalVariation(root: MCTSNode): Set<string> {
	const ids = new Set<string>([root.id]);
	let node = root;
	while (node.children.length > 0) {
		let best = node.children[0]!;
		for (const child of node.children) {
			if (child.visits > best.visits || (child.visits === best.visits && child.value > best.value)) best = child;
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
export function ancestorIds(root: MCTSNode, id: string): string[] {
	const walk = (node: MCTSNode, trail: string[]): string[] | null => {
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
export function treeStats(root: MCTSNode): { nodes: number; depth: number } {
	let nodes = 0;
	let depth = 0;
	const walk = (node: MCTSNode): void => {
		nodes++;
		if (node.depth > depth) depth = node.depth;
		for (const child of node.children) walk(child);
	};
	walk(root);
	return { nodes, depth };
}

/** The busiest node in the tree — the denominator of every size scale. */
export function maxVisits(root: MCTSNode): number {
	let max = 0;
	const walk = (node: MCTSNode): void => {
		if (node.visits > max) max = node.visits;
		for (const child of node.children) walk(child);
	};
	walk(root);
	return max;
}

/** Descendants hidden behind a collapsed node. */
export function subtreeCount(node: MCTSNode): number {
	return node.children.reduce((sum, child) => sum + 1 + subtreeCount(child), 0);
}

/**
 * Every abandoned branch that still carries a subtree. Folding these away is
 * what makes a search of several hundred nodes readable: they are the dense
 * low-value clusters, and the search already decided they do not matter.
 */
export function losingBranchIds(root: MCTSNode): Set<string> {
	const ids = new Set<string>();
	const walk = (node: MCTSNode): void => {
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
const LINK_W_MIN = 0.7;
const LINK_W_MAX = 4.5;

/** Area, not radius, tracks visits — a diameter ramp reads a 4-visit node as
 *  four times the weight of a 1-visit one. */
function sqrtScale(value: number, max: number, lo: number, hi: number): number {
	if (max <= 0) return lo;
	return lo + (hi - lo) * Math.sqrt(Math.min(Math.max(value, 0), max) / max);
}

export function nodeRadius(visits: number, max: number): number {
	return sqrtScale(visits, max, NODE_R_MIN, NODE_R_MAX);
}

export function linkWidth(visits: number, max: number): number {
	return sqrtScale(visits, max, LINK_W_MIN, LINK_W_MAX);
}
