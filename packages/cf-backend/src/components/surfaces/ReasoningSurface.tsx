/**
 * Reasoning surface — the agent's search & exploration. Phase 2 renders the
 * MCTS tree (the existing d3 canvas) with a node-detail inspector. Branching
 * heads + GEPA Pareto views (getHeadRuns / getGepaRun) are layered in by the
 * Reasoning-surface phase.
 */
import { useState, useRef, useEffect } from "react";
import { Button } from "@cloudflare/kumo";
import { GitBranchIcon } from "@phosphor-icons/react";
import { MCTSTree } from "@/components/mcts-tree";
import type { MCTSNode } from "@/lib/protocol";
import { EmptyState, EMPTY_HINTS } from "./shared";

export function ReasoningSurface({ mctsTree }: { mctsTree: MCTSNode | null }) {
  const [selectedNode, setSelectedNode] = useState<MCTSNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 700, h: 400 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: Math.max(350, el.clientHeight - (selectedNode ? 200 : 0)) }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: Math.max(350, el.clientHeight - (selectedNode ? 200 : 0)) });
    return () => ro.disconnect();
  }, [selectedNode]);

  if (!mctsTree) return <EmptyState icon={<GitBranchIcon size={28} />} title="No exploration history" hint={EMPTY_HINTS.mcts} />;
  const countN = (n: MCTSNode): number => 1 + n.children.reduce((s, c) => s + countN(c), 0);
  const maxD = (n: MCTSNode): number => n.children.length === 0 ? n.depth : Math.max(...n.children.map(maxD));
  return (
    <div ref={containerRef} className="animate-fade-in h-full flex flex-col">
      <div className="flex items-center gap-4 mb-2 text-xs p-text-2">
        <span>Nodes: <span className="p-text font-mono">{countN(mctsTree)}</span></span>
        <span>Depth: <span className="p-text font-mono">{maxD(mctsTree)}</span></span>
        <span>Root: <span className="p-text font-mono">{mctsTree.value.toFixed(3)}</span></span>
      </div>
      <div className="flex-1 min-h-0">{dims.w > 0 && <MCTSTree root={mctsTree} width={dims.w} height={dims.h} onNodeClick={setSelectedNode} selectedNode={selectedNode} />}</div>
      {selectedNode && (
        <div className="p-card rounded-lg p-3 mt-2 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium p-text">Node Details</span>
            <Button variant="ghost" size="sm" onClick={() => setSelectedNode(null)}>Close</Button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {(() => {
              const parentVisits = mctsTree?.visits ?? selectedNode.visits;
              const uct = selectedNode.visits > 0
                ? selectedNode.value + 1.414 * Math.sqrt(Math.log(parentVisits) / selectedNode.visits)
                : Infinity;
              const scoreColor = selectedNode.value >= 0.7 ? "p-success" : selectedNode.value >= 0.4 ? "p-warning" : "p-danger";
              return ([
                ["Action", selectedNode.action || "(root)"],
                ["Avg Reward", <span key="r" className={scoreColor}>{selectedNode.value.toFixed(4)}</span>],
                ["UCT Score", isFinite(uct) ? uct.toFixed(4) : "∞"],
                ["Visits", selectedNode.visits],
                ["Status", selectedNode.status],
                ["Depth", selectedNode.depth],
                ["Children", selectedNode.children.length],
                ...(selectedNode.observation ? [["Observation", selectedNode.observation.slice(0, 80) + (selectedNode.observation.length > 80 ? "..." : "")]] : []),
              ] as [string, React.ReactNode][]).map(([k, v]) => (
                <div key={String(k)} className="contents"><span className="p-text-2">{k}</span><span className="p-text font-mono">{typeof v === "string" || typeof v === "number" ? String(v) : v}</span></div>
              ));
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
