/**
 * The swarm trees — every search the workspace has run, drawn as the trees they
 * are, on ONE canvas.
 *
 * `agents(action:'swarm')` is the only verb that grows one. A search whose axes
 * resolve to `advance:'none'` is this tree at depth 1 — the task at the root, one
 * candidate per child — and a search that selects down a tree is the same tree
 * deeper, with its branches scored against each other. One renderer, one node
 * shape, depth varying, because the alternative was two panes where the same user
 * action landed in one or the other depending on an internal strategy id.
 *
 * The file was `fork-tree`, named for a verb the delegation surface no longer has.
 *
 * ONE canvas, not one per search. Each search used to get its own fixed-height
 * SVG in its own card, so the room a tree could use was decided before anyone
 * knew how big the tree was: a three-node merge kept 300px it could not fill
 * while a hundred-node search was squeezed into the same 300px. Here every
 * search is a BAND of a single scene, sized to the tree it holds, under one
 * shared pan and zoom. A band's soft boundary says where one search ends and the
 * next begins; the selected one is lit and the rest recede without going away,
 * which is the comparison the surface exists for.
 *
 * Laid out left→right at a CONSTANT pitch — d3's `nodeSize`, not `size`. Left to
 * right because the two axes of a search are not alike: depth is small and
 * bounded (a 106-node search is 7 columns) while breadth is not (that same
 * search is ~100 rows). Putting the bounded axis across the wide viewport and
 * the unbounded one down the scrollable axis is what keeps the pitch constant,
 * and it is the only orientation in which a horizontal label gets a column to
 * itself instead of colliding with its siblings'.
 *
 * The old layout stretched the whole search to fit the panel, so a node's row
 * got thinner every time the search grew or the column got narrower; at 106
 * nodes that is a band of overlapping dots under a smear of `n=4` badges. Here
 * the canvas is as large as the searches are and the viewport moves over it: it
 * opens FULLY EXPANDED and fitted to the selected search, pans and zooms, folds
 * branches away on request, and drops labels below the zoom at which they would
 * collide.
 *
 * What the picture says before anything is clicked, when the search SCORED its
 * candidates:
 *   fill                 score, on the product's danger→warning→success ramp
 *   radius               rollouts spent here (area ∝ visits)
 *   brass spine          the principal variation — the line the search paid for
 *   edge width           rollouts that flowed down that edge
 *   faded, dashed edge   the branch was pruned
 *   brass ring + halo    terminal: the answer the search settled on
 *
 * and always, whichever way it settled:
 *   hollow, danger ring  the branch failed
 *   amber fill           the branch is still running
 *   square, accent edge  an `expand:'aggregate'` FAN-IN VERTEX — a node that
 *                        consumed a whole level rather than sampling beside its
 *                        siblings. NOT a separate node kind: it is graded through
 *                        the same scoring body, carries the same fill and radius,
 *                        and is marked only because `search_nodes` records its
 *                        SELECTION parent and nothing else, so a reader with the
 *                        tree alone cannot tell which node fanned a level in.
 *
 * Every score/rollout encoding is gated on the branches actually carrying those
 * numbers. A search that ranks nothing has no such values, and a ramp fill or a
 * winning spine drawn from their absence would state a verdict it never reached.
 */
import { useRef, useEffect, useState, useCallback } from "react";
import * as d3 from "d3";
import {
	ArrowsOutIcon, MagnifyingGlassPlusIcon, MagnifyingGlassMinusIcon,
	ArrowsInSimpleIcon, ArrowsOutSimpleIcon,
} from "@phosphor-icons/react";
import { useTheme } from "@/hooks/use-theme";
import { useElementSize } from "@/hooks/use-element-size";
import type { ForkNode } from "@/lib/protocol";
import {
	ancestorIds, cleanNodeLabel, clipToWidth, isCompeted, LABEL_MIN_SCALE, linkWidth, losingBranchIds, maxVisits,
	NODE_R_MAX, NODE_R_UNSCORED, nodeRadius, principalVariation, subtreeCount, viewNoteFor,
	type ExplorerSelection,
} from "./swarm-tree-model";

/** One search's band on the canvas. */
export interface SwarmTreeRegion {
	/** The search root's id — what a selection names, and what the tree maps key on. */
	runId: string;
	root: ForkNode;
	/** What the search was asked to do, written above its tree inside the boundary. */
	title: string;
	/** What the search is CALLED — the run's own name, which `ForkRunSummary.name`
	 *  always carries (given, or derived from the task). The root node wears it,
	 *  because a root is the workspace as found and has no action of its own to
	 *  label it with. REQUIRED: while it was optional the fallback printed the
	 *  literal `(root)` where the run's name belongs, and both call sites always
	 *  had a name to give. */
	name: string;
	/** The shape it resolved to and what it was dispatched with. */
	note: string;
	/**
	 * Nodes that fanned a level in, by node id → the number of parents each
	 * consumed. Absent for a search that only ever sampled, and for one whose
	 * per-node journal the store no longer holds.
	 *
	 * NOT a node kind: a fan-in vertex is graded through the same scoring body as
	 * a sampled sibling, so it keeps that sibling's fill and radius and gains only
	 * a silhouette. It needs one because `search_nodes` records its SELECTION
	 * parent and nothing else — the other k−1 edges are not in the tree being
	 * drawn, so nothing in the picture could otherwise say which node consumed a
	 * whole level.
	 */
	fanIn?: ReadonlyMap<string, number>;
	/** Each node's own reason for existing, by node id — the journal's rationale,
	 *  verbatim. Shown on the node's tooltip, where a truncated label cannot. */
	why?: ReadonlyMap<string, string>;
}

interface Props {
	/**
	 * Every search to draw, in the order they should stack. MUST be referentially
	 * stable across renders that changed nothing — the render effect keys on it,
	 * and a fresh array each poll would rebuild the scene several times a second.
	 */
	regions: readonly SwarmTreeRegion[];
	width?: number;
	height?: number;
	/** Which band is lit, and what the view fits itself to. */
	selectedRunId: string | null;
	/** Which node is emphasised, if the reader has opened one. */
	selection: ExplorerSelection | null;
	onSelectRun?: (runId: string) => void;
	onSelectNode?: (selection: ExplorerSelection) => void;
	/**
	 * Per-node journal write counters, from the `head_activity` broadcast.
	 *
	 * A SIGNAL, never a row: what the number means is "this node's ledger moved",
	 * and the only thing the picture does with it is mark the nodes that are
	 * working right now. Kept OUT of `regions` on purpose — a region identity
	 * that changed per step would rebuild the whole scene several times a second,
	 * and at 520 nodes that is the one thing this renderer cannot afford. It is
	 * applied as an attribute update, like selection and hover.
	 */
	activity?: ReadonlyMap<string, number>;
}

/** Row pitch. One text line plus air — labels cannot collide at any tree size. */
const ROW = 22;
/** Depth pitch. Wide enough for a node, its fold handle and a label. */
const COL = 206;
const HANDLE_X = NODE_R_MAX + 8;
const LABEL_X = NODE_R_MAX + 22;
/** Air between a label's end and whatever the next column puts on its row. */
const LABEL_GAP = 8;
/**
 * Room a label may use, in scene units.
 *
 * `INNER` is the pitch: a node with children drawn to its right shares its row
 * with them, so its label stops before their column. `LEAF` is a reading bound
 * and not a collision one — d3 gives every leaf a row of its own, so nothing
 * is ever drawn to the right of one and the only argument for stopping is that
 * past two columns a label is prose, which is what the tooltip is for.
 *
 * Both replace a flat 20-character clip. That clip cut 127 of the 178 labels on
 * the 106-node search, most of them with room to spare beside them, because a
 * character count cannot know either number.
 */
const LABEL_ROOM_INNER = COL - LABEL_X - LABEL_GAP;
const LABEL_ROOM_LEAF = COL * 2 - LABEL_X - LABEL_GAP;
/**
 * The zoom at which the picture stops being one: the busiest search's dots
 * merge into a smear well before this, so fitting is allowed to go no smaller.
 * A search too tall to fit above it opens at this scale with its root in view
 * and is read by panning, which is strictly more legible than fitting all of it
 * into dust.
 */
const OVERVIEW_MIN_SCALE = 0.3;
const RULER_H = 20;
const FIT_PAD = 16;
/**
 * The docked row under the scene holding the key and the controls.
 *
 * Docked, not floated. Both used to be absolutely positioned over the canvas,
 * which was survivable while a fitted tree left the bottom of the canvas empty
 * and became a chip sitting on top of the branches once a fit filled the
 * height. The row is in flow now; this figure is what the host reserves for it
 * when it asks how tall the whole thing wants to be, and the row is measured
 * rather than assumed once it is on screen.
 */
const LEGEND_H = 30;
/** Air inside a band's boundary, and the line of type naming the search. */
const BAND_PAD = 10;
const BAND_TITLE_H = 26;
/**
 * How long a node keeps its working mark after its last journal write.
 *
 * A node that stops working announces nothing further, so the mark has to time
 * out rather than be turned off. Long enough that a node thinking between two
 * tool calls does not flicker, short enough that a settled search stops moving
 * while the reader is still looking at it.
 */
const WORKING_MS = 2_500;
/** Between two boundaries. A hairline of separation, not a gutter — the whole
 *  point of one canvas is that the space between trees is not wasted. */
const BAND_GAP = 6;

type PointNode = d3.HierarchyPointNode<ForkNode>;

/** A fold is per NODE PER SEARCH: node ids are unique inside a search only. */
function foldKey(runId: string, nodeId: string): string {
	return `${runId}\u0000${nodeId}`;
}

/** One allocation for every search that has no journal, so a poll over a
 *  workspace of them does not churn a Map per band per render. */
const EMPTY_NODE_MAP: ReadonlyMap<string, number> = new Map();
const EMPTY_TEXT_MAP: ReadonlyMap<string, string> = new Map();
/** The unfolded scene, for the pure height question the host asks before the
 *  reader has folded anything. */
const NO_FOLDS: ReadonlySet<string> = new Set<string>();

/**
 * What the two label faces actually measure, as the cascade resolved them.
 *
 * A label's room is a width, so its clip has to be one, and the only honest
 * source for "how wide is this string" is the face the browser will set it in.
 * Measured off a canvas context rather than by laying text out in the SVG:
 * `getComputedTextLength` costs a layout per call and there are 520 nodes on
 * the frame this view has to survive.
 */
interface LabelFont {
	/** The 11px UI face the node's name is set in. */
	name(text: string): number;
	/** The 9px mono face the score and the `+n`/`⋈k` badges are set in. */
	badge(text: string): number;
}

/** One context and one pair of font strings for the document's lifetime. The
 *  faces are declared on `:root` and never change under a palette switch, so a
 *  measurer per render would re-read the cascade for the same answer. */
let fontCache: LabelFont | null = null;

function labelFont(): LabelFont {
	if (fontCache !== null) return fontCache;
	const cs = getComputedStyle(document.documentElement);
	const mono = cs.getPropertyValue("--font-mono").trim() || "monospace";
	const body = getComputedStyle(document.body).fontFamily || "sans-serif";
	const ctx = document.createElement("canvas").getContext("2d");
	if (ctx === null) {
		// No 2d context — a headless or hardened environment. Fall back to the
		// mean advance of the faces at these sizes, so labels are clipped a
		// little conservatively rather than not at all.
		fontCache = { name: (text) => text.length * 5.9, badge: (text) => text.length * 5.4 };
		return fontCache;
	}
	const measure = (font: string) => (text: string): number => {
		ctx.font = font;
		return ctx.measureText(text).width;
	};
	fontCache = { name: measure(`11px ${body}`), badge: measure(`9px ${mono}`) };
	return fontCache;
}

/** Every tspan of one node's label, already clipped to the room that node has.
 *  Decided during layout because the scene's right edge is where the widest of
 *  them ends — the extent and the clip are one fact and used to be two. */
interface NodeLabel {
	/** `47%` or `fail`, or empty for a branch no fork ranked. */
	readonly score: string;
	/** The node's own line, clipped. */
	readonly name: string;
	/** `+12` for a fold, `⋈3` for a fan-in vertex, or both. */
	readonly badge: string;
	/** Where the label ends, in the tree's own x. */
	readonly end: number;
}

/**
 * One node's label, clipped to the room its column leaves it.
 *
 * The score and the badges are set at their own size and are never clipped:
 * they are the two facts a column of labels is scanned on, and a truncated
 * percentage is worse than a truncated sentence. What gives is the name.
 */
function nodeLabel(
	node: PointNode, region: SwarmTreeRegion, collapsed: ReadonlySet<string>,
	fanIn: ReadonlyMap<string, number>, font: LabelFont,
): NodeLabel {
	const folded = collapsed.has(foldKey(region.runId, node.data.id));
	const scored = node.data.status === "failed" || node.data.value !== null;
	const score = !scored ? ""
		: node.data.status === "failed" ? "fail"
		: `${Math.round(Math.min(1, Math.max(0, node.data.value ?? 0)) * 100)}%`;
	const fold = folded ? ` +${subtreeCount(node.data)}` : "";
	const join = fanIn.has(node.data.id) ? ` ⋈${fanIn.get(node.data.id) ?? 0}` : "";
	const badge = `${fold}${join}`;
	// A folded node draws no children, so its row is clear to the right and it
	// gets a leaf's room — which is also where the `+n` it just gained needs it.
	const room = node.data.children.length === 0 || folded ? LABEL_ROOM_LEAF : LABEL_ROOM_INNER;
	const spend = font.badge(score) + font.badge(badge);
	const name = clipToWidth(
		`${score === "" ? "" : " "}${cleanNodeLabel(node.data.action, region.name)}`,
		room - spend, font.name,
	);
	return { score, name, badge, end: LABEL_X + spend + font.name(name) };
}

/** One search, laid out and placed in the scene. */
interface RegionLayout {
	runId: string;
	root: ForkNode;
	nodes: PointNode[];
	links: d3.HierarchyPointLink<ForkNode>[];
	byId: Map<string, PointNode>;
	pv: Set<string>;
	/** Whether this fork ranked its branches — gates every score/rollout
	 *  encoding, so a merge is never drawn as if it had picked a winner. */
	competed: boolean;
	visitMax: number;
	depth: number;
	/** {@link SwarmTreeRegion.fanIn}, defaulted so the render never branches on
	 *  whether a search had a journal. */
	fanIn: ReadonlyMap<string, number>;
	why: ReadonlyMap<string, string>;
	/** {@link SwarmTreeRegion.name} — what the root node and its tooltip say
	 *  where a node would say what it did. */
	name: string;
	/** Each node's label, already clipped to the room its column leaves it. */
	labels: Map<string, NodeLabel>;
	/** Rows of this tree, in the tree's own coordinates. */
	rows: { start: number; end: number };
	/** Scene y the tree's rows are translated by. */
	shiftY: number;
	/** The soft boundary, in scene coordinates. */
	band: { x0: number; x1: number; y0: number; y1: number };
}

interface RenderState {
	regions: RegionLayout[];
	/** Deepest column anywhere on the canvas — what the ruler labels. */
	depth: number;
	extent: { x0: number; x1: number; y0: number; y1: number };
}

/**
 * Lay every search out and stack the bands. Pure: the whole scene geometry
 * decided in one place, so fitting, drawing and hit-testing cannot disagree
 * about where a tree is.
 */
function layoutRegions(
	regions: readonly SwarmTreeRegion[],
	collapsed: ReadonlySet<string>,
	font: LabelFont,
): RenderState {
	const layout = d3.tree<ForkNode>().nodeSize([ROW, COL])
		.separation((a, b) => (a.parent === b.parent ? 1 : 1.6));
	const placed: RegionLayout[] = [];
	let maxDepth = 0;
	// Boundaries are flush columns rather than ragged to each tree's own width:
	// a band is a region of one canvas, and a ragged right edge reads as a stack
	// of cards, which is the thing this replaced.
	//
	// The right edge is where the widest LABEL ends, not `depth * COL` plus a
	// constant guess at how much text a column holds. That guess was 205px, and
	// it was both too much for a tree of short labels — dead canvas the fit then
	// spent scale on — and too little for the leaf labels that are now allowed
	// two columns.
	let widest = 0;
	for (const region of regions) {
		const hierarchy = d3.hierarchy(region.root, (d) => (
			collapsed.has(foldKey(region.runId, d.id)) ? [] : d.children
		));
		const data = layout(hierarchy);
		const nodes = data.descendants();
		const depth = d3.max(nodes, (d) => d.depth) ?? 0;
		const [rowStart, rowEnd] = d3.extent(nodes, (d) => d.x);
		if (rowStart === undefined || rowEnd === undefined) continue;
		maxDepth = Math.max(maxDepth, depth);
		const fanIn = region.fanIn ?? EMPTY_NODE_MAP;
		const labels = new Map<string, NodeLabel>();
		for (const node of nodes) {
			const label = nodeLabel(node, region, collapsed, fanIn, font);
			labels.set(node.data.id, label);
			widest = Math.max(widest, node.y + label.end);
		}
		placed.push({
			runId: region.runId, root: region.root, nodes, links: data.links(),
			name: region.name,
			byId: new Map(nodes.map((d) => [d.data.id, d])),
			pv: principalVariation(region.root),
			competed: isCompeted(region.root),
			visitMax: maxVisits(region.root),
			fanIn,
			why: region.why ?? EMPTY_TEXT_MAP,
			labels,
			depth,
			rows: { start: rowStart, end: rowEnd },
			shiftY: 0,
			band: { x0: 0, x1: 0, y0: 0, y1: 0 },
		});
	}

	const x0 = -NODE_R_MAX - BAND_PAD;
	const x1 = Math.max(widest + BAND_PAD, COL);
	let cursor = 0;
	for (const region of placed) {
		const treeH = region.rows.end - region.rows.start + ROW;
		const bandH = BAND_TITLE_H + treeH + BAND_PAD;
		region.shiftY = cursor + BAND_TITLE_H + ROW / 2 - region.rows.start;
		region.band = { x0, x1, y0: cursor, y1: cursor + bandH };
		cursor += bandH + BAND_GAP;
	}

	return {
		regions: placed,
		depth: maxDepth,
		extent: { x0, x1, y0: 0, y1: Math.max(cursor - BAND_GAP, ROW) },
	};
}

/**
 * How tall this scene wants to be: every band at 1:1, the depth ruler, the air
 * around it and the docked legend row.
 *
 * The host caps the canvas at this. Without a cap a workspace of short searches
 * sat under several hundred pixels of reserved nothing with the key stranded at
 * the bottom of it, which is the defect that one fixed-height card per run was
 * replaced to fix — reintroduced by handing the canvas a whole column whatever
 * it held. Fully expanded, because that is the state a search opens in, so
 * folding a branch shrinks the scene inside a budget rather than moving it.
 */
export function naturalCanvasHeight(regions: readonly SwarmTreeRegion[]): number {
	const { extent } = layoutRegions(regions, NO_FOLDS, labelFont());
	return RULER_H + FIT_PAD * 2 + (extent.y1 - extent.y0) + LEGEND_H;
}

/**
 * Node fill encodes score on the product's own danger→warning→success ramp.
 * d3's `interpolateRdYlGn` was the app's largest chromatic surface and its
 * only saturated red/green, so it read as a chart pasted onto the workshop.
 * Interpolating in Lab keeps the perceptual spacing d3's ramp was chosen for.
 */
function scoreRamp(): (t: number) => string {
	const cs = getComputedStyle(document.documentElement);
	const tok = (name: string) => cs.getPropertyValue(name).trim();
	return d3.piecewise(d3.interpolateLab, [tok("--c-danger"), tok("--c-warning"), tok("--c-success")]);
}

function scoreToken(value: number): string {
	return value >= 0.7 ? "var(--c-success)" : value >= 0.4 ? "var(--c-warning)" : "var(--c-danger)";
}

function nodeFill(node: ForkNode, ramp: (t: number) => string): string {
	// A failed branch has no score to show — it never produced one — so it is
	// drawn hollow rather than coloured by a zero it did not earn.
	if (node.status === "failed") return "var(--c-surface)";
	if (node.status === "running") return "var(--c-warning)";
	// Unscored: the same argument as `failed`, for every branch of a fork that
	// ranked none of them. Neutral, not a ramp position.
	if (node.value === null) return "var(--c-border-strong)";
	return ramp(Math.min(1, Math.max(0, node.value)));
}

/**
 * Selection, hover and the winning spine as pure attribute updates — no layer
 * rebuild, so pointing at a node never tears the tree down or disturbs zoom.
 * Scoped to one band: the emphasis a hover creates belongs to the search the
 * hovered node is in, and must not light a spine in the search below it.
 */
function applyEmphasis(
	group: d3.Selection<SVGGElement, unknown, null, undefined>,
	region: RegionLayout,
	selectedId: string | null,
	hoverId: string | null,
): void {
	const hovered = hoverId ? region.byId.get(hoverId) : undefined;
	const onPath = new Set(hovered ? hovered.ancestors().map((d) => d.data.id) : []);
	const lit = (id: string) => region.pv.has(id) || onPath.has(id);

	group.selectAll<SVGPathElement, d3.HierarchyPointLink<ForkNode>>("path.mcts-link")
		.attr("stroke", (d) => {
			if (lit(d.target.data.id)) return "var(--c-accent)";
			if (d.target.data.status === "failed") return "var(--c-danger)";
			return "var(--c-border-strong)";
		})
		.attr("stroke-opacity", (d) => {
			if (lit(d.target.data.id)) return 0.95;
			if (d.target.data.status === "pruned") return 0.4;
			return 0.6;
		})
		.attr("stroke-width", (d) => {
			const w = region.competed ? linkWidth(d.target.data.visits, region.visitMax) : 1.2;
			return lit(d.target.data.id) ? Math.max(2, w) : w;
		});

	const nodes = group.selectAll<SVGGElement, PointNode>("g.mcts-node");
	nodes.select<SVGCircleElement>("circle.mcts-dot")
		.attr("stroke", (d) => {
			if (selectedId === d.data.id) return "var(--c-accent)";
			if (d.data.status === "terminal") return "var(--c-accent)";
			if (d.data.status === "failed") return "var(--c-danger)";
			return "none";
		})
		.attr("stroke-width", (d) => (selectedId === d.data.id ? 2.5 : d.data.status === "terminal" ? 2 : 1.4))
		.attr("opacity", (d) => (selectedId === d.data.id || onPath.has(d.data.id) ? 1 : d.data.status === "pruned" ? 0.45 : 1))
		.attr("filter", (d) => {
			if (selectedId === d.data.id) return "url(#mctsSelectGlow)";
			if (d.data.status === "terminal") return "url(#mctsGlow)";
			return null;
		});

	// A label the reader asked for outranks the zoom rule that hides the rest.
	group.selectAll<SVGGElement, PointNode>("g.mcts-label")
		.attr("data-pinned", (d) => (selectedId === d.data.id || hoverId === d.data.id ? "" : null));
}

/** No node is working. One allocation, so a settled canvas allocates nothing. */
const NO_WORKING: ReadonlySet<string> = new Set<string>();

/**
 * Mark the nodes that are working, as a pure attribute update — the same
 * discipline as {@link applyEmphasis}, and for the same reason: this is called
 * from a broadcast handler, and a layer rebuild per journal write would tear the
 * tree down under the reader's pointer several times a second.
 */
function applyWorking(scene: SVGGElement | null, working: ReadonlySet<string>): void {
	if (scene === null) return;
	d3.select(scene).selectAll<SVGGElement, PointNode>("g.mcts-node")
		.attr("data-working", (d) => (working.has(d.data.id) ? "" : null));
}

export function SwarmTree({
	regions, width = 800, height = 600, selectedRunId, selection, onSelectRun, onSelectNode,
	activity = EMPTY_NODE_MAP,
}: Props) {
	const svgRef = useRef<SVGSVGElement>(null);
	const gRef = useRef<SVGGElement | null>(null);
	const rulerRef = useRef<SVGGElement | null>(null);
	/** Screen-space layer holding one title per band. */
	const titlesRef = useRef<HTMLDivElement>(null);
	const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
	const stateRef = useRef<RenderState | null>(null);
	/** Until the reader pans or zooms, the view stays fitted — through resizes
	 *  and through a search that is still growing. After that the transform is
	 *  theirs and only an explicit control, a new search or a new selected
	 *  search may move it. */
	const userMoved = useRef(false);
	/** A refit the reader did not do themselves, and whether they should SEE it
	 *  move. `animate` is only for a control they pressed: a fold re-lays the
	 *  tree out and the travel explains it. A resize, a poll or a new selection
	 *  settles instantly — nothing should fly across the canvas because a
	 *  window edge moved. A single node toggle sets neither: it would yank the
	 *  tree out from under the branch just opened. */
	const refit = useRef<"no" | "instant" | "animate">("no");
	const onSelectRunRef = useRef(onSelectRun);
	onSelectRunRef.current = onSelectRun;
	const onSelectNodeRef = useRef(onSelectNode);
	onSelectNodeRef.current = onSelectNode;
	const selectionRef = useRef<ExplorerSelection | null>(selection);
	/** The one-line view note ("deeper columns continue right · drag to pan").
	 *  React state, not a d3 node: it flips only when the view crosses a
	 *  legibility or fit threshold, so panning never re-renders the tree. */
	const [viewNote, setViewNote] = useState<string | null>(null);
	const selectedRunRef = useRef(selectedRunId);
	selectedRunRef.current = selectedRunId;
	const widthRef = useRef(width);
	widthRef.current = width;
	const hoverRef = useRef<{ runId: string; nodeId: string } | null>(null);
	/** Empty: a search opens with every branch showing. Folding is something the
	 *  reader DOES, never a state they are handed — see the note on the fold
	 *  control below. */
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);
	/** The scene is drawn with `var(--c-*)` strokes, but the score ramp is
	 *  interpolated from RESOLVED token values (`scoreRamp`), so a redraw is what
	 *  re-reads them. Keyed to the whole theme, not just the mode: a palette
	 *  switch changes the same tokens. */
	const theme = useTheme();
	/** The docked legend row, measured rather than assumed: it collapses its
	 *  entries by width and takes a second line on the narrowest canvas, and the
	 *  scene has to know how much height that left it. */
	const { attach: attachLegend, size: legend } = useElementSize();
	const sceneH = Math.max(0, height - (legend.h > 0 ? legend.h : LEGEND_H));

	/**
	 * Fit the SELECTED search, not the whole canvas: the reader chose one, and
	 * fitting all of them is how a two-tree workspace ends up showing neither.
	 *
	 * `animate` is false for every fit the reader did not ask for. A first paint
	 * that animates from identity to the fitted view flies the tree in from the
	 * wrong zoom, and it makes the DEFAULT state depend on a running d3
	 * transition — so a canvas rendered while its tab is in the background, where
	 * rAF is throttled, sits unfitted until the tab is looked at. Pressing the
	 * re-fit control is a request to see the view move, and that one animates.
	 */
	const fit = useCallback((animate: boolean) => {
		const state = stateRef.current;
		if (!svgRef.current || !zoomRef.current || !state || state.regions.length === 0) return;
		const target = state.regions.find((r) => r.runId === selectedRunId) ?? state.regions[0]!;
		const { x0, x1, y0, y1 } = target.band;
		const w = Math.max(1, x1 - x0);
		const h = Math.max(1, y1 - y0);
		const availW = width - FIT_PAD * 2;
		const availH = sceneH - RULER_H - FIT_PAD * 2;
		// Fit the ROWS, not the bounding box.
		//
		// The two axes are not alike. Depth is bounded and PANNABLE — a 106-node
		// search is 7 columns and the reader scrolls sideways through them without
		// losing their place. Rows are neither: there is no natural number of them,
		// and a row scrolled off the top is a branch the reader does not know
		// exists. So the height is the axis worth spending, and fitting the
		// bounding box spends it on nothing: in a 620px-wide column that same
		// search fitted whole at 0.40, which left 45% of the canvas empty AND put
		// every label under the zoom at which labels are legible. At 0.75 the
		// height is full, the labels are readable, and depth 3–6 is one drag away.
		//
		// A tree that also fits horizontally at this scale is shown whole anyway,
		// so no case needs a branch here. Capped at 1:1 — a three-node merge
		// should not fill the wall — and floored where the picture stops being one.
		const k = Math.min(1, Math.max(OVERVIEW_MIN_SCALE, availH / h));
		// Centre horizontally only what fits; otherwise anchor left, so the root is
		// always the thing on screen rather than the middle of a tree with no
		// visible start.
		const tx = w * k <= availW ? (width - w * k) / 2 - x0 * k : FIT_PAD - x0 * k;
		// Vertically the selected band is ANCHORED to the top, never centred. A
		// short band centred in a tall canvas floats in the middle of nothing, and
		// — the reason that matters — centring pushes the bands that FOLLOW it off
		// the bottom, which is the comparison between forks that one canvas exists
		// to keep. Anchored, the next fork is right underneath where it belongs.
		//
		// Anchored on the SCENE, not on the band, whenever every band fits at this
		// scale. Anchoring the band is right when the scene is taller than the
		// canvas, and wrong when it is not: with the canvas capped to what the
		// searches need, selecting the second of two short searches put the whole
		// scene at k=1 and then scrolled the first one off the top.
		const scene = state.extent;
		const fitsWhole = (scene.y1 - scene.y0) * k <= availH;
		const ty = RULER_H + FIT_PAD - (fitsWhole ? scene.y0 : y0) * k;
		const svg = d3.select(svgRef.current);
		const to = d3.zoomIdentity.translate(tx, ty).scale(k);
		if (animate) svg.transition().duration(280).call(zoomRef.current.transform, to);
		else svg.call(zoomRef.current.transform, to);
	}, [width, sceneH, selectedRunId]);

	/**
	 * Zoom about the middle of the canvas.
	 *
	 * The transform is computed here and handed to `zoom.transform` — the same call
	 * `fit` uses and the only one this component can observe working. It was
	 * `zoom.scaleBy`, which scheduled nothing: the scene transform was
	 * byte-identical 0ms, 120ms, 240ms and 1700ms after the press, so both zoom
	 * buttons rendered, took the click, and did nothing, while fold, expand and fit
	 * on the same row worked.
	 *
	 * `userMoved` is set because a press IS the reader moving the view, and that is
	 * the second half of the same defect: the data render refits whenever
	 * `userMoved` is false, so a zoom that did not claim the view would be pulled
	 * back to the fit by the next poll even once it started applying.
	 */
	const scaleBy = useCallback((factor: number) => {
		const svgEl = svgRef.current;
		const zoom = zoomRef.current;
		if (!svgEl || !zoom) return;
		const from = d3.zoomTransform(svgEl);
		const [minK, maxK] = zoom.scaleExtent();
		const k = Math.min(maxK, Math.max(minK, from.k * factor));
		if (k === from.k) return;
		// Anchored on the canvas centre, so the thing the reader is looking at is
		// the thing that stays put.
		const [cx, cy] = [width / 2, sceneH / 2];
		const to = d3.zoomIdentity
			.translate(cx - (cx - from.x) * (k / from.k), cy - (cy - from.y) * (k / from.k))
			.scale(k);
		userMoved.current = true;
		d3.select(svgEl).transition().duration(180).call(zoom.transform, to);
	}, [width, sceneH]);

	/**
	 * Fold every abandoned branch, in every search. A CONTROL, never a default:
	 * settling a search retires every node that was still open, so "abandoned"
	 * describes most of a finished tree, and applying it on arrival is what made
	 * a completed search open as a picture of nothing.
	 */
	const foldLosing = useCallback(() => {
		refit.current = "animate";
		setCollapsed(new Set(
			regions.flatMap((region) => [...losingBranchIds(region.root)]
				.map((id) => foldKey(region.runId, id))),
		));
	}, [regions]);

	const expandAll = useCallback(() => {
		refit.current = "animate";
		setCollapsed(new Set<string>());
	}, []);

	/**
	 * A new set of searches, or a different one selected: the view is no longer
	 * the reader's, it is stale. Refit.
	 *
	 * Guarded on the run IDS, never on `regions` identity. Nothing upstream
	 * caches a poll that changed nothing — `useAsyncResource` stores whatever the
	 * RPC returned, so every revalidation hands down a fresh view object, a fresh
	 * trees map and freshly-built roots. Firing on identity therefore reset
	 * `userMoved` and refitted on every poll: pan a 106-node search and 1.5s
	 * later the canvas snapped back to the fit, which is precisely the thing the
	 * persistent zoom layer exists to prevent.
	 */
	const fittedFor = useRef("");
	useEffect(() => {
		const key = `${selectedRunId}\u0000${regions.map((region) => region.runId).join("\u0001")}`;
		if (fittedFor.current === key) return;
		fittedFor.current = key;
		userMoved.current = false;
		refit.current = "instant";
	}, [regions, selectedRunId]);

	// One-time scaffold: glow filters, the persistent zoom/pan layer, the fixed
	// depth ruler and the zoom behavior. The transform lives on the zoom layer
	// and is never reset by data updates, so polling cannot snap a pan back.
	useEffect(() => {
		const svg = d3.select(svgRef.current!);
		const defs = svg.append("defs");
		for (const [id, blur] of [["mctsGlow", "3.5"], ["mctsSelectGlow", "5"]] as const) {
			const f = defs.append("filter").attr("id", id)
				.attr("x", "-60%").attr("y", "-60%").attr("width", "220%").attr("height", "220%");
			f.append("feGaussianBlur").attr("stdDeviation", blur).attr("result", "blur");
			f.append("feMerge").selectAll("feMergeNode").data(["blur", "SourceGraphic"]).join("feMergeNode").attr("in", (d) => d);
		}
		const g = svg.append("g");
		gRef.current = g.node();
		const ruler = svg.append("g").attr("class", "mcts-ruler");
		rulerRef.current = ruler.node();
		const zoom = d3.zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.05, 6])
			.on("zoom", (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
				if (event.sourceEvent) userMoved.current = true;
				g.attr("transform", event.transform.toString());
				g.selectAll("g.mcts-labels").attr("data-lod", event.transform.k >= LABEL_MIN_SCALE ? "" : null);
				positionBandTitles(titlesRef.current, event.transform);
				positionRuler(ruler, stateRef.current, event.transform);
				const target = stateRef.current?.regions.find((r) => r.runId === selectedRunRef.current)
					?? stateRef.current?.regions[0];
				setViewNote(target === undefined
					? null
					: viewNoteFor(target.band, event.transform.k, widthRef.current - FIT_PAD * 2));
			});
		zoomRef.current = zoom;
		svg.call(zoom);
		return () => {
			svg.on(".zoom", null);
			svg.selectAll("*").remove();
			gRef.current = null;
			rulerRef.current = null;
			zoomRef.current = null;
		};
	}, []);

	// Data render — rebuilds the band/guide/link/node/label layers inside the
	// persistent zoom layer when the searches, the fold set, the viewport or the
	// palette actually changes. `regions` is memoised upstream and its roots only
	// swap identity when the row set changed, so steady-state polls never reach
	// here.
	useEffect(() => {
		const rootGroup = gRef.current;
		if (rootGroup === null) return;
		const g = d3.select(rootGroup);
		g.selectAll("*").remove();

		const state = layoutRegions(regions, collapsed, labelFont());
		stateRef.current = state;
		const ramp = scoreRamp();
		const titles = new Map(regions.map((r) => [r.runId, r]));

		// Bands first, so every tree paints over its own boundary. Soft: the
		// canvas surface tinted a shade, hairline edge, no shadow and no radius
		// worth noticing — a region of one scene, not a card floating on it.
		const bands = g.append("g").attr("class", "mcts-bands")
			.selectAll<SVGGElement, RegionLayout>("g")
			.data(state.regions, (d) => d.runId)
			.join("g")
			.attr("class", "mcts-band")
			.attr("data-run", (d) => d.runId)
			.style("cursor", "pointer")
			.on("click", (_event: MouseEvent, d) => onSelectRunRef.current?.(d.runId));
		bands.append("rect")
			.attr("x", (d) => d.band.x0).attr("y", (d) => d.band.y0)
			.attr("width", (d) => d.band.x1 - d.band.x0)
			.attr("height", (d) => d.band.y1 - d.band.y0)
			.attr("rx", 6)
			.attr("fill", "var(--c-text-3)")
			.attr("fill-opacity", (d) => (d.runId === selectedRunId ? 0.07 : 0.03))
			.attr("stroke", (d) => (d.runId === selectedRunId ? "var(--c-accent)" : "var(--c-border)"))
			.attr("stroke-opacity", (d) => (d.runId === selectedRunId ? 0.75 : 0.5))
			.attr("stroke-width", 1);
		// The titles are HTML in an overlay, not text in the scene: geometry
		// belongs in scene units and TYPE does not. A caption inside the zoom
		// layer is 11px at 1:1 and 3px at an overview — illegible exactly when
		// there are enough bands on screen for "which search is this" to be the
		// question. Counter-scaling it inside the SVG only trades that for a
		// caption that grows over the band beneath it.
		const overlay = titlesRef.current;
		if (overlay) {
			overlay.replaceChildren(...state.regions.map((region) => {
				const meta = titles.get(region.runId);
				const el = document.createElement("div");
				el.className = "absolute flex min-w-0 items-baseline gap-2 whitespace-nowrap";
				el.dataset.bandTitle = region.runId;
				el.dataset.x = String(region.band.x0 + BAND_PAD);
				el.dataset.y = String(region.band.y0 + BAND_PAD);
				// The band's own right edge, so the caption is bounded by the box it
				// names rather than by the canvas. Carried as data because the
				// clamping runs from the zoom handler, in screen space, on a scene
				// this closure has already finished with.
				el.dataset.x1 = String(region.band.x1 - BAND_PAD);
				const name = document.createElement("span");
				name.className = `min-w-0 shrink truncate text-[11px] font-medium ${
					region.runId === selectedRunId ? "p-text" : "p-text-2"
				}`;
				name.textContent = meta?.title ?? "";
				// A truncated caption is the one place on this canvas where the
				// untruncated text is nowhere else: a band has no tooltip, and the
				// task it names can be a paragraph. The cap used to be a flat 22rem,
				// which on a 313px column truncated mid-word with no way to read the
				// rest.
				name.title = meta?.title ?? "";
				const note = document.createElement("span");
				// Shrinks four times faster than the name. Both have to give on a
				// narrow canvas, and the NAME is what identifies the band — with the
				// note holding its width the name was squeezed to a single glyph,
				// while the note repeats what the resolution panel above already
				// states in full.
				note.className = "min-w-0 shrink-[4] truncate text-[9px] font-mono p-text-3";
				note.textContent = meta?.note ?? "";
				note.title = meta?.note ?? "";
				el.appendChild(name);
				el.appendChild(note);
				return el;
			}));
		}

		for (const region of state.regions) {
			const dim = region.runId !== selectedRunId;
			const rg = g.append("g")
				.attr("class", "mcts-region")
				.attr("data-run", region.runId)
				// Unselected searches recede but stay readable: this is the only
				// place a band's trees are treated differently from the lit one.
				//
				// 0.72, not 0.5. At a half the 11px labels of an unselected band are
				// under the contrast at which they are text, so a four-branch search
				// beside a hundred-branch one read as a smudge rather than as the
				// comparison the canvas exists for. Recession is the point; illegible
				// is not recession.
				.attr("opacity", dim ? 0.72 : 1)
				.attr("transform", `translate(0,${region.shiftY})`);

			// Depth guides — the columns the ruler labels.
			rg.append("g").attr("class", "mcts-guides")
				.selectAll("line")
				.data(d3.range(region.depth + 1))
				.join("line")
				.attr("x1", (d) => d * COL).attr("x2", (d) => d * COL)
				.attr("y1", region.rows.start - ROW / 2).attr("y2", region.rows.end + ROW / 2)
				.attr("stroke", "var(--c-border)").attr("stroke-width", 1)
				.attr("stroke-opacity", 0.7);

			rg.append("g").attr("class", "mcts-links").attr("fill", "none")
				.attr("pointer-events", "none")
				.selectAll("path")
				.data(region.links)
				.join("path")
				.attr("class", "mcts-link")
				.attr("stroke-linecap", "round")
				.attr("stroke-dasharray", (d) => (d.target.data.status === "pruned" ? "3,4" : null))
				.attr("d", d3.linkHorizontal<d3.HierarchyPointLink<ForkNode>, PointNode>()
					.x((d) => d.y).y((d) => d.x));

			const radiusOf = (node: ForkNode) => (
				region.competed ? nodeRadius(node.visits, region.visitMax) : NODE_R_UNSCORED
			);

			const nodeG = rg.append("g").attr("class", "mcts-nodes")
				.selectAll("g")
				.data(region.nodes)
				.join("g")
				.attr("class", "mcts-node")
				.attr("transform", (d) => `translate(${d.y},${d.x})`)
				.style("cursor", "pointer");

			// A collapsed node keeps a dashed halo at every zoom — folded-away work
			// must never look like work that was never done.
			nodeG.filter((d) => collapsed.has(foldKey(region.runId, d.data.id)))
				.append("circle")
				.attr("r", (d) => radiusOf(d.data) + 3.5)
				.attr("fill", "none")
				.attr("stroke", "var(--c-text-3)")
				.attr("stroke-width", 1)
				.attr("stroke-dasharray", "2,2");

			nodeG.append("circle")
				.attr("class", "mcts-dot")
				.attr("r", (d) => radiusOf(d.data))
				.attr("fill", (d) => nodeFill(d.data, ramp));

			// THE FAN-IN VERTEX, and the only encoding it gets: a square around the
			// same dot. The fill and the radius stay exactly a sibling's, because a
			// vertex is graded through the same scoring body and a second colour
			// would claim it was scored differently. What the square answers is the
			// one question the tree cannot: this node consumed a whole level, and its
			// other k−1 edges are not in the picture.
			//
			// A silhouette rather than a tint, so it survives the zoom at which
			// labels are dropped — an overview of 520 nodes is exactly where "which
			// of these fanned in" is worth asking.
			nodeG.filter((d) => region.fanIn.has(d.data.id))
				.append("rect")
				.attr("class", "mcts-fan-in")
				.attr("x", (d) => -radiusOf(d.data) - 3)
				.attr("y", (d) => -radiusOf(d.data) - 3)
				.attr("width", (d) => radiusOf(d.data) * 2 + 6)
				.attr("height", (d) => radiusOf(d.data) * 2 + 6)
				.attr("rx", 1.5)
				.attr("fill", "none")
				.attr("stroke", "var(--c-accent)")
				.attr("stroke-width", 1.25);

			// A generous invisible hit area: a 3.5px dot is not a pointer target.
			// It doubles as the working pulse's ring — one element per node either
			// way, so a live search of 520 nodes adds none.
			nodeG.append("circle").attr("class", "mcts-halo")
				.attr("r", ROW / 2).attr("fill", "transparent");

			// Labels reach into the next column's space, so they must never swallow
			// a pointer: only the fold handle inside them is interactive.
			const labels = rg.append("g").attr("class", "mcts-labels").attr("pointer-events", "none")
				.selectAll("g")
				.data(region.nodes)
				.join("g")
				.attr("class", "mcts-label")
				.attr("transform", (d) => `translate(${d.y},${d.x})`);

			const foldable = labels.filter((d) => d.data.children.length > 0);
			const handle = foldable.append("g")
				.attr("class", "mcts-handle")
				.attr("transform", `translate(${HANDLE_X},0)`)
				.attr("pointer-events", "all")
				.attr("opacity", (d) => (collapsed.has(foldKey(region.runId, d.data.id)) ? 1 : 0.5))
				.style("cursor", "pointer")
				.on("click", (event: MouseEvent, d) => {
					event.stopPropagation();
					setCollapsed((prev) => {
						const next = new Set(prev);
						const key = foldKey(region.runId, d.data.id);
						if (!next.delete(key)) next.add(key);
						return next;
					});
				});
			handle.append("circle").attr("r", 5.5)
				.attr("fill", "var(--c-surface)").attr("stroke", "var(--c-border)").attr("stroke-width", 1);
			handle.append("text")
				.text((d) => (collapsed.has(foldKey(region.runId, d.data.id)) ? "+" : "−"))
				.attr("text-anchor", "middle").attr("dy", "0.33em")
				.attr("font-size", "9px").attr("fill", "var(--c-text-2)");

			// A knockout halo in the canvas colour: labels cross the links between
			// columns, and text laid straight over a stroke is what makes a dense
			// tree look dirty.
			const text = labels.append("text")
				.attr("x", LABEL_X).attr("dy", "0.33em").attr("font-size", "11px")
				.attr("paint-order", "stroke")
				.attr("stroke", "var(--c-surface)").attr("stroke-width", 3).attr("stroke-linejoin", "round");
			// Score first, in the score's own colour: a column of percentages is
			// scannable in a way a hundred prose fragments are not. A branch with no
			// score contributes no tspan at all, so the label starts at its text
			// rather than at a fabricated `0%`.
			//
			// Every part is read off the layout's own clip. The score, the name and
			// the badges used to be four independent expressions here, and the
			// scene's right edge was a fifth constant that had to agree with them —
			// which is how a label could be cut at 20 characters and still be fitted
			// as if it were 205px wide.
			const labelOf = (d: PointNode) => region.labels.get(d.data.id);
			text.filter((d) => (labelOf(d)?.score ?? "") !== "")
				.append("tspan")
				.text((d) => labelOf(d)?.score ?? "")
				.attr("font-family", "var(--font-mono)").attr("font-size", "9px")
				.attr("fill", (d) => (d.data.status === "failed" ? "var(--c-danger)" : scoreToken(d.data.value ?? 0)));
			text.append("tspan")
				.text((d) => labelOf(d)?.name ?? "")
				.attr("fill", (d) => (d.data.status === "pruned" ? "var(--c-text-3)" : "var(--c-text-2)"));
			// `+n` for the subtree a fold hides, `⋈k` for the join and how many
			// parents it joined. Mono and accent, after the name rather than before
			// it, so a column of labels still scans on its scores.
			text.filter((d) => (labelOf(d)?.badge ?? "") !== "")
				.append("tspan")
				.text((d) => labelOf(d)?.badge ?? "")
				.attr("font-family", "var(--font-mono)").attr("font-size", "9px")
				.attr("fill", "var(--c-accent-fg)");

			nodeG
				.on("mouseenter", (event: MouseEvent, d) => {
					const [x, y] = d3.pointer(event, svgRef.current);
					hoverRef.current = { runId: region.runId, nodeId: d.data.id };
					setTooltip({
						x, y, node: d.data, competed: region.competed,
						fanIn: region.fanIn.get(d.data.id) ?? null,
						why: region.why.get(d.data.id) ?? null,
						runName: region.name,
					});
					applyEmphasis(rg, region, selectedNodeIn(selectionRef.current, region.runId), d.data.id);
				})
				.on("mouseleave", () => {
					hoverRef.current = null;
					setTooltip(null);
					applyEmphasis(rg, region, selectedNodeIn(selectionRef.current, region.runId), null);
				})
				.on("click", (event: MouseEvent, d) => {
					event.stopPropagation();
					onSelectRunRef.current?.(region.runId);
					onSelectNodeRef.current?.({ runId: region.runId, nodeId: d.data.id });
				});

			const hover = hoverRef.current;
			applyEmphasis(
				rg, region,
				selectedNodeIn(selectionRef.current, region.runId),
				hover?.runId === region.runId ? hover.nodeId : null,
			);
		}
		// The rebuild above replaced every node element, so the working marks went
		// with them. Same restoration `applyEmphasis` gets, for the same reason.
		applyWorking(rootGroup, workingRef.current);

		const transform = d3.zoomTransform(svgRef.current!);
		// The titles were just rebuilt at their scene anchors and have never been
		// positioned, so they must be placed for the CURRENT transform whether or
		// not a refit follows — `fit`'s transition then keeps moving them.
		positionBandTitles(titlesRef.current, transform);
		if (refit.current !== "no" || !userMoved.current) {
			const animate = refit.current === "animate";
			refit.current = "no";
			fit(animate);
		} else {
			g.selectAll("g.mcts-labels").attr("data-lod", transform.k >= LABEL_MIN_SCALE ? "" : null);
			positionRuler(d3.select(rulerRef.current!), state, transform);
		}
	}, [regions, width, sceneH, collapsed, theme, selectedRunId, fit]);

	// Selection is an attribute update, plus the two things that make a node
	// chosen from the inspector actually appear: open the folds hiding it, then
	// bring it into view. Without either, clicking a row of the search path is
	// a no-op whenever the node is off the current pan or inside a fold.
	useEffect(() => {
		selectionRef.current = selection;
		const state = stateRef.current;
		if (!gRef.current || !state) return;
		const g = d3.select(gRef.current);
		for (const region of state.regions) {
			const rg = g.select<SVGGElement>(`g.mcts-region[data-run="${CSS.escape(region.runId)}"]`);
			if (rg.empty()) continue;
			const hover = hoverRef.current;
			applyEmphasis(
				rg, region,
				selectedNodeIn(selection, region.runId),
				hover?.runId === region.runId ? hover.nodeId : null,
			);
		}
		if (!selection || !svgRef.current || !zoomRef.current) return;
		const region = state.regions.find((r) => r.runId === selection.runId);
		if (!region) return;
		const target = region.byId.get(selection.nodeId);
		if (!target) {
			// Keyed by search at THIS layer: the fold set spans every band, so the
			// model's ancestor ids become fold keys here rather than there.
			const hidden = ancestorIds(region.root, selection.nodeId)
				.map((id) => foldKey(region.runId, id))
				.filter((key) => collapsed.has(key));
			if (hidden.length > 0) {
				setCollapsed((prev) => {
					const next = new Set(prev);
					for (const key of hidden) next.delete(key);
					return next;
				});
			}
			return;
		}
		// A fitted view already shows every node, so there is nothing to bring
		// into view — and the fit is a TRANSITION, so the check below would read
		// the PRE-fit transform, decide the node is off-screen, and pan away from
		// the very tree it was fitting. Only a view the reader has moved can hide
		// a node from them.
		if (!userMoved.current) return;
		const t = d3.zoomTransform(svgRef.current);
		const [sx, sy] = [t.applyX(target.y), t.applyY(target.x + region.shiftY)];
		if (sx > 40 && sx < width - 40 && sy > RULER_H + 20 && sy < sceneH - 20) return;
		d3.select(svgRef.current).transition().duration(320).call(
			zoomRef.current.transform,
			d3.zoomIdentity
				.translate(width / 2 - target.y * t.k, sceneH / 2 - (target.x + region.shiftY) * t.k)
				.scale(t.k),
		);
	}, [selection, collapsed, width, sceneH]);

	/**
	 * Which nodes are WORKING, as an attribute update.
	 *
	 * `head_activity` fires on every journal write a node makes, so this runs
	 * often. It must never rebuild a layer: the scene is torn down and redrawn on
	 * `regions`, and doing that per step at 520 nodes would drop the frame budget
	 * on the floor and take pan and tooltip with it. So it walks the existing
	 * nodes and toggles one attribute, exactly the way selection and hover do.
	 *
	 * MOTION ONLY WHERE STATE CHANGED, and the state is RECENCY: a node is
	 * working while its counter has moved inside the last {@link WORKING_MS}. Not
	 * "has a counter" — a settled search's counters are all non-zero and it must
	 * sit still, or the mark stops meaning "working" and starts meaning "exists".
	 *
	 * Recency rather than a remembered delta, and that is the load-bearing
	 * choice. A ref holding "the map I last reacted to" is not idempotent, and an
	 * effect in this tree is invoked twice: React's StrictMode mounts, unmounts
	 * and remounts, so the second pass saw its own recorded map, found no delta,
	 * and the very first delivery of a live search was marked on a scene that had
	 * already been thrown away. Timestamps survive that: the second pass
	 * recomputes the same answer from them and re-applies it.
	 */
	const movedAt = useRef(new Map<string, number>());
	const lastCount = useRef(new Map<string, number>());
	const workingRef = useRef<ReadonlySet<string>>(NO_WORKING);
	const workingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	/** Recompute who is working, paint it, and come back when the next mark
	 *  expires. Self-scheduling, so a node that stops working stops pulsing
	 *  without anything having to notice that it stopped. */
	const sweepWorking = useCallback(function sweep(): void {
		const now = Date.now();
		const working = new Set<string>();
		let soonest = Number.POSITIVE_INFINITY;
		for (const [id, at] of movedAt.current) {
			const left = WORKING_MS - (now - at);
			if (left <= 0) continue;
			working.add(id);
			soonest = Math.min(soonest, left);
		}
		workingRef.current = working;
		applyWorking(gRef.current, working);
		clearTimeout(workingTimer.current);
		workingTimer.current = Number.isFinite(soonest)
			? setTimeout(sweep, soonest)
			: undefined;
	}, []);
	useEffect(() => {
		const now = Date.now();
		for (const [id, count] of activity) {
			if (lastCount.current.get(id) === count) continue;
			lastCount.current.set(id, count);
			movedAt.current.set(id, now);
		}
		sweepWorking();
	}, [activity, sweepWorking]);
	useEffect(() => () => { clearTimeout(workingTimer.current); }, []);

	const selectedRegion = stateRef.current?.regions.find((r) => r.runId === selectedRunId);
	const competedSelected = selectedRegion?.competed ?? true;
	/** The key only claims a fan-in where the selected search actually has one:
	 *  `expand:'sample'` fans in nothing, and a legend entry for an encoding that
	 *  is not on the canvas teaches the reader to look for something absent. */
	const fansInSelected = (selectedRegion?.fanIn.size ?? 0) > 0;

	return (
		<div className="relative flex w-full h-full flex-col overflow-hidden">
			{/* The scene, and only the scene. Its height is what the canvas has left
			    after the docked row below measures itself, so the fit can never
			    place a band under the key. */}
			<div className="relative shrink-0" style={{ height: sceneH }}>
				<svg
					ref={svgRef} width={width} height={sceneH} className="w-full h-full block"
					style={{ touchAction: "none" }}
				/>

				{/* One title per band, pinned to its band in screen space. Populated
				    imperatively and moved from the zoom handler, so panning does not
				    round-trip through React. `top-0 left-0` because every child is
				    placed by a `translate` the handler writes. */}
				<div ref={titlesRef} aria-hidden
					className="absolute inset-0 overflow-hidden pointer-events-none select-none [&>*]:top-0 [&>*]:left-0" />

				{/* The view note, in the ruler's own register, one line under it.
				    Overlay, never in flow: a line whose presence changes the scene
				    height would re-fit the view and could toggle itself. Right-aligned
				    because the fit anchors the root at the left. */}
				{viewNote !== null && (
					<div aria-live="polite"
						className="absolute left-0 right-0 flex justify-end pr-4 pointer-events-none select-none text-[9px] p-text-3"
						style={{ top: RULER_H, fontFamily: "var(--font-mono)" }}
					>{viewNote}</div>
				)}

				{tooltip && <NodeTip tip={tooltip} width={width} />}
			</div>

			{/* The key and the controls, DOCKED under the rows rather than floated
			    over them. Both were absolutely positioned inside the canvas, which
			    was survivable while a fitted tree left the bottom empty and became
			    two chips sitting on top of the branches the moment a fit filled the
			    height. On the narrowest canvas the row wraps — the key on one line,
			    the controls on the next — and the scene above is measured to match,
			    so nothing is ever covered and nothing is ever clipped. */}
			<div ref={attachLegend} data-tree-legend
				className="shrink-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 pt-1 pb-1.5">
				<div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] p-text-3 select-none">
					{competedSelected ? (
						<>
							<span className="flex items-center gap-1.5">
								<span className="h-2 w-14 rounded-full" style={{ background: "linear-gradient(90deg in oklab, var(--c-danger), var(--c-warning), var(--c-success))" }} />
								score
							</span>
							{width >= 470 && (
								<>
									<span className="flex items-center gap-1"><span className="size-1 rounded-full p-dot-neutral" /><span className="size-2 rounded-full p-dot-neutral" />visits</span>
									<span className="flex items-center gap-1"><span className="inline-block w-3 h-px" style={{ background: "var(--c-accent)" }} />winning line</span>
									<span className="opacity-70">dashed = pruned · hollow = failed</span>
								</>
							)}
						</>
					) : (
						/* Nothing was ranked here, so the key says what the picture
						   actually encodes: lifecycle, and only lifecycle. */
						<>
							<span className="min-w-0">every branch fed the settle · none was ranked</span>
							{width >= 470 && (
								<span className="opacity-70">amber = running · hollow = failed</span>
							)}
						</>
					)}
					{fansInSelected && (
						<span className="flex items-center gap-1">
							<span aria-hidden className="inline-block size-2 rounded-[1px] border"
								style={{ borderColor: "var(--c-accent)" }} />
							fan-in vertex
						</span>
					)}
				</div>
				<div className="ml-auto shrink-0 flex items-center gap-0.5">
					<TreeControl label="Fold abandoned branches" onClick={foldLosing}><ArrowsInSimpleIcon size={13} /></TreeControl>
					<TreeControl label="Expand every branch" onClick={expandAll}><ArrowsOutSimpleIcon size={13} /></TreeControl>
					<span aria-hidden className="mx-0.5 h-3.5 w-px" style={{ background: "var(--c-border)" }} />
					<TreeControl label="Zoom out" onClick={() => scaleBy(1 / 1.5)}><MagnifyingGlassMinusIcon size={13} /></TreeControl>
					<TreeControl label="Zoom in" onClick={() => scaleBy(1.5)}><MagnifyingGlassPlusIcon size={13} /></TreeControl>
					<TreeControl label="Fit the selected search to view" onClick={() => fit(true)}><ArrowsOutIcon size={13} /></TreeControl>
				</div>
			</div>
		</div>
	);
}

/** The selected node id, but only for the band it belongs to. */
function selectedNodeIn(selection: ExplorerSelection | null, runId: string): string | null {
	return selection && selection.runId === runId ? selection.nodeId : null;
}

/**
 * Pin each band's title to its band, in screen space. Called from the zoom
 * handler, so it tracks the transition `fit` runs as well as a drag.
 *
 * Titles stay at a constant 11px however far out the reader zooms, which is the
 * whole reason they are HTML. A title whose band has scrolled off the top is
 * hidden rather than clamped: a caption pinned to the viewport edge would sit
 * over the band that IS on screen and name the wrong search.
 */
function positionBandTitles(
	overlay: HTMLDivElement | null,
	transform: d3.ZoomTransform,
): void {
	if (!overlay) return;
	// Measured here rather than closed over: this runs from the zoom handler,
	// which is installed once, so a captured size would be the first one
	// forever. The overlay is inset to the scene, so it IS the scene's box.
	const { clientHeight: height, clientWidth: width } = overlay;
	for (const el of overlay.querySelectorAll<HTMLElement>(":scope > div")) {
		const x = transform.applyX(Number(el.dataset.x));
		const y = transform.applyY(Number(el.dataset.y));
		// Clamped to the left edge, unlike the vertical axis. A band spans the
		// whole scene width, so a caption held at the left edge is still over its
		// OWN band and still names the right search — which is exactly the
		// argument that forbids clamping it vertically, where the band below would
		// get someone else's name. Unclamped, panning right walked every caption
		// off the left of the canvas a glyph at a time.
		const left = Math.max(BAND_PAD, x);
		el.style.transform = `translate(${left}px,${y}px)`;
		// The room a caption has is its OWN BAND to the right of where it starts,
		// never the canvas. Two boxes, and the caption belongs to the narrower one:
		// a band is only as wide as the widest label in the widest tree on the
		// canvas, so on a workspace of one-node searches the band is a couple of
		// hundred pixels and a caption bounded by the canvas ran several times past
		// its own edge. That is the leak in the owner's screenshot.
		//
		// Still bounded by the canvas as well, because panning a wide band leaves
		// its right edge off screen and a caption may not run off the card.
		const bandRight = transform.applyX(Number(el.dataset.x1));
		el.style.maxWidth = `${Math.max(0, Math.min(bandRight, width - BAND_PAD) - left)}px`;
		el.style.visibility = y < RULER_H || y > height - 12 ? "hidden" : "visible";
	}
}

function TreeControl({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button" onClick={onClick} title={label} aria-label={label}
			className="p-btn-ghost inline-flex size-6 items-center justify-center rounded-sm"
		>
			{children}
		</button>
	);
}

/** Depth axis — fixed to the viewport, repositioned from the zoom transform,
 *  so "how deep did this get" is answered at any pan and any scale. */
function positionRuler(
	ruler: d3.Selection<SVGGElement, unknown, null, undefined>,
	state: RenderState | null,
	transform: d3.ZoomTransform,
): void {
	if (!state) return;
	ruler.selectAll("text")
		.data(d3.range(state.depth + 1))
		.join("text")
		.attr("y", 12)
		.attr("x", (d) => transform.applyX(d * COL))
		.attr("font-size", "9px")
		.attr("font-family", "var(--font-mono)")
		.attr("fill", "var(--c-text-3)")
		.attr("text-anchor", "middle")
		.attr("display", (d) => {
			const x = transform.applyX(d * COL);
			return x < 8 || x > (ruler.node()?.ownerSVGElement?.clientWidth ?? 0) - 8 ? "none" : null;
		})
		.text((d) => `d${d}`);
}

/** What a branch's state MEANS depends on whether the search ranked its
 *  candidates: `open` is "still explorable" where there is a selector to reach it
 *  and "done, its answer went into the settle" where there is not. Same word in
 *  the data, two different facts. */
const STATUS_NOTE = {
	competed: {
		open: "still explorable",
		terminal: "the answer the search settled on",
		pruned: "dropped below the prune floor",
		failed: "the branch never produced a score",
		running: "still running",
	},
	merged: {
		open: "finished, its answer went into the settle",
		terminal: "finished, its answer went into the settle",
		pruned: "abandoned",
		failed: "this branch errored",
		running: "still running",
	},
} satisfies Record<"competed" | "merged", Record<ForkNode["status"], string>>;

/** What the hovered node is, and everything about it the label had no room for. */
interface TooltipState {
	readonly x: number;
	readonly y: number;
	readonly node: ForkNode;
	readonly competed: boolean;
	/** Parents this node fanned in, or null for a sampled sibling. */
	readonly fanIn: number | null;
	/** The node's own reason for existing, verbatim from the journal, or null. */
	readonly why: string | null;
	/** The run's name, which the ROOT wears when it carries no action of its own. */
	readonly runName: string;
}

function NodeTip({ tip, width }: { tip: TooltipState; width: number }) {
	const { node, competed, fanIn, why, runName } = tip;
	const TIP_W = 260;
	const flip = tip.x + TIP_W + 24 > width;
	return (
		<div
			className="absolute z-50 pointer-events-none p-surface p-border border rounded-lg px-3 py-2 p-shadow-menu text-xs animate-scale-in"
			style={{
				width: TIP_W,
				left: flip ? undefined : tip.x + 16,
				right: flip ? width - tip.x + 16 : undefined,
				top: tip.y + 12,
			}}
		>
			<div className="font-medium p-text mb-1.5 leading-snug line-clamp-2">
				{cleanNodeLabel(node.action, runName)}
			</div>
			<div className="flex items-center gap-2 tabular-nums">
				{(node.status === "failed" || node.value !== null) && (
					<span
						className="text-base font-semibold leading-none"
						style={{ color: node.status === "failed" ? "var(--c-danger)" : scoreToken(node.value ?? 0) }}
					>
						{node.status === "failed" ? "fail" : `${Math.round(Math.min(1, Math.max(0, node.value ?? 0)) * 100)}%`}
					</span>
				)}
				{node.visits !== null && (
					<span className="p-text-3">{node.visits} rollout{node.visits === 1 ? "" : "s"}</span>
				)}
				<span className="p-text-3">depth {node.depth}</span>
			</div>
			<div className="p-text-3 mt-1">
				{STATUS_NOTE[competed ? "competed" : "merged"][node.status] ?? node.status}
			</div>
			{/* The fan-in, spelled out. The square on the node says THAT it fanned a
			    level in; only here is there room to say how wide, and to say that the
			    tree above it shows one of those parents and not the rest. */}
			{fanIn !== null && (
				<div className="mt-1.5 flex items-baseline gap-1.5 p-accent-fg">
					<span className="font-mono text-[10px]">⋈{fanIn}</span>
					<span className="leading-snug">
						fan-in vertex — aggregated {fanIn} parents. The edge drawn above it is the
						selection parent; the other {fanIn - 1} are not in this tree.
					</span>
				</div>
			)}
			{/* The node's own reason for existing. A wave sibling carries the
			    proposal's own why, which the 20-character label always truncates. */}
			{why !== null && (
				<div className="mt-1.5 p-text-3 leading-snug line-clamp-2">{why}</div>
			)}
			{node.observation && (
				<div className="mt-1.5 pt-1.5 border-t p-border p-text-2 leading-relaxed line-clamp-3">
					{node.observation}
				</div>
			)}
		</div>
	);
}
