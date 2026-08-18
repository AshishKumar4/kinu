/**
 * The fork trees — every time the agent split its work, drawn as the trees they
 * are, on ONE canvas.
 *
 * A merge (`action:'fork'`) is this tree at depth 1: the task at the root, one
 * head per child. A search (`action:'swarm'` with a `depth`) is the same tree
 * deeper, with its branches scored against each other. One renderer, one node
 * shape, depth varying — because the alternative was two panes where the same
 * user action landed in one or the other depending on an internal strategy id.
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
 * What the picture says before anything is clicked, when the fork COMPETED:
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
 *
 * Every score/rollout encoding is gated on the branches actually carrying
 * those numbers. A merge ranks nothing, and a ramp fill or a winning spine
 * drawn from its absent values would state a verdict the fork never reached.
 */
import { useRef, useEffect, useState, useCallback } from "react";
import * as d3 from "d3";
import {
	ArrowsOutIcon, MagnifyingGlassPlusIcon, MagnifyingGlassMinusIcon,
	ArrowsInSimpleIcon, ArrowsOutSimpleIcon,
} from "@phosphor-icons/react";
import { useTheme } from "@/hooks/use-theme";
import type { ForkNode } from "@/lib/protocol";
import {
	ancestorIds, cleanNodeLabel, isCompeted, linkWidth, losingBranchIds, maxVisits, NODE_R_MAX,
	NODE_R_UNSCORED, nodeRadius, principalVariation, subtreeCount, truncate,
	type ExplorerSelection,
} from "./fork-tree-model";

/** One search's band on the canvas. */
export interface ForkTreeRegion {
	/** The search root's id — what a selection names, and what the tree maps key on. */
	runId: string;
	root: ForkNode;
	/** What the fork was asked to do, written above its tree inside the boundary. */
	title: string;
	/** How it settled and what it was dispatched with. */
	note: string;
}

interface Props {
	/**
	 * Every search to draw, in the order they should stack. MUST be referentially
	 * stable across renders that changed nothing — the render effect keys on it,
	 * and a fresh array each poll would rebuild the scene several times a second.
	 */
	regions: readonly ForkTreeRegion[];
	width?: number;
	height?: number;
	/** Which band is lit, and what the view fits itself to. */
	selectedRunId: string | null;
	/** Which node is emphasised, if the reader has opened one. */
	selection: ExplorerSelection | null;
	onSelectRun?: (runId: string) => void;
	onSelectNode?: (selection: ExplorerSelection) => void;
}

/** Row pitch. One text line plus air — labels cannot collide at any tree size. */
const ROW = 22;
/** Depth pitch. Wide enough for a node, its fold handle and a 20-char label. */
const COL = 206;
const HANDLE_X = NODE_R_MAX + 8;
const LABEL_X = NODE_R_MAX + 22;
/** Room the rightmost column's labels need inside the fitted extent — without
 *  it the deepest column is fitted to its dots and its text falls off. */
const LABEL_W = 205;
/** Below this zoom a label is under ~8px on screen — noise, not text. */
const LABEL_MIN_SCALE = 0.72;
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
/** Air inside a band's boundary, and the line of type naming the search. */
const BAND_PAD = 10;
const BAND_TITLE_H = 26;
/** Between two boundaries. A hairline of separation, not a gutter — the whole
 *  point of one canvas is that the space between trees is not wasted. */
const BAND_GAP = 6;

type PointNode = d3.HierarchyPointNode<ForkNode>;

/** A fold is per NODE PER SEARCH: node ids are unique inside a search only. */
function foldKey(runId: string, nodeId: string): string {
	return `${runId}\u0000${nodeId}`;
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
	regions: readonly ForkTreeRegion[],
	collapsed: ReadonlySet<string>,
): RenderState {
	const layout = d3.tree<ForkNode>().nodeSize([ROW, COL])
		.separation((a, b) => (a.parent === b.parent ? 1 : 1.6));
	const placed: RegionLayout[] = [];
	let maxDepth = 0;
	// Boundaries are flush columns rather than ragged to each tree's own width:
	// a band is a region of one canvas, and a ragged right edge reads as a stack
	// of cards, which is the thing this replaced.
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
		widest = Math.max(widest, depth * COL + LABEL_W);
		placed.push({
			runId: region.runId, root: region.root, nodes, links: data.links(),
			byId: new Map(nodes.map((d) => [d.data.id, d])),
			pv: principalVariation(region.root),
			competed: isCompeted(region.root),
			visitMax: maxVisits(region.root),
			depth,
			rows: { start: rowStart, end: rowEnd },
			shiftY: 0,
			band: { x0: 0, x1: 0, y0: 0, y1: 0 },
		});
	}

	const x0 = -NODE_R_MAX - BAND_PAD;
	const x1 = Math.max(widest, COL);
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

export function ForkTree({
	regions, width = 800, height = 600, selectedRunId, selection, onSelectRun, onSelectNode,
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
	const hoverRef = useRef<{ runId: string; nodeId: string } | null>(null);
	/** Empty: a search opens with every branch showing. Folding is something the
	 *  reader DOES, never a state they are handed — see the note on the fold
	 *  control below. */
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [tooltip, setTooltip] = useState<{ x: number; y: number; node: ForkNode; competed: boolean } | null>(null);
	const mode = useTheme();

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
		const availH = height - RULER_H - FIT_PAD * 2;
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
		const ty = RULER_H + FIT_PAD - y0 * k;
		const svg = d3.select(svgRef.current);
		const to = d3.zoomIdentity.translate(tx, ty).scale(k);
		if (animate) svg.transition().duration(280).call(zoomRef.current.transform, to);
		else svg.call(zoomRef.current.transform, to);
	}, [width, height, selectedRunId]);

	const scaleBy = useCallback((factor: number) => {
		if (!svgRef.current || !zoomRef.current) return;
		d3.select(svgRef.current).transition().duration(180).call(zoomRef.current.scaleBy, factor);
	}, []);

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

		const state = layoutRegions(regions, collapsed);
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
				el.className = "absolute flex items-baseline gap-2 whitespace-nowrap";
				el.dataset.x = String(region.band.x0 + BAND_PAD);
				el.dataset.y = String(region.band.y0 + BAND_PAD);
				const name = document.createElement("span");
				name.className = `text-[11px] font-medium truncate max-w-[22rem] ${
					region.runId === selectedRunId ? "p-text" : "p-text-2"
				}`;
				name.textContent = meta?.title ?? "";
				const note = document.createElement("span");
				note.className = "text-[9px] font-mono p-text-3 truncate max-w-[18rem]";
				note.textContent = meta?.note ?? "";
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
				.attr("opacity", dim ? 0.5 : 1)
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

			// A generous invisible hit area: a 3.5px dot is not a pointer target.
			nodeG.append("circle").attr("r", ROW / 2).attr("fill", "transparent");

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
			text.filter((d) => d.data.status === "failed" || d.data.value !== null)
				.append("tspan")
				.text((d) => (d.data.status === "failed" ? "fail" : `${Math.round(Math.min(1, Math.max(0, d.data.value ?? 0)) * 100)}%`))
				.attr("font-family", "var(--font-mono)").attr("font-size", "9px")
				.attr("fill", (d) => (d.data.status === "failed" ? "var(--c-danger)" : scoreToken(d.data.value ?? 0)));
			text.append("tspan")
				.text((d) => `${d.data.status === "failed" || d.data.value !== null ? " " : ""}${truncate(cleanNodeLabel(d.data.action, "(root)"), 20)}`)
				.attr("fill", (d) => (d.data.status === "pruned" ? "var(--c-text-3)" : "var(--c-text-2)"));
			text.filter((d) => collapsed.has(foldKey(region.runId, d.data.id)))
				.append("tspan")
				.text((d) => ` +${subtreeCount(d.data)}`)
				.attr("font-family", "var(--font-mono)").attr("font-size", "9px")
				.attr("fill", "var(--c-accent-fg)");

			nodeG
				.on("mouseenter", (event: MouseEvent, d) => {
					const [x, y] = d3.pointer(event, svgRef.current);
					hoverRef.current = { runId: region.runId, nodeId: d.data.id };
					setTooltip({ x, y, node: d.data, competed: region.competed });
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
	}, [regions, width, height, collapsed, mode, selectedRunId, fit]);

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
		if (sx > 40 && sx < width - 40 && sy > RULER_H + 20 && sy < height - 20) return;
		d3.select(svgRef.current).transition().duration(320).call(
			zoomRef.current.transform,
			d3.zoomIdentity
				.translate(width / 2 - target.y * t.k, height / 2 - (target.x + region.shiftY) * t.k)
				.scale(t.k),
		);
	}, [selection, collapsed, width, height]);

	const competedSelected = stateRef.current?.regions
		.find((r) => r.runId === selectedRunId)?.competed ?? true;

	return (
		<div className="relative w-full h-full overflow-hidden">
			<svg
				ref={svgRef} width={width} height={height} className="w-full h-full block"
				style={{ touchAction: "none" }}
			/>

			{/* One title per band, pinned to its band in screen space. Populated
			    imperatively and moved from the zoom handler, so panning does not
			    round-trip through React. `top-0 left-0` because every child is
			    placed by a `translate` the handler writes. */}
			<div ref={titlesRef} aria-hidden
				className="absolute inset-0 overflow-hidden pointer-events-none select-none [&>*]:top-0 [&>*]:left-0" />

			{/* Legend and controls share one bottom row so neither can ever be
			    laid over the other on a narrow canvas. */}
			<div className="absolute inset-x-2 bottom-2 flex items-end justify-between gap-3 pointer-events-none">
				{/* The same chip as the controls opposite it. Without one the key sat
				    as bare text over whatever the tree put behind it — survivable
				    while a fitted tree left the bottom of the canvas empty, and
				    unreadable now that a fit fills the height with branches.

				    On a narrow canvas the full key wraps into a block that covers
				    the tree it explains, so only the colour scale survives. */}
				<div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-border p-surface p-shadow-menu px-2 py-1 text-[10px] p-text-3 select-none">
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
							<span>every branch fed the merge · none was ranked</span>
							{width >= 470 && (
								<span className="opacity-70">amber = running · hollow = failed</span>
							)}
						</>
					)}
				</div>
				<div className="shrink-0 pointer-events-auto flex items-center gap-0.5 rounded-md border p-border p-surface p-shadow-menu px-0.5 py-0.5">
					<TreeControl label="Fold abandoned branches" onClick={foldLosing}><ArrowsInSimpleIcon size={13} /></TreeControl>
					<TreeControl label="Expand every branch" onClick={expandAll}><ArrowsOutSimpleIcon size={13} /></TreeControl>
					<span aria-hidden className="mx-0.5 h-3.5 w-px" style={{ background: "var(--c-border)" }} />
					<TreeControl label="Zoom out" onClick={() => scaleBy(1 / 1.5)}><MagnifyingGlassMinusIcon size={13} /></TreeControl>
					<TreeControl label="Zoom in" onClick={() => scaleBy(1.5)}><MagnifyingGlassPlusIcon size={13} /></TreeControl>
					<TreeControl label="Fit the selected fork to view" onClick={() => fit(true)}><ArrowsOutIcon size={13} /></TreeControl>
				</div>
			</div>

			{tooltip && (
				<NodeTip node={tooltip.node} x={tooltip.x} y={tooltip.y} width={width} competed={tooltip.competed} />
			)}
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
	// which is installed once, so a captured height would be the first one
	// forever. The overlay is inset to the canvas, so it IS the canvas height.
	const height = overlay.clientHeight;
	for (const el of overlay.querySelectorAll<HTMLElement>(":scope > div")) {
		const x = transform.applyX(Number(el.dataset.x));
		const y = transform.applyY(Number(el.dataset.y));
		el.style.transform = `translate(${x}px,${y}px)`;
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

/** What a branch's state MEANS depends on how the fork settled: `open` is
 *  "still explorable" in a competition and "done, its findings went into the
 *  merge" in a merge. Same word in the data, two different facts. */
const STATUS_NOTE = {
	competed: {
		open: "still explorable",
		terminal: "the answer the search settled on",
		pruned: "dropped below the prune floor",
		failed: "the branch never produced a score",
		running: "still running",
	},
	merged: {
		open: "finished, its findings went into the merge",
		terminal: "finished, its findings went into the merge",
		pruned: "abandoned",
		failed: "this branch errored",
		running: "still running",
	},
} satisfies Record<"competed" | "merged", Record<ForkNode["status"], string>>;

function NodeTip(
	{ node, x, y, width, competed }:
	{ node: ForkNode; x: number; y: number; width: number; competed: boolean },
) {
	const TIP_W = 260;
	const flip = x + TIP_W + 24 > width;
	return (
		<div
			className="absolute z-50 pointer-events-none p-surface p-border border rounded-lg px-3 py-2 p-shadow-menu text-xs animate-scale-in"
			style={{ width: TIP_W, left: flip ? undefined : x + 16, right: flip ? width - x + 16 : undefined, top: y + 12 }}
		>
			<div className="font-medium p-text mb-1.5 leading-snug line-clamp-2">
				{cleanNodeLabel(node.action, "(root)")}
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
			{node.observation && (
				<div className="mt-1.5 pt-1.5 border-t p-border p-text-2 leading-relaxed line-clamp-3">
					{node.observation}
				</div>
			)}
		</div>
	);
}
