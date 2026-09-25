/**
 * Every search the workspace has run, as bands of one canvas under a shared pan/zoom.
 * Laid out left→right at constant pitch (`nodeSize`): depth is bounded, breadth is not.
 */
import { useRef, useEffect, useState, useCallback } from "react";
import * as d3 from "d3";
import {
	ArrowsOutIcon, MagnifyingGlassPlusIcon, MagnifyingGlassMinusIcon,
	ArrowsInSimpleIcon, ArrowsOutSimpleIcon,
} from "@phosphor-icons/react";
import { useTheme } from "@/hooks/use-theme";
import { useElementSize } from "@/hooks/use-element-size";
import type { ForkNode } from "@kinu.run/core";
import {
	ancestorIds, cleanNodeLabel, clipToWidth, isCompeted, LABEL_MIN_SCALE, linkWidth, losingBranchIds, maxVisits,
	NODE_R_MAX, NODE_R_UNSCORED, nodeRadius, principalVariation, subtreeCount, viewNoteFor,
	type ExplorerSelection,
} from "@kinu.run/core";
import { scoreBand } from '@kinu.run/core';

export interface SwarmTreeRegion {
	runId: string;
	root: ForkNode;
	title: string;
	/** Required: the root node is labelled with it. */
	name: string;
	note: string;
	/** Fan-in vertices: node id → parents consumed. `search_nodes` records only the
	 *  selection parent, so the tree alone cannot show which node fanned a level in. */
	fanIn?: ReadonlyMap<string, number>;
	why?: ReadonlyMap<string, string>;
}

interface Props {
	/** Must be referentially stable: the render effect keys on it. */
	regions: readonly SwarmTreeRegion[];
	width?: number;
	height?: number;
	selectedRunId: string | null;
	selection: ExplorerSelection | null;
	onSelectRun?: (runId: string) => void;
	onSelectNode?: (selection: ExplorerSelection) => void;
	/** Per-node journal write counters. Kept out of `regions`: a per-step identity
	 *  change would rebuild the whole scene. */
	activity?: ReadonlyMap<string, number>;
}

/** Row pitch: one text line plus air, so labels cannot collide. */
const ROW = 22;

const COL = 206;

const HANDLE_X = NODE_R_MAX + 8;

const LABEL_X = NODE_R_MAX + 22;

const LABEL_GAP = 8;

/** Label room in scene units. `LEAF` is a reading bound, not a collision one: every leaf owns its row. */
const LABEL_ROOM_INNER = COL - LABEL_X - LABEL_GAP;

const LABEL_ROOM_LEAF = COL * 2 - LABEL_X - LABEL_GAP;

/** Minimum fit zoom; taller searches open at this scale and are read by panning. */
const OVERVIEW_MIN_SCALE = 0.3;

const RULER_H = 20;

const FIT_PAD = 16;

/** Height reserved for the docked legend/control row; measured once on screen. */
const LEGEND_H = 30;

const BAND_PAD = 10;

const BAND_TITLE_H = 26;

/** Working-mark timeout after the last journal write; a node never announces it stopped. */
const WORKING_MS = 2_500;

const BAND_GAP = 6;

type PointNode = d3.HierarchyPointNode<ForkNode>;

/** Fold keys are per node per search: node ids are unique only inside a search. */
function foldKey(runId: string, nodeId: string): string {
	return `${runId}\u0000${nodeId}`;
}

/** Shared empty map so polls don't allocate one per band. */
const EMPTY_NODE_MAP: ReadonlyMap<string, number> = new Map();

const EMPTY_TEXT_MAP: ReadonlyMap<string, string> = new Map();

const NO_FOLDS: ReadonlySet<string> = new Set<string>();

/** Label face widths, measured on a canvas context: `getComputedTextLength` costs a layout per call. */
interface LabelFont {
	name: (text: string) => number;
	badge: (text: string) => number;
}

/** Cached for the document lifetime: the faces live on `:root` and don't change with the palette. */
let fontCache: LabelFont | null = null;

function labelFont(): LabelFont {
	if (fontCache !== null) return fontCache;
	const cs = getComputedStyle(document.documentElement);
	const mono = cs.getPropertyValue("--font-mono").trim() || "monospace";
	const body = getComputedStyle(document.body).fontFamily || "sans-serif";
	const ctx = document.createElement("canvas").getContext("2d");

	if (ctx === null) {
		// No 2d context (headless): fall back to a mean advance, clipping conservatively.
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

/** Label tspans clipped at layout time: the scene's right edge is where the widest ends. */
interface NodeLabel {
	/** `47%` or `fail`, or empty for a branch no fork ranked. */
	readonly score: string;
	readonly name: string;
	/** `+12` for a fold, `⋈3` for a fan-in vertex, or both. */
	readonly badge: string;
	readonly end: number;
}

interface NodeLabelPlacement {
	readonly node: PointNode;
	readonly region: SwarmTreeRegion;
	readonly collapsed: ReadonlySet<string>;
	readonly fanIn: ReadonlyMap<string, number>;
	readonly font: LabelFont;
}

function nodeScore(node: ForkNode): string {
	if (node.status === "failed") return "failed";

	if (node.value === null) return "";

	return `${Math.round(Math.min(1, Math.max(0, node.value)) * 100)}%`;
}

/** The score and badges are never clipped; only the name gives. */
function nodeLabel(placement: NodeLabelPlacement): NodeLabel {
	const { node, region, collapsed, fanIn, font } = placement;
	const folded = collapsed.has(foldKey(region.runId, node.data.id));
	const score = nodeScore(node.data);
	const fold = folded ? ` +${subtreeCount(node.data)}` : "";
	const join = fanIn.has(node.data.id) ? ` ⋈${fanIn.get(node.data.id) ?? 0}` : "";
	const badge = `${fold}${join}`;
	// A folded node's row is clear to the right, so it gets a leaf's room.
	const room = node.data.children.length === 0 || folded ? LABEL_ROOM_LEAF : LABEL_ROOM_INNER;
	const spend = font.badge(score) + font.badge(badge);

	const name = clipToWidth(
		`${score === "" ? "" : " "}${cleanNodeLabel(node.data.action, region.name)}`,
		room - spend, font.name,
	);

	return { score, name, badge, end: LABEL_X + spend + font.name(name) };
}

interface RegionLayout {
	runId: string;
	root: ForkNode;
	nodes: PointNode[];
	links: d3.HierarchyPointLink<ForkNode>[];
	byId: Map<string, PointNode>;
	pv: Set<string>;
	/** Gates every score/rollout encoding, so a merge never looks like it picked a winner. */
	competed: boolean;
	visitMax: number;
	depth: number;
	fanIn: ReadonlyMap<string, number>;
	why: ReadonlyMap<string, string>;
	name: string;
	labels: Map<string, NodeLabel>;
	rows: { start: number; end: number };
	shiftY: number;
	band: { x0: number; x1: number; y0: number; y1: number };
}

interface RenderState {
	regions: RegionLayout[];
	depth: number;
	extent: { x0: number; x1: number; y0: number; y1: number };
}

/** Pure: all scene geometry in one place so fit, draw and hit-test agree. */
function layoutRegions(
	regions: readonly SwarmTreeRegion[],
	collapsed: ReadonlySet<string>,
	font: LabelFont,
): RenderState {
	const layout = d3.tree<ForkNode>().nodeSize([ROW, COL])
		.separation((a, b) => (a.parent === b.parent ? 1 : 1.6));

	const placed: RegionLayout[] = [];
	let maxDepth = 0;
	// Band right edges are flush and end where the widest label ends.
	let widest = 0;

	for (const region of regions) {
		const hierarchy = d3.hierarchy(region.root, (d) => (
			collapsed.has(foldKey(region.runId, d.id)) ? [] : d.children
		));

		const data = layout(hierarchy);
		const nodes = data.descendants();

		// The store owns every non-root column. D3 owns rows and links; the root is d0.
		for (const node of nodes) node.y = (node.parent === null ? 0 : node.data.depth) * COL;
		const depth = d3.max(nodes, (node) => (node.parent === null ? 0 : node.data.depth)) ?? 0;
		const [rowStart, rowEnd] = d3.extent(nodes, (d) => d.x);

		if (rowStart === undefined || rowEnd === undefined) continue;
		maxDepth = Math.max(maxDepth, depth);
		const fanIn = region.fanIn ?? EMPTY_NODE_MAP;
		const labels = new Map<string, NodeLabel>();

		for (const node of nodes) {
			const label = nodeLabel({ node, region, collapsed, fanIn, font });
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

/** Height at 1:1, fully expanded; the host caps the canvas at this. */
export function naturalCanvasHeight(regions: readonly SwarmTreeRegion[]): number {
	const { extent } = layoutRegions(regions, NO_FOLDS, labelFont());

	return RULER_H + FIT_PAD * 2 + (extent.y1 - extent.y0) + LEGEND_H;
}

/** Score fill on the product's danger→warning→success ramp, interpolated in Lab. */
function scoreRamp(): (t: number) => string {
	const cs = getComputedStyle(document.documentElement);
	const tok = (name: string) => cs.getPropertyValue(name).trim();

	return d3.piecewise(d3.interpolateLab, [tok("--c-danger"), tok("--c-warning"), tok("--c-success")]);
}

const BAND_TOKEN = {
	success: "var(--c-success)",
	warning: "var(--c-warning)",
	danger: "var(--c-danger)",
} as const;

function nodeFill(node: ForkNode, ramp: (t: number) => string): string {
	// Failed: hollow, not coloured by an unearned zero.
	if (node.status === "failed") return "var(--c-surface)";

	// Working uses the accent; in light mode `--c-warning` is nearly `--c-text-3`.
	if (node.status === "running") return "var(--c-accent)";

	// Unscored: neutral, not a ramp position.
	if (node.value === null) return "var(--c-border-strong)";

	return ramp(Math.min(1, Math.max(0, node.value)));
}

/** Attribute-only update (no layer rebuild), scoped to one band. */
function applyEmphasis(
	group: d3.Selection<SVGGElement, unknown, null, undefined>,
	region: RegionLayout,
	selectedId: string | null,
	hoverId: string | null,
): void {
	const hovered = hoverId ? region.byId.get(hoverId) : undefined;
	const onPath = new Set(hovered ? hovered.ancestors().map((d) => d.data.id) : []);
	const lit = (id: string) => region.pv.has(id) || onPath.has(id);

	const linkTone = <T,>(onLit: T, status: ForkNode["status"], onStatus: T, rest: T) =>
		(d: d3.HierarchyPointLink<ForkNode>): T => {
			if (lit(d.target.data.id)) return onLit;

			return d.target.data.status === status ? onStatus : rest;
		};

	group.selectAll<SVGPathElement, d3.HierarchyPointLink<ForkNode>>("path.mcts-link")
		.attr("stroke", linkTone("var(--c-accent)", "failed", "var(--c-danger)", "var(--c-border-strong)"))
		.attr("stroke-opacity", linkTone(0.95, "pruned", 0.4, 0.6))
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
		.attr("stroke-width", (d) => {
			if (selectedId === d.data.id) return 2.5;

			if (d.data.status === "terminal") return 2;

			return 1.4;
		})
		.attr("opacity", (d) => {
			if (selectedId === d.data.id || onPath.has(d.data.id)) return 1;

			if (d.data.status === "pruned") return 0.45;

			return 1;
		})
		.attr("filter", (d) => {
			if (selectedId === d.data.id) return "url(#mctsSelectGlow)";

			if (d.data.status === "terminal") return "url(#mctsGlow)";

			return null;
		});

	// A label the reader asked for outranks the zoom rule that hides the rest.
	group.selectAll<SVGGElement, PointNode>("g.mcts-label")
		.attr("data-pinned", (d) => (selectedId === d.data.id || hoverId === d.data.id ? "" : null));
}

const NO_WORKING: ReadonlySet<string> = new Set<string>();

/** Attribute-only update: called per journal write, so it must not rebuild layers. */
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
	const titlesRef = useRef<HTMLDivElement>(null);
	const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
	const stateRef = useRef<RenderState | null>(null);
	/** Until the reader pans or zooms, the view stays fitted through resizes and growth. */
	const userMoved = useRef(false);
	/** Pending refit; `animate` only for an explicit control. A node toggle sets neither. */
	const refit = useRef<"no" | "instant" | "animate">("no");
	const onSelectRunRef = useRef(onSelectRun);
	onSelectRunRef.current = onSelectRun;
	const onSelectNodeRef = useRef(onSelectNode);
	onSelectNodeRef.current = onSelectNode;
	const selectionRef = useRef<ExplorerSelection | null>(selection);
	/** React state that flips only at thresholds, so panning never re-renders the tree. */
	const [viewNote, setViewNote] = useState<string | null>(null);
	const selectedRunRef = useRef(selectedRunId);
	selectedRunRef.current = selectedRunId;
	const widthRef = useRef(width);
	widthRef.current = width;
	const hoverRef = useRef<{ runId: string; nodeId: string } | null>(null);
	/** Empty: folding is a reader action, never a default. */
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);
	/** Redraw on theme change: the score ramp interpolates resolved token values. */
	const theme = useTheme();
	/** Measured: the legend row wraps on narrow canvases. */
	const { attach: attachLegend, size: legend } = useElementSize();
	const sceneH = Math.max(0, height - (legend.h > 0 ? legend.h : LEGEND_H));

	/** Fit the selected search. Unrequested fits don't animate: rAF is throttled in background tabs. */
	const fit = useCallback((animate: boolean) => {
		const state = stateRef.current;

		if (!svgRef.current || !zoomRef.current || !state || state.regions.length === 0) return;
		const target = state.regions.find((r) => r.runId === selectedRunId) ?? state.regions[0];
		const { x0, x1, y0, y1 } = target.band;
		const w = Math.max(1, x1 - x0);
		const h = Math.max(1, y1 - y0);
		const availW = width - FIT_PAD * 2;
		const availH = sceneH - RULER_H - FIT_PAD * 2;
		// Fit rows, not the bounding box: depth pans, rows scrolled off hide branches.
		// Capped at 1:1, floored at the legibility minimum.
		const k = Math.min(1, Math.max(OVERVIEW_MIN_SCALE, availH / h));
		// Centre horizontally only what fits; otherwise anchor left so the root stays on screen.
		const tx = w * k <= availW ? (width - w * k) / 2 - x0 * k : FIT_PAD - x0 * k;
		// Vertically top-anchored, never centred: centring pushes the following bands off.
		// Anchored on the scene when every band fits, else on the band.
		const scene = state.extent;
		const fitsWhole = (scene.y1 - scene.y0) * k <= availH;
		const ty = RULER_H + FIT_PAD - (fitsWhole ? scene.y0 : y0) * k;
		const svg = d3.select(svgRef.current);
		const to = d3.zoomIdentity.translate(tx, ty).scale(k);
		const zoom = zoomRef.current;

		if (animate) zoom.transform(svg.transition().duration(280), to);
		else zoom.transform(svg, to);
	}, [width, sceneH, selectedRunId]);

	/** Zoom about the canvas centre via `zoom.transform` (`zoom.scaleBy` schedules nothing).
	 *  Sets `userMoved` so the next poll does not refit. */
	const scaleBy = useCallback((factor: number) => {
		const svgEl = svgRef.current;
		const zoom = zoomRef.current;

		if (!svgEl || !zoom) return;
		const from = d3.zoomTransform(svgEl);
		const [minK, maxK] = zoom.scaleExtent();
		const k = Math.min(maxK, Math.max(minK, from.k * factor));

		if (k === from.k) return;
		const [cx, cy] = [width / 2, sceneH / 2];

		const to = d3.zoomIdentity
			.translate(cx - (cx - from.x) * (k / from.k), cy - (cy - from.y) * (k / from.k))
			.scale(k);

		userMoved.current = true;
		zoom.transform(d3.select(svgEl).transition().duration(180), to);
	}, [width, sceneH]);

	/** Fold every abandoned branch. A control, never a default: settling retires every open node. */
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

	/** Refit on a new run-id set or selection. Keyed on ids, not `regions` identity:
	 *  every poll yields fresh objects. */
	const fittedFor = useRef("");
	useEffect(() => {
		const key = `${selectedRunId}\u0000${regions.map((region) => region.runId).join("\u0001")}`;

		if (fittedFor.current === key) return;
		fittedFor.current = key;
		userMoved.current = false;
		refit.current = "instant";
	}, [regions, selectedRunId]);

	// One-time scaffold. Data updates never reset the zoom transform, so polls cannot snap a pan back.
	useEffect(() => {
		const svgEl = svgRef.current;

		if (svgEl === null) return;
		const svg = d3.select(svgEl);
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

	// Data render. `regions` roots change identity only when rows change, so steady polls skip this.
	useEffect(() => {
		const rootGroup = gRef.current;
		const svgEl = svgRef.current;

		if (rootGroup === null || svgEl === null) return;
		const g = d3.select(rootGroup);
		g.selectAll("*").remove();

		const state = layoutRegions(regions, collapsed, labelFont());
		stateRef.current = state;
		const ramp = scoreRamp();
		const titles = new Map(regions.map((r) => [r.runId, r]));

		// Bands first, so each tree paints over its own boundary.
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
		// Titles are HTML overlays so type stays 11px at any zoom.
		const overlay = titlesRef.current;

		if (overlay) {
			overlay.replaceChildren(...state.regions.map((region) => {
				const meta = titles.get(region.runId);
				const el = document.createElement("div");
				el.className = "absolute flex min-w-0 items-baseline gap-2 whitespace-nowrap";
				el.dataset.bandTitle = region.runId;
				el.dataset.x = String(region.band.x0 + BAND_PAD);
				el.dataset.y = String(region.band.y0 + BAND_PAD);
				// Band right edge carried as data: clamping runs later from the zoom handler.
				el.dataset.x1 = String(region.band.x1 - BAND_PAD);
				const name = document.createElement("span");
				name.className = `min-w-0 shrink truncate p-row-text font-medium ${
					region.runId === selectedRunId ? "p-text" : "p-text-2"
				}`;
				name.textContent = meta?.title ?? "";
				// Bands have no tooltip; the title carries the untruncated task.
				name.title = meta?.title ?? "";
				const note = document.createElement("span");
				// The note shrinks faster: the name identifies the band.
				note.className = "min-w-0 shrink-[4] truncate p-annotation p-text-3";
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
				// 0.72, not 0.5: at 0.5 the unselected 11px labels drop below text contrast.
				.attr("opacity", dim ? 0.72 : 1)
				.attr("transform", `translate(0,${region.shiftY})`);

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

			// Folded nodes keep a dashed halo at every zoom.
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

			// Fan-in vertex: a square silhouette only; fill and radius stay a sibling's (same scoring body).
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

			// Invisible hit area; also the working pulse's ring.
			nodeG.append("circle").attr("class", "mcts-halo")
				.attr("r", ROW / 2).attr("fill", "transparent");

			// Labels overlap the next column, so only the fold handle takes pointer events.
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

			// Knockout halo so labels crossing links stay legible.
			const text = labels.append("text")
				.attr("x", LABEL_X).attr("dy", "0.33em").attr("font-size", "11px")
				.attr("paint-order", "stroke")
				.attr("stroke", "var(--c-surface)").attr("stroke-width", 3).attr("stroke-linejoin", "round");

			// Score first; an unscored branch gets no tspan. Every part comes from the layout's clip.
			const labelOf = (d: PointNode) => region.labels.get(d.data.id);
			text.filter((d) => (labelOf(d)?.score ?? "") !== "")
				.append("tspan")
				.text((d) => labelOf(d)?.score ?? "")
				.attr("font-family", "var(--font-mono)").attr("font-size", "9px")
				.attr("fill", (d) => (d.data.status === "failed" ? "var(--c-danger)" : BAND_TOKEN[scoreBand(d.data.value ?? 0)]));
			text.append("tspan")
				.text((d) => labelOf(d)?.name ?? "")
				.attr("fill", (d) => (d.data.status === "pruned" ? "var(--c-text-3)" : "var(--c-text-2)"));
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
						x, y, node: d.data,
						column: Math.round(d.y / COL),
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

		// The rebuild dropped the working marks; restore them.
		applyWorking(rootGroup, workingRef.current);

		const transform = d3.zoomTransform(svgEl);
		// Place titles for the current transform; `fit`'s transition moves them afterwards.
		positionBandTitles(titlesRef.current, transform);

		if (refit.current !== "no" || !userMoved.current) {
			const animate = refit.current === "animate";
			refit.current = "no";
			fit(animate);
		} else {
			g.selectAll("g.mcts-labels").attr("data-lod", transform.k >= LABEL_MIN_SCALE ? "" : null);
			const ruler = rulerRef.current;

			if (ruler !== null) positionRuler(d3.select(ruler), state, transform);
		}
	}, [regions, width, sceneH, collapsed, theme, selectedRunId, fit]);

	// Selecting from the inspector opens folds hiding the node, then brings it into view.
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
			// Fold keys are per search here: the fold set spans every band.
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

		// A fitted view shows every node, and `fit` is a transition: checking now reads the pre-fit transform.
		if (!userMoved.current) return;
		const t = d3.zoomTransform(svgRef.current);
		const [sx, sy] = [t.applyX(target.y), t.applyY(target.x + region.shiftY)];

		if (sx > 40 && sx < width - 40 && sy > RULER_H + 20 && sy < sceneH - 20) return;
		zoomRef.current.transform(
			d3.select(svgRef.current).transition().duration(320),
			d3.zoomIdentity
				.translate(width / 2 - target.y * t.k, sceneH / 2 - (target.x + region.shiftY) * t.k)
				.scale(t.k),
		);
	}, [selection, collapsed, width, sceneH]);

	/**
	 * Working marks by recency (last {@link WORKING_MS}), not a remembered delta: StrictMode
	 * runs effects twice. Attribute-only, never a layer rebuild.
	 */
	const movedAt = useRef(new Map<string, number>());
	const lastCount = useRef(new Map<string, number>());
	const workingRef = useRef<ReadonlySet<string>>(NO_WORKING);
	const workingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	/** Self-scheduling: re-runs when the next mark expires. */
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
	/** Show the fan-in key only when the selected search has one. */
	const fansInSelected = (selectedRegion?.fanIn.size ?? 0) > 0;

	return (
		<div className="relative flex w-full h-full flex-col overflow-hidden">
			<div className="relative shrink-0" style={{ height: sceneH }}>
				<svg
					ref={svgRef} width={width} height={sceneH} className="w-full h-full block"
					style={{ touchAction: "none" }}
				/>

				<div ref={titlesRef} aria-hidden
					className="absolute inset-0 overflow-hidden pointer-events-none select-none [&>*]:top-0 [&>*]:left-0" />

				{/* Overlay, not in flow: an in-flow line changes scene height, refits, and could toggle itself. */}
				{viewNote !== null && (
					<div aria-live="polite"
					className="absolute left-0 right-0 flex justify-end pr-4 pointer-events-none select-none p-meta p-text-3"
						style={{ top: RULER_H, fontFamily: "var(--font-mono)" }}
					>{viewNote}</div>
				)}

				{tooltip && <NodeTip tip={tooltip} width={width} />}
			</div>

			<div ref={attachLegend} data-tree-legend
				className="shrink-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 pt-1 pb-1.5">
				<div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 p-meta p-text-3 select-none">
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
						<>
							<span className="min-w-0">every branch fed the settle · none was ranked</span>
							{width >= 470 && (
								<span className="opacity-70">brass = running · hollow = failed</span>
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

function selectedNodeIn(selection: ExplorerSelection | null, runId: string): string | null {
	return selection && selection.runId === runId ? selection.nodeId : null;
}

/** Pins band titles in screen space from the zoom handler. Off-top titles are hidden, not clamped. */
function positionBandTitles(
	overlay: HTMLDivElement | null,
	transform: d3.ZoomTransform,
): void {
	if (!overlay) return;
	// Measured per call: the handler is installed once, so a captured size would go stale.
	const { clientHeight: height, clientWidth: width } = overlay;

	for (const el of overlay.querySelectorAll<HTMLElement>(":scope > div")) {
		const x = transform.applyX(Number(el.dataset.x));
		const y = transform.applyY(Number(el.dataset.y));
		// Clamped left only: a band spans the full width, so the caption still names its own band.
		const left = Math.max(BAND_PAD, x);
		el.style.transform = `translate(${left}px,${y}px)`;
		// Room is bounded by both the caption's own band and the canvas.
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

interface TooltipState {
	readonly x: number;
	readonly y: number;
	readonly node: ForkNode;
	readonly column: number;
	readonly fanIn: number | null;
	readonly why: string | null;
	readonly runName: string;
}

function NodeTip({ tip, width }: { tip: TooltipState; width: number }) {
	const { node, fanIn, why, runName } = tip;
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
						style={{ color: node.status === "failed" ? "var(--c-danger)" : BAND_TOKEN[scoreBand(node.value ?? 0)] }}
					>
						{node.status === "failed" ? "failed" : `${Math.round(Math.min(1, Math.max(0, node.value ?? 0)) * 100)}%`}
					</span>
				)}
				{node.visits !== null && (
					<span className="p-text-3">{node.visits} rollout{node.visits === 1 ? "" : "s"}</span>
				)}
				{/* The placed column (matches the ruler), not the row's depth: an elected orphan root sits at column 0. */}
				<span className="p-text-3">depth {tip.column}</span>
			</div>
			<div className="p-text-3 mt-1">
				{/* The store's own status word; `status` collapses four endings into `failed`. */}
				{node.lifecycle ?? node.status}
			</div>
			{fanIn !== null && (
				<div className="mt-1.5 flex items-baseline gap-1.5 p-accent-fg">
					<span className="p-annotation">⋈{fanIn}</span>
					<span className="leading-snug">
						fan-in vertex, aggregating {fanIn} parents. The edge above it is the
						selection parent; the other {fanIn - 1} are not in this tree.
					</span>
				</div>
			)}
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
