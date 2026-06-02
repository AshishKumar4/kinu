/**
 * Reasoning surface — the agent's search & exploration, across the three real
 * strategies it can run: MCTS (the d3 tree + node inspector), branching Heads
 * (think strategy=heads → getHeadRuns), and GEPA offline optimisation (Pareto
 * front + ancestry → getGepaRuns / getGepaRun). All bound to wired backends.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { GitBranchIcon, TreeStructureIcon, GitForkIcon, DatabaseIcon, CaretRightIcon, CaretDownIcon, WrenchIcon } from "@phosphor-icons/react";
import { MCTSTree } from "@/components/mcts-tree";
import type { MCTSNode, Rpc } from "@/lib/protocol";
import { EmptyState, EMPTY_HINTS } from "./shared";

type SubView = "mcts" | "branches" | "gepa";

export interface ReasoningSurfaceProps {
  mctsTree: MCTSNode | null;
  rpc: Rpc;
}

export function ReasoningSurface({ mctsTree, rpc }: ReasoningSurfaceProps) {
  const [view, setView] = useState<SubView>("mcts");
  const tabs: Array<{ id: SubView; label: string; icon: React.ComponentType<{ size?: number }> }> = [
    { id: "mcts", label: "MCTS", icon: TreeStructureIcon },
    { id: "branches", label: "Branches", icon: GitForkIcon },
    { id: "gepa", label: "GEPA", icon: DatabaseIcon },
  ];
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 mb-3 shrink-0">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setView(t.id)}
            className={`px-2.5 py-1 text-[11px] rounded-md transition-colors flex items-center gap-1.5 ${view === t.id ? "p-elevated p-text font-medium" : "p-text-3 hover:p-text-2"}`}>
            <t.icon size={12} />{t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {view === "mcts" && <MctsView mctsTree={mctsTree} />}
        {view === "branches" && <BranchesView rpc={rpc} />}
        {view === "gepa" && <GepaView rpc={rpc} />}
      </div>
    </div>
  );
}

/* ── MCTS tree ─────────────────────────────────────────────────── */

function MctsView({ mctsTree }: { mctsTree: MCTSNode | null }) {
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

/* ── Branching heads ───────────────────────────────────────────── */

interface HeadEntry {
  id: string; task: string; rationale: string; status: string; summary: string | null;
  errorMessage: string | null; tokenInput: number; tokenOutput: number; wallClockMs: number;
  toolCalls: Array<{ name: string; status: string }>;
  decisions: Array<{ question: string; choice: string; rationale: string }>;
}
interface HeadRun {
  rootId: string; task: string; rationale: string; status: string; spawnedAt: number;
  heads: HeadEntry[];
  merge: { narrative: string; headCount: number; totalTokens: number } | null;
}

function statusDot(status: string): string {
  if (status === "completed") return "bg-emerald-500";
  if (status === "errored" || status === "failed") return "bg-red-500";
  if (status === "budget_exceeded") return "bg-orange-500";
  return "bg-amber-500";
}

// One head = an expandable card. Collapsed shows task + summary + a tool count;
// expanded reveals the nested trace (tool calls + decisions + any error) — the
// "what is this branch actually doing" view.
function HeadCard({ h }: { h: HeadEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = h.toolCalls.length > 0 || h.decisions.length > 0 || !!h.errorMessage;
  return (
    <div className="rounded-md border p-border p-elevated">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        disabled={!hasDetail}
        className={`w-full flex items-start gap-2 text-left px-2 py-1.5 ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className={`mt-1 size-1.5 rounded-full shrink-0 ${statusDot(h.status)}`} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] p-text-2 truncate" title={h.task}>{h.task}</div>
          {h.summary && <div className="text-[11px] p-text-3 line-clamp-2">{h.summary}</div>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-[10px] p-text-3 tabular-nums pt-0.5">
          {h.toolCalls.length > 0 && <span className="flex items-center gap-0.5"><WrenchIcon size={10} />{h.toolCalls.length}</span>}
          <span>{h.tokenInput + h.tokenOutput} tok</span>
          {hasDetail && (open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />)}
        </div>
      </button>
      {open && (
        <div className="px-2 pb-2 pl-5 space-y-1.5 animate-fade-in">
          {h.errorMessage && <div className="text-[10px] text-red-400 break-words">{h.errorMessage}</div>}
          {h.toolCalls.length > 0 && (
            <div className="space-y-0.5">
              {h.toolCalls.map((t, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px]">
                  <WrenchIcon size={10} className="p-text-3 shrink-0" />
                  <code className="p-text-2">{t.name}</code>
                  {t.status && <span className={/error|exit=[1-9]/.test(t.status) ? "text-red-400" : "p-text-3"}>{t.status}</span>}
                </div>
              ))}
            </div>
          )}
          {h.decisions.map((d, i) => (
            <div key={i} className="text-[10px] p-text-3">
              <span className="p-text-2">{d.question}</span> <span className="p-accent">→ {d.choice}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BranchesView({ rpc }: { rpc: Rpc }) {
  const [runs, setRuns] = useState<HeadRun[] | null>(null);
  useEffect(() => { rpc<HeadRun[]>("getHeadRuns", [20]).then(setRuns).catch(() => setRuns([])); }, [rpc]);
  if (runs === null) return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  if (runs.length === 0) return <EmptyState icon={<GitForkIcon size={28} />} title="No branching-head runs yet" hint="When the agent runs think(strategy:'heads'), the parallel reasoning branches and their merge appear here." />;
  return (
    <div className="space-y-3 animate-fade-in overflow-y-auto h-full">
      {runs.map((run) => (
        <div key={run.rootId} className="p-card rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <GitForkIcon size={13} className="p-accent" />
            <span className="text-xs font-medium p-text truncate flex-1" title={run.task}>{run.task}</span>
            <Badge variant="secondary">{run.heads.length} heads</Badge>
          </div>
          <div className="space-y-1 mb-2">
            {run.heads.map((h) => <HeadCard key={h.id} h={h} />)}
          </div>
          {run.merge && (
            <div className="text-[11px] p-text-2 rounded-md p-elevated border p-border p-2">
              <span className="p-accent font-medium">Merge · </span>
              <span className="line-clamp-3 whitespace-pre-wrap">{run.merge.narrative}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── GEPA ──────────────────────────────────────────────────────── */

interface GepaRunRow { runId: string; target: string; startedAt: number; status: string; winnerId: string | null; iterations: number; metricCalls: number }
interface GepaCandidate { id: string; parentId: string | null; aggregateScore: number; scores: Record<string, number>; createdAt: number }
interface GepaRunDetail { run: GepaRunRow | null; candidates: GepaCandidate[]; pareto: Array<{ candidateId: string; instanceId: string; score: number }> }

function GepaView({ rpc }: { rpc: Rpc }) {
  const [runs, setRuns] = useState<GepaRunRow[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<GepaRunDetail | null>(null);
  useEffect(() => { rpc<GepaRunRow[]>("getGepaRuns", [20]).then(setRuns).catch(() => setRuns([])); }, [rpc]);
  const open = useCallback((runId: string) => {
    setSel(runId); setDetail(null);
    rpc<GepaRunDetail>("getGepaRun", [runId]).then(setDetail).catch(() => {});
  }, [rpc]);

  if (runs === null) return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  if (runs.length === 0) return <EmptyState icon={<DatabaseIcon size={28} />} title="No GEPA runs yet" hint="Trigger a Genetic-Pareto scaffold optimisation from Settings; its candidates + Pareto front appear here." />;

  const paretoIds = new Set((detail?.pareto ?? []).map((p) => p.candidateId));
  const maxAgg = Math.max(0.0001, ...(detail?.candidates ?? []).map((c) => c.aggregateScore));
  return (
    <div className="space-y-3 animate-fade-in overflow-y-auto h-full">
      <div className="space-y-1">
        {runs.map((r) => (
          <button key={r.runId} onClick={() => open(r.runId)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${sel === r.runId ? "p-elevated" : "hover:p-card"}`}>
            <span className={`size-1.5 rounded-full shrink-0 ${r.status === "completed" ? "bg-emerald-500" : r.status === "running" ? "bg-amber-500" : "bg-zinc-500"}`} />
            <span className="text-[11px] p-text-2 flex-1 truncate">{r.target} · {r.iterations} iters · {r.metricCalls} evals</span>
            <span className="text-[10px] p-text-3 shrink-0">{new Date(r.startedAt).toLocaleDateString()}</span>
          </button>
        ))}
      </div>

      {sel && (detail === null ? (
        <div className="flex justify-center py-4"><Loader size="sm" /></div>
      ) : (
        <div className="space-y-2">
          <div className="text-[11px] p-text-3">{detail.candidates.length} candidates · {paretoIds.size} on the Pareto front · winner {detail.run?.winnerId?.slice(0, 8) ?? "—"}</div>
          {/* Candidate aggregate-score bars; Pareto-front + winner highlighted. */}
          <div className="space-y-1">
            {detail.candidates.map((c) => {
              const onPareto = paretoIds.has(c.id);
              const isWinner = detail.run?.winnerId === c.id;
              return (
                <div key={c.id} className="flex items-center gap-2 text-[10px]">
                  <span className={`font-mono shrink-0 w-14 truncate ${isWinner ? "text-emerald-300" : "p-text-3"}`}>{c.id.slice(0, 8)}</span>
                  <div className="flex-1 h-2 rounded-full p-elevated overflow-hidden">
                    <div className={`h-full ${isWinner ? "bg-emerald-500" : onPareto ? "bg-sky-500" : "bg-zinc-600"}`} style={{ width: `${(c.aggregateScore / maxAgg) * 100}%` }} />
                  </div>
                  <span className="font-mono p-text-3 tabular-nums shrink-0 w-10 text-right">{c.aggregateScore.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
