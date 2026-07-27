import { useState, useRef, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { ArrowLeftIcon, TreeStructureIcon, ArrowsOutIcon, MagnifyingGlassPlusIcon, MagnifyingGlassMinusIcon } from "@phosphor-icons/react";
import { MCTSTree, type MCTSTreeHandle } from "@/components/mcts-tree";
import { EmptyState, EMPTY_HINTS } from "@/components/surfaces/shared";
import { useProteus } from "@/hooks/use-proteus";
import type { MCTSNode } from "@/lib/protocol";

function countNodes(node: MCTSNode): number { return 1 + node.children.reduce((s, c) => s + countNodes(c), 0); }
function maxDepth(node: MCTSNode): number { return node.children.length === 0 ? node.depth : Math.max(...node.children.map(maxDepth)); }
function findWinner(node: MCTSNode): MCTSNode {
  let best = node;
  for (const child of node.children) { const cb = findWinner(child); if (cb.value > best.value) best = cb; }
  return best;
}

export default function MCTSExplorer() {
  const { agentId } = useParams();
  const state = useProteus(agentId);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<MCTSTreeHandle>(null);
  const [dims, setDims] = useState({ w: 1200, h: 700 });
  const [selected, setSelected] = useState<MCTSNode | null>(null);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const tree = state.mctsTree;
  const total = tree ? countNodes(tree) : 0;
  const depth = tree ? maxDepth(tree) : 0;
  const winner = tree ? findWinner(tree) : null;

  return (
    <div className="h-full flex flex-col p-bg">
      <div className="flex items-center justify-between px-5 py-3.5 border-b p-border">
        <div className="flex items-center gap-3">
          <Link to={`/workspace/${agentId}`}><Button variant="ghost" size="sm" icon={<ArrowLeftIcon size={14} />}>Back</Button></Link>
          <div className="h-4 w-px bg-[var(--c-border)]" />
          <TreeStructureIcon size={16} className="p-accent" />
          <span className="font-semibold text-sm p-text">MCTS Explorer</span>
          {state.agentStatus && <span className="text-xs p-text-2">- {state.agentStatus.name}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" shape="square" size="sm" icon={<MagnifyingGlassMinusIcon size={16} />} aria-label="Zoom out" disabled={!tree} onClick={() => treeRef.current?.zoomOut()} />
          <Button variant="ghost" shape="square" size="sm" icon={<MagnifyingGlassPlusIcon size={16} />} aria-label="Zoom in" disabled={!tree} onClick={() => treeRef.current?.zoomIn()} />
          <Button variant="ghost" shape="square" size="sm" icon={<ArrowsOutIcon size={16} />} aria-label="Fit" disabled={!tree} onClick={() => treeRef.current?.fit()} />
        </div>
      </div>
      <div className="flex items-center gap-4 px-5 py-2 border-b p-border text-xs p-text-2">
        <span className="font-medium p-text">Legend:</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full p-dot-success" />High</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full p-dot-warning" />Medium</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full p-dot-danger" />Low</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full p-dot-neutral opacity-40" />Pruned</span>
        <span className="ml-auto p-text-3">Node size = visit count</span>
      </div>
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        {!tree ? (
          // The workspace snapshot resolves agentStatus — once it's here with
          // no tree, the agent genuinely has no MCTS data (not still loading).
          state.agentStatus ? (
            <div className="h-full flex items-center justify-center">
              <EmptyState icon={<TreeStructureIcon size={28} />} title="No exploration tree yet" hint={EMPTY_HINTS.mcts} />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full"><div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" />Loading tree...</div></div>
          )
        ) : dims.w > 0 && <MCTSTree ref={treeRef} root={tree} width={dims.w} height={dims.h} onNodeClick={setSelected} selectedNode={selected} />}
      </div>
      <div className="flex items-center justify-between px-5 py-2.5 border-t p-border">
        <div className="flex items-center gap-6 text-xs">
          <span className="p-text-2">Nodes: <span className="p-text font-medium">{total}</span></span>
          <span className="p-text-2">Depth: <span className="p-text font-medium">{depth}</span></span>
          {winner && (
            <>
              <span className="p-text-2">Winner: <span className="p-success font-medium">{winner.value.toFixed(3)}</span></span>
              <span className={`flex items-center gap-1 ${winner.status === "terminal" ? "p-success" : "p-warning"}`}>
                <span className="size-1.5 rounded-full bg-current animate-pulse" />
                {winner.status === "terminal" ? "Converged" : "Searching..."}
              </span>
            </>
          )}
        </div>
        {selected && (
          <div className="flex items-center gap-4 text-xs animate-fade-in">
            <span className="p-text-2">Selected:</span>
            <span className="font-mono p-text">{selected.action}</span>
            <span className="p-text-2">v={selected.value.toFixed(3)} n={selected.visits}</span>
          </div>
        )}
      </div>
    </div>
  );
}
