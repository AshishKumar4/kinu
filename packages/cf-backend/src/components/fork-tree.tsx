/**
 * The fork tree — every time the agent split its work, drawn as the tree it is.
 *
 * A merge (settle=merge) is this tree at depth 1: the task at the root, one
 * head per child. A competition (settle=mcts) is the same tree deeper, with
 * its branches scored against each other. One renderer, one node shape, depth
 * varying — because the alternative was two panes where the same user action
 * landed in one or the other depending on an internal strategy id.
 *
 * Laid out left→right at a CONSTANT pitch — d3's `nodeSize`, not `size`. The
 * old layout stretched the whole search to fit the panel, so a node's row got
 * thinner every time the search grew or the column got narrower; at 106 nodes
 * that is a band of overlapping dots under a smear of `n=4` badges. Here the
 * canvas is as large as the search is and the viewport moves over it: it opens
 * fitted, pans and zooms, folds branches away, and drops labels below the zoom
 * at which they would collide.
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
	NODE_R_UNSCORED, nodeRadius, principalVariation, subtreeCount, treeStats, truncate,
} from "./fork-tree-model";

interface Props {
	root: ForkNode;
	width?: number;
	height?: number;
	onNodeClick?: (node: ForkNode) => void;
	selectedNode?: ForkNode | null;
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
 * Below this zoom the NODES stop being readable too — the busiest one is
 * barely 3px and the rest are specks — so fitting the whole search buys
 * nothing. Only a canvas far taller than the tree is wide gets there (a
 * phone), and there the better read is every branch at full size with depth
 * paged sideways. Everywhere else the whole search wins, because a chopped
 * right edge of half-labels reads worse than a small clean tree.
 */
const OVERVIEW_MIN_SCALE = 0.3;
/**
 * Above this many nodes a search opens with its abandoned branches folded.
 * Fitting a hundred-plus nodes into a panel puts the whole tree below the zoom
 * at which labels are legible, so the default would be a starfield; folding
 * the branches the search itself gave up on buys back exactly the room the
 * text needs. Nothing is hidden silently — each fold keeps a dashed halo and
 * a `+N`, and one control in the corner opens them all.
 */
const AUTO_FOLD_NODES = 40;
const RULER_H = 20;
const FIT_PAD = 16;

function initialFold(root: ForkNode): Set<string> {
	return treeStats(root).nodes > AUTO_FOLD_NODES ? losingBranchIds(root) : new Set<string>();
}

type PointNode = d3.HierarchyPointNode<ForkNode>;

interface RenderState {
	pv: Set<string>;
	/** Whether this fork ranked its branches — gates every score/rollout
	 *  encoding, so a merge is never drawn as if it had picked a winner. */
	competed: boolean;
	visitMax: number;
	byId: Map<string, PointNode>;
	extent: { x0: number; x1: number; y0: number; y1: number };
	depth: number;
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
 */
function applyEmphasis(
	g: d3.Selection<SVGGElement, unknown, null, undefined>,
	state: RenderState,
	selectedId: string | null,
	hoverId: string | null,
): void {
	const hovered = hoverId ? state.byId.get(hoverId) : undefined;
	const onPath = new Set(hovered ? hovered.ancestors().map((d) => d.data.id) : []);
	const lit = (id: string) => state.pv.has(id) || onPath.has(id);

	g.selectAll<SVGPathElement, d3.HierarchyPointLink<ForkNode>>("path.mcts-link")
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
			const w = state.competed ? linkWidth(d.target.data.visits, state.visitMax) : 1.2;
			return lit(d.target.data.id) ? Math.max(2, w) : w;
		});

	const nodes = g.selectAll<SVGGElement, PointNode>("g.mcts-node");
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
	g.selectAll<SVGGElement, PointNode>("g.mcts-label")
		.attr("data-pinned", (d) => (selectedId === d.data.id || hoverId === d.data.id ? "" : null));
}

export function ForkTree({ root, width = 800, height = 600, onNodeClick, selectedNode }: Props) {
	const svgRef = useRef<SVGSVGElement>(null);
	const gRef = useRef<SVGGElement | null>(null);
	const rulerRef = useRef<SVGGElement | null>(null);
	const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
	const stateRef = useRef<RenderState | null>(null);
	/** Until the reader pans or zooms, the view stays fitted — through resizes
	 *  and through a search that is still growing. After that the transform is
	 *  theirs and only an explicit control or a new search may move it. */
	const userMoved = useRef(false);
	/** Set by the fold-all controls: those refit, a single node toggle does not
	 *  (it would yank the tree out from under the branch just opened). */
	const refitNext = useRef(false);
	const onNodeClickRef = useRef(onNodeClick);
	onNodeClickRef.current = onNodeClick;
	const selectedIdRef = useRef<string | null>(selectedNode?.id ?? null);
	const hoverIdRef = useRef<string | null>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => initialFold(root));
	const foldedFor = useRef(root.id);
	const [tooltip, setTooltip] = useState<{ x: number; y: number; node: ForkNode } | null>(null);
	const competedRoot = isCompeted(root);
	const mode = useTheme();

	const fit = useCallback(() => {
		const state = stateRef.current;
		if (!svgRef.current || !zoomRef.current || !state) return;
		const { x0, x1, y0, y1 } = state.extent;
		const w = Math.max(1, x1 - x0);
		const h = Math.max(1, y1 - y0);
		const availW = width - FIT_PAD * 2;
		const availH = height - RULER_H - FIT_PAD * 2;
		// Never magnify past 1:1 — a three-node search should not fill the wall.
		const cap = (k: number) => Math.max(0.05, Math.min(1, k));
		const both = cap(Math.min(availW / w, availH / h));
		const rows = cap(availH / h);
		// Showing the whole search wins, right down to the scale where the
		// picture stops being one.
		const k = both >= OVERVIEW_MIN_SCALE ? both : Math.max(both, rows);
		const tx = k === both ? (width - w * k) / 2 - x0 * k : FIT_PAD - x0 * k;
		const ty = RULER_H + (height - RULER_H - h * k) / 2 - y0 * k;
		d3.select(svgRef.current).transition().duration(280)
			.call(zoomRef.current.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
	}, [width, height]);

	const scaleBy = useCallback((factor: number) => {
		if (!svgRef.current || !zoomRef.current) return;
		d3.select(svgRef.current).transition().duration(180).call(zoomRef.current.scaleBy, factor);
	}, []);

	const foldLosing = useCallback(() => {
		refitNext.current = true;
		setCollapsed(losingBranchIds(root));
	}, [root]);

	const expandAll = useCallback(() => {
		refitNext.current = true;
		setCollapsed(new Set());
	}, []);

	useEffect(() => {
		if (foldedFor.current === root.id) return;
		foldedFor.current = root.id;
		userMoved.current = false;
		refitNext.current = true;
		setCollapsed(initialFold(root));
	}, [root]);

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
				g.select("g.mcts-labels").attr("data-lod", event.transform.k >= LABEL_MIN_SCALE ? "" : null);
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

	// Data render — rebuilds the guide/link/node/label layers inside the
	// persistent zoom layer when the tree, the fold set, the viewport or the
	// palette actually changes. The hook upstream only swaps `root` identity
	// when the row set changed, so steady-state polls never reach here.
	useEffect(() => {
		const g = d3.select(gRef.current!);
		g.selectAll("*").remove();

		const hierarchy = d3.hierarchy(root, (d) => (collapsed.has(d.id) ? [] : d.children));
		const layout = d3.tree<ForkNode>().nodeSize([ROW, COL])
			.separation((a, b) => (a.parent === b.parent ? 1 : 1.6));
		const data = layout(hierarchy);
		const nodes = data.descendants();
		const ramp = scoreRamp();
		const visitMax = maxVisits(root);
		const competed = isCompeted(root);
		const radiusOf = (node: ForkNode) => (competed ? nodeRadius(node.visits, visitMax) : NODE_R_UNSCORED);
		const pv = principalVariation(root);
		const depth = d3.max(nodes, (d) => d.depth) ?? 0;
		const rowSpan = d3.extent(nodes, (d) => d.x) as [number, number];
		const state: RenderState = {
			pv, competed, visitMax, depth,
			byId: new Map(nodes.map((d) => [d.data.id, d])),
			// Screen axes are swapped: depth runs along x, rows down y.
			extent: { x0: -NODE_R_MAX, x1: depth * COL + LABEL_W, y0: rowSpan[0] - ROW, y1: rowSpan[1] + ROW },
		};
		stateRef.current = state;

		// Depth guides — the columns the ruler labels.
		g.append("g").attr("class", "mcts-guides")
			.selectAll("line")
			.data(d3.range(depth + 1))
			.join("line")
			.attr("x1", (d) => d * COL).attr("x2", (d) => d * COL)
			.attr("y1", rowSpan[0] - ROW).attr("y2", rowSpan[1] + ROW)
			.attr("stroke", "var(--c-border)").attr("stroke-width", 1);

		g.append("g").attr("class", "mcts-links").attr("fill", "none")
			.attr("pointer-events", "none")
			.selectAll("path")
			.data(data.links())
			.join("path")
			.attr("class", "mcts-link")
			.attr("stroke-linecap", "round")
			.attr("stroke-dasharray", (d) => (d.target.data.status === "pruned" ? "3,4" : null))
			.attr("d", d3.linkHorizontal<d3.HierarchyPointLink<ForkNode>, PointNode>()
				.x((d) => d.y).y((d) => d.x));

		const nodeG = g.append("g").attr("class", "mcts-nodes")
			.selectAll("g")
			.data(nodes)
			.join("g")
			.attr("class", "mcts-node")
			.attr("transform", (d) => `translate(${d.y},${d.x})`)
			.style("cursor", "pointer");

		// A collapsed node keeps a dashed halo at every zoom — folded-away work
		// must never look like work that was never done.
		nodeG.filter((d) => collapsed.has(d.data.id))
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
		const labels = g.append("g").attr("class", "mcts-labels").attr("pointer-events", "none")
			.selectAll("g")
			.data(nodes)
			.join("g")
			.attr("class", "mcts-label")
			.attr("transform", (d) => `translate(${d.y},${d.x})`);

		const foldable = labels.filter((d) => d.data.children.length > 0);
		const handle = foldable.append("g")
			.attr("class", "mcts-handle")
			.attr("transform", `translate(${HANDLE_X},0)`)
			.attr("pointer-events", "all")
			.attr("opacity", (d) => (collapsed.has(d.data.id) ? 1 : 0.5))
			.style("cursor", "pointer")
			.on("click", (event: MouseEvent, d) => {
				event.stopPropagation();
				setCollapsed((prev) => {
					const next = new Set(prev);
					if (!next.delete(d.data.id)) next.add(d.data.id);
					return next;
				});
			});
		handle.append("circle").attr("r", 5.5)
			.attr("fill", "var(--c-surface)").attr("stroke", "var(--c-border)").attr("stroke-width", 1);
		handle.append("text")
			.text((d) => (collapsed.has(d.data.id) ? "+" : "−"))
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
		text.filter((d) => collapsed.has(d.data.id))
			.append("tspan")
			.text((d) => ` +${subtreeCount(d.data)}`)
			.attr("font-family", "var(--font-mono)").attr("font-size", "9px")
			.attr("fill", "var(--c-accent-fg)");

		nodeG
			.on("mouseenter", (event: MouseEvent, d) => {
				const [x, y] = d3.pointer(event, svgRef.current);
				hoverIdRef.current = d.data.id;
				setTooltip({ x, y, node: d.data });
				applyEmphasis(g, state, selectedIdRef.current, hoverIdRef.current);
			})
			.on("mouseleave", () => {
				hoverIdRef.current = null;
				setTooltip(null);
				applyEmphasis(g, state, selectedIdRef.current, null);
			})
			.on("click", (_event: MouseEvent, d) => onNodeClickRef.current?.(d.data));

		applyEmphasis(g, state, selectedIdRef.current, hoverIdRef.current);

		const transform = d3.zoomTransform(svgRef.current!);
		if (refitNext.current || !userMoved.current) {
			refitNext.current = false;
			fit();
		} else {
			g.select("g.mcts-labels").attr("data-lod", transform.k >= LABEL_MIN_SCALE ? "" : null);
			positionRuler(d3.select(rulerRef.current!), state, transform);
		}
	}, [root, width, height, collapsed, mode, fit]);

	// Selection is an attribute update, plus the two things that make a node
	// chosen from the inspector actually appear: open the folds hiding it, then
	// bring it into view. Without either, clicking a row of the search path is
	// a no-op whenever the node is off the current pan or inside a fold.
	useEffect(() => {
		selectedIdRef.current = selectedNode?.id ?? null;
		const state = stateRef.current;
		if (!gRef.current || !state) return;
		applyEmphasis(d3.select(gRef.current), state, selectedIdRef.current, hoverIdRef.current);
		if (!selectedNode || !svgRef.current || !zoomRef.current) return;
		const target = state.byId.get(selectedNode.id);
		if (!target) {
			const hidden = ancestorIds(root, selectedNode.id).filter((id) => collapsed.has(id));
			if (hidden.length > 0) {
				setCollapsed((prev) => {
					const next = new Set(prev);
					for (const id of hidden) next.delete(id);
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
		const [sx, sy] = [t.applyX(target.y), t.applyY(target.x)];
		if (sx > 40 && sx < width - 40 && sy > RULER_H + 20 && sy < height - 20) return;
		d3.select(svgRef.current).transition().duration(320).call(
			zoomRef.current.transform,
			d3.zoomIdentity.translate(width / 2 - target.y * t.k, height / 2 - target.x * t.k).scale(t.k),
		);
	}, [selectedNode, root, collapsed, width, height]);

	return (
		<div className="relative w-full h-full overflow-hidden">
			<svg
				ref={svgRef} width={width} height={height} className="w-full h-full block"
				style={{ touchAction: "none" }}
			/>

			{/* Legend and controls share one bottom row so neither can ever be
			    laid over the other on a narrow canvas. */}
			<div className="absolute inset-x-2 bottom-2 flex items-end justify-between gap-3 pointer-events-none">
				{/* On a narrow canvas the full key wraps into a block that covers
				    the tree it explains, so only the colour scale survives. */}
				<div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] p-text-3 select-none">
					{competedRoot ? (
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
					<TreeControl label="Fit to view" onClick={fit}><ArrowsOutIcon size={13} /></TreeControl>
				</div>
			</div>

			{tooltip && <NodeTip node={tooltip.node} x={tooltip.x} y={tooltip.y} width={width} competed={competedRoot} />}
		</div>
	);
}

function TreeControl({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button" onClick={onClick} title={label} aria-label={label}
			className="p-btn-ghost inline-flex size-6 items-center justify-center rounded"
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
const STATUS_NOTE: Record<"competed" | "merged", Record<string, string>> = {
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
};

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
