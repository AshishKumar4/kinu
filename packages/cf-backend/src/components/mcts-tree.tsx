import { useRef, useEffect, useState, useImperativeHandle, forwardRef } from "react";
import * as d3 from "d3";
import type { MCTSNode } from "@/lib/protocol";

interface Props {
	root: MCTSNode;
	width?: number;
	height?: number;
	onNodeClick?: (node: MCTSNode) => void;
	selectedNode?: MCTSNode | null;
}

/** Imperative zoom controls for header buttons (MCTSExplorer). */
export interface MCTSTreeHandle {
	zoomIn(): void;
	zoomOut(): void;
	/** Fit the whole tree into the viewport. */
	fit(): void;
}

const STATUS_ICON: Record<string, string> = {
	open: "○",
	terminal: "★",
	pruned: "◌",
	failed: "✗",
};

const MARGIN = { top: 50, right: 50, bottom: 50, left: 50 };

function nodeColor(value: number, status: string): string {
	if (status === "pruned" || status === "failed") return "oklch(0.4 0 0)";
	return d3.interpolateRdYlGn(value);
}

function nodeRadius(visits: number): number {
	return Math.max(8, Math.min(24, 6 + visits * 2));
}

function cleanNodeLabel(value: string | null | undefined, fallback: string): string {
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

type NodeSelection = d3.Selection<SVGGElement, d3.HierarchyPointNode<MCTSNode>, SVGGElement, unknown>;

/** Selection highlighting as pure attribute updates — no layer rebuild, so a
 *  node click never tears the tree down or disturbs the zoom transform. */
function applySelection(g: d3.Selection<SVGGElement, unknown, null, undefined>, selectedId: string | null) {
	const nodes = g.selectAll<SVGGElement, d3.HierarchyPointNode<MCTSNode>>(".node") as NodeSelection;
	nodes.select<SVGCircleElement>("circle")
		.attr("stroke", (d) => {
			if (selectedId === d.data.id) return "#a78bfa";
			if (d.data.status === "terminal") return "#4ade80";
			return "rgba(255,255,255,0.15)";
		})
		.attr("stroke-width", (d) => selectedId === d.data.id ? 3 : d.data.status === "terminal" ? 2 : 1)
		.attr("opacity", (d) => selectedId === d.data.id ? 1 : d.data.status === "pruned" ? 0.34 : 1)
		.attr("filter", (d) => {
			if (selectedId === d.data.id) return "url(#selectGlow)";
			if (d.data.status === "terminal") return "url(#glow)";
			return "none";
		});
	nodes.select<SVGTextElement>("text.action-label")
		.text((d) => {
			const selected = selectedId === d.data.id;
			if (!selected && d.depth > 1 && d.data.status !== "terminal") return "";
			const label = cleanNodeLabel(d.data.action, STATUS_ICON[d.data.status] || "");
			return label.length > (selected ? 34 : 24) ? label.slice(0, selected ? 31 : 21) + "…" : label;
		})
		.attr("fill", (d) => selectedId === d.data.id ? "#c4b5fd" : d.data.status === "pruned" ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.6)");
}

export const MCTSTree = forwardRef<MCTSTreeHandle, Props>(function MCTSTree(
	{ root, width = 800, height = 600, onNodeClick, selectedNode }, handleRef,
) {
	const svgRef = useRef<SVGSVGElement>(null);
	const gRef = useRef<SVGGElement | null>(null);
	const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
	const transformInitialized = useRef(false);
	const onNodeClickRef = useRef(onNodeClick);
	onNodeClickRef.current = onNodeClick;
	const selectedIdRef = useRef<string | null>(selectedNode?.id ?? null);
	const [tooltip, setTooltip] = useState<{ x: number; y: number; node: MCTSNode } | null>(null);

	// One-time scaffold: glow filters, the persistent zoom/pan layer, and the
	// zoom behavior. The transform lives on this layer and is never reset by
	// data updates, so polling doesn't snap the user's pan/zoom back.
	useEffect(() => {
		const svg = d3.select(svgRef.current!);
		const defs = svg.append("defs");
		for (const [id, blur] of [["glow", "4"], ["selectGlow", "6"]] as const) {
			const f = defs.append("filter").attr("id", id).attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
			f.append("feGaussianBlur").attr("stdDeviation", blur).attr("result", "blur");
			f.append("feMerge").selectAll("feMergeNode").data(["blur", "SourceGraphic"]).join("feMergeNode").attr("in", (d) => d);
		}
		const g = svg.append("g");
		gRef.current = g.node();
		const zoom = d3.zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.2, 4])
			.on("zoom", (event) => { g.attr("transform", event.transform); });
		zoomRef.current = zoom;
		svg.call(zoom);
		return () => {
			svg.on(".zoom", null);
			svg.selectAll("*").remove();
			gRef.current = null;
			zoomRef.current = null;
			transformInitialized.current = false;
		};
	}, []);

	// Data render — rebuilds the link/node layer inside the persistent zoom
	// layer when the tree (or viewport) actually changes. The hook upstream
	// only swaps `root` identity when the row set changed, so steady-state
	// polls don't reach here at all.
	useEffect(() => {
		const g = d3.select(gRef.current!);
		g.selectAll("*").remove();

		const innerW = width - MARGIN.left - MARGIN.right;
		const innerH = height - MARGIN.top - MARGIN.bottom;

		const hierarchy = d3.hierarchy(root, (d) => d.children);
		const treeLayout = d3.tree<MCTSNode>().size([innerW, innerH]).separation((a, b) => a.parent === b.parent ? 1.2 : 1.8);
		const treeData = treeLayout(hierarchy);

		// Links — curved paths between nodes
		g.selectAll(".link")
			.data(treeData.links())
			.join("path")
			.attr("class", "link")
			.attr("d", d3.linkVertical<d3.HierarchyLink<MCTSNode>, d3.HierarchyPointNode<MCTSNode>>()
				.x((d) => d.x)
				.y((d) => d.y) as unknown as string)
			.attr("fill", "none")
			.attr("stroke", (d) => {
				if (d.target.data.status === "pruned") return "rgba(255,255,255,0.05)";
				const v = d.target.data.value;
				return v > 0.7 ? "rgba(74,222,128,0.3)" : v > 0.4 ? "rgba(250,204,21,0.2)" : "rgba(248,113,113,0.15)";
			})
			.attr("stroke-width", (d) => d.target.data.status === "pruned" ? 1 : Math.max(1, d.target.data.visits * 0.5))
			.attr("stroke-dasharray", (d) => d.target.data.status === "pruned" ? "4,4" : "none");

		// Node groups
		const nodes = g.selectAll(".node")
			.data(treeData.descendants())
			.join("g")
			.attr("class", "node")
			.attr("transform", (d) => `translate(${d.x},${d.y})`)
			.style("cursor", "pointer");

		// Node circles (selection-dependent attrs applied below)
		nodes.append("circle")
			.attr("r", (d) => nodeRadius(d.data.visits))
			.attr("fill", (d) => nodeColor(d.data.value, d.data.status));

		// Score label inside node
		nodes.append("text")
			.text((d) => d.data.value.toFixed(2))
			.attr("text-anchor", "middle")
			.attr("dy", "0.35em")
			.attr("fill", "white")
			.attr("font-size", (d) => nodeRadius(d.data.visits) > 14 ? "9px" : "7px")
			.attr("font-family", "var(--font-mono)")
			.attr("font-weight", "600")
			.attr("opacity", (d) => d.data.status === "pruned" ? 0.25 : 0.95);

		// Action label below node (text + fill applied by applySelection)
		nodes.append("text")
			.attr("class", "action-label")
			.attr("text-anchor", "middle")
			.attr("dy", (d) => nodeRadius(d.data.visits) + 14)
			.attr("font-size", "9px")
			.attr("font-family", "var(--font-sans)");

		// Visit count badge above node
		nodes.filter((d) => d.data.visits > 0)
			.append("text")
			.text((d) => `n=${d.data.visits}`)
			.attr("text-anchor", "middle")
			.attr("dy", (d) => -(nodeRadius(d.data.visits) + 6))
			.attr("fill", "rgba(255,255,255,0.35)")
			.attr("font-size", "8px")
			.attr("font-family", "var(--font-mono)");

		// Status icon for pruned/failed nodes
		nodes.filter((d) => d.data.status === "pruned" || d.data.status === "failed")
			.append("text")
			.text((d) => d.data.status === "pruned" ? "╳" : "!")
			.attr("text-anchor", "middle")
			.attr("dy", "0.35em")
			.attr("fill", (d) => d.data.status === "failed" ? "#f87171" : "rgba(255,255,255,0.3)")
			.attr("font-size", "12px");

		// Interactions
		nodes.on("mouseenter", (event, d) => {
			const [x, y] = d3.pointer(event, svgRef.current);
			setTooltip({ x, y: y - 10, node: d.data });
		}).on("mouseleave", () => {
			setTooltip(null);
		}).on("click", (_, d) => {
			onNodeClickRef.current?.(d.data);
		});

		applySelection(g as d3.Selection<SVGGElement, unknown, null, undefined>, selectedIdRef.current);

		// First render only — seed the margin offset through the zoom behavior
		// so user pans compose with it. Never reset afterwards.
		if (!transformInitialized.current && zoomRef.current) {
			transformInitialized.current = true;
			d3.select(svgRef.current!).call(
				zoomRef.current.transform, d3.zoomIdentity.translate(MARGIN.left, MARGIN.top),
			);
		}
	}, [root, width, height]);

	// Selection change — attribute updates only.
	useEffect(() => {
		selectedIdRef.current = selectedNode?.id ?? null;
		if (gRef.current) applySelection(d3.select(gRef.current), selectedIdRef.current);
	}, [selectedNode]);

	useImperativeHandle(handleRef, () => ({
		zoomIn() {
			if (!svgRef.current || !zoomRef.current) return;
			d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 1.4);
		},
		zoomOut() {
			if (!svgRef.current || !zoomRef.current) return;
			d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 1 / 1.4);
		},
		fit() {
			if (!svgRef.current || !gRef.current || !zoomRef.current) return;
			const b = gRef.current.getBBox();
			if (b.width === 0 || b.height === 0) return;
			const pad = 40;
			const scale = Math.max(0.2, Math.min(4, (width - pad * 2) / b.width, (height - pad * 2) / b.height));
			const tx = (width - b.width * scale) / 2 - b.x * scale;
			const ty = (height - b.height * scale) / 2 - b.y * scale;
			d3.select(svgRef.current).transition().duration(300).call(
				zoomRef.current.transform, d3.zoomIdentity.translate(tx, ty).scale(scale),
			);
		},
	}), [width, height]);

	return (
		<div className="relative w-full h-full">
			<svg ref={svgRef} width={width} height={height} className="w-full h-full" />
			{tooltip && (() => {
				const n = tooltip.node;
				const scoreColor = n.value >= 0.7 ? "text-green-400" : n.value >= 0.4 ? "text-amber-400" : "text-red-400";
				return (
				<div
				className="absolute z-50 pointer-events-none p-surface border rounded-lg px-4 py-3 shadow-2xl text-xs animate-scale-in max-w-xs"
				style={{ left: tooltip.x + 16, top: tooltip.y, borderColor: "var(--c-border)" }}
			>
				<div className="font-semibold p-text mb-2 leading-tight">
					{STATUS_ICON[n.status]} {cleanNodeLabel(n.action, "(root)")}
				</div>
				<div className="grid grid-cols-2 gap-x-4 gap-y-1 p-text-2">
					<span>Score</span>
					<span className={`font-mono ${scoreColor}`}>{n.value.toFixed(3)}</span>
					<span>Visits</span>
					<span className="p-text font-mono">{n.visits}</span>
					<span>Status</span>
					<span className={
						n.status === "terminal" ? "text-green-400" :
						n.status === "pruned" ? "text-gray-500" :
						n.status === "failed" ? "text-red-400" :
						"p-text"
					}>{n.status}</span>
					<span>Depth</span>
					<span className="p-text font-mono">{n.depth}</span>
				</div>
				{n.observation && (
					<div className="mt-2 pt-2 border-t p-border p-text-2 leading-relaxed">
						{n.observation.slice(0, 150)}{n.observation.length > 150 ? "..." : ""}
					</div>
				)}
				</div>);
			})()}
		</div>
	);
});
