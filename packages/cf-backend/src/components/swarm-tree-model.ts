/**
 * The MCTS tree's read model — everything the tree view needs that is not
 * drawing. It lives beside the component rather than inside it so the
 * decisions that carry the meaning (which line won, how big a node is, what a
 * label says) are testable without a DOM, and so the two surfaces that render
 * this tree share one copy of them.
 */
import type { ForkNode } from "@/lib/protocol";

/**
 * Which node, in which search, the reader is inspecting.
 *
 * Ids rather than the node itself, for the reason given on {@link findForkNode}:
 * a poll that grows a tree replaces every node object in it, so a held node goes
 * stale while an id never does. The run is part of the selection because the
 * canvas draws every search at once, and a node id only identifies a node
 * WITHIN its own search.
 */
export interface ExplorerSelection {
	/** The search root's id — the key the tree maps are keyed by. */
	runId: string;
	nodeId: string;
}

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

/**
 * `text`, clipped with an ellipsis to the pixels it is allowed, as `advance`
 * measures it.
 *
 * A WIDTH, never a character count. The clip was a flat 20 characters, and the
 * room a label has is neither flat nor countable in characters: it is the pitch
 * to the next column for a node that has one, the rest of the scene for a leaf
 * that does not, and the face is proportional either way. So `Reconcile the
 * cache…` was cut with 170px of empty canvas beside it — 127 of the 178 labels
 * on the 106-node search were clipped, and most of them fitted.
 *
 * `advance` is handed in rather than measured here so this stays pure: the
 * caller owns the one canvas context that knows what the cascade resolved the
 * label face to.
 */
export function clipToWidth(text: string, room: number, advance: (text: string) => number): string {
	if (room <= 0) return "";
	if (advance(text) <= room) return text;
	// The ellipsis is part of what has to fit, so the search is over the kept
	// prefix. Bisection rather than a ratio: one measurement is not a scale
	// factor for a proportional face, and a ratio overshoots on wide glyphs.
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

/** Resolve an id against the latest immutable tree snapshot. Selection state
 * stores ids, never node objects, so live polling cannot leave details stale. */
export function findForkNode(root: ForkNode, id: string): ForkNode | null {
	if (root.id === id) return root;
	for (const child of root.children) {
		const found = findForkNode(child, id);
		if (found) return found;
	}
	return null;
}

/** The branch the settled search actually chose. A running tree has none, so
 * callers must not turn a provisional score into a winner label. */
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

/** Node count and deepest depth — the two numbers both tree surfaces report. */
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
 * Every abandoned BRANCH that still carries a subtree. Folding these away is
 * what makes a search of several hundred nodes readable: they are the dense
 * low-value clusters, and the search already decided they do not matter.
 *
 * The root is excluded on purpose, and not as a special case: the root is the
 * split itself, never a branch of itself, so "this branch was abandoned" is not
 * a statement that can be made about it. It reads as one only because settling
 * a search retires every node still open — `convergence.ts` prunes all but the
 * winner, `abandonSearchTree` fails them all — and the root is always one of
 * them. Walking from the root therefore matched the root first and returned a
 * set of exactly one id: the whole search, hidden behind a single dot.
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

/**
 * Below this zoom a label is under ~8px on screen — noise, not text.
 *
 * Lives beside {@link viewNoteFor} because both are the same decision — when
 * has the view stopped carrying labels? — read at two layers: the renderer
 * hides them here, and the canvas says so out loud there.
 */
export const LABEL_MIN_SCALE = 0.72;

/**
 * What a cropped or de-labelled view owes the reader: one line that says so,
 * instead of a silent crop (#206).
 *
 * Two facts are lost without a word today. Under {@link LABEL_MIN_SCALE} every
 * label is hidden by the level-of-detail switch, so the reader sees dots with
 * no names and no reason why. And a tree wider than the view continues past
 * the right edge — depth is pannable by design (fitting the bounding box was
 * measured and rejected; see the fit comment in the component) — but a column
 * scrolled off is indistinguishable from a column that does not exist. Legible
 * AND fitting says nothing: an honest canvas is quiet when nothing is lost.
 */
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
