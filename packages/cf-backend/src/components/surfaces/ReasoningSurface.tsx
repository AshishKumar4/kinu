/**
 * Reasoning surface — the agent's search & exploration, across the three real
 * strategies it can run: MCTS (the d3 tree + node inspector), branching Heads
 * (think strategy=heads → getHeadRuns), and GEPA offline optimisation (Pareto
 * front + ancestry → getGepaRuns / getGepaRun). All bound to wired backends.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { GitBranchIcon, TreeStructureIcon, GitForkIcon, DatabaseIcon, WrenchIcon, BrainIcon, GaugeIcon, ArrowsOutIcon } from "@phosphor-icons/react";
import { DEFAULT_QUALITY_THRESHOLD, lossInterval, scoreInterval, type AlignmentConvergence, type ScoreInterval } from "@proteus/core";
import { MCTSTree } from "@/components/mcts-tree";
import type { MCTSNode, MCTSNodeDetail, MCTSNodeSummary, Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState, EMPTY_HINTS, MarkdownContent } from "./shared";

type SubView = "mcts" | "branches" | "gepa" | "quality";

export interface ReasoningSurfaceProps {
  mctsTree: MCTSNode | null;
  rpc: Rpc;
}

export function ReasoningSurface({ mctsTree, rpc }: ReasoningSurfaceProps) {
  const { agentId } = useParams();
  const [view, setView] = useState<SubView>("mcts");
  const tabs: Array<{ id: SubView; label: string; icon: React.ComponentType<{ size?: number }> }> = [
    { id: "mcts", label: "MCTS", icon: TreeStructureIcon },
    { id: "branches", label: "Branches", icon: GitForkIcon },
    { id: "gepa", label: "Self-tuning", icon: DatabaseIcon },
    { id: "quality", label: "Quality", icon: GaugeIcon },
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
        {/* Full-screen MCTS explorer — the one entry point to /mcts/:id. */}
        {view === "mcts" && agentId && (
          <Link to={`/mcts/${agentId}`}
            className="ml-auto flex items-center gap-1 px-2 py-1 text-[11px] rounded-md p-text-3 hover:p-text transition-colors"
            title="Open the full-screen MCTS explorer">
            <ArrowsOutIcon size={12} />Expand
          </Link>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {view === "mcts" && <MctsView mctsTree={mctsTree} rpc={rpc} />}
        {view === "branches" && <BranchesView rpc={rpc} />}
        {view === "gepa" && <GepaView rpc={rpc} />}
        {view === "quality" && <QualityView rpc={rpc} />}
      </div>
    </div>
  );
}

/* ── MCTS tree ─────────────────────────────────────────────────── */

function MctsView({ mctsTree, rpc }: { mctsTree: MCTSNode | null; rpc: Rpc }) {
  const [selectedNode, setSelectedNode] = useState<MCTSNode | null>(null);
  const [detail, setDetail] = useState<MCTSNodeDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 700, h: 520 });

  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const resize = () => setDims({ w: el.clientWidth, h: Math.max(420, el.clientHeight - 8) });
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedNode) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    rpc<MCTSNodeDetail | null>("getMctsNodeDetail", [selectedNode.id])
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [rpc, selectedNode?.id]);

  if (!mctsTree) return <EmptyState icon={<GitBranchIcon size={28} />} title="No exploration history" hint={EMPTY_HINTS.mcts} />;
  const countN = (n: MCTSNode): number => 1 + n.children.reduce((s, c) => s + countN(c), 0);
  const maxD = (n: MCTSNode): number => n.children.length === 0 ? n.depth : Math.max(...n.children.map(maxD));
  const fallbackDetail = selectedNode ? mctsNodeToDetail(selectedNode) : null;
  const openNodeById = (id: string) => {
    const next = findMctsNode(mctsTree, id);
    if (next) setSelectedNode(next);
  };
  return (
    <div className="animate-fade-in h-full min-h-0 grid gap-3 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-4 mb-2 text-xs p-text-2 shrink-0">
          <span>Nodes: <span className="p-text font-mono">{countN(mctsTree)}</span></span>
          <span>Depth: <span className="p-text font-mono">{maxD(mctsTree)}</span></span>
          <span>Root score: <span className="p-text font-mono">{mctsTree.value.toFixed(3)}</span></span>
          {selectedNode && <span>Selected: <span className="p-text font-mono">{selectedNode.id.slice(0, 8)}</span></span>}
        </div>
        <div ref={graphRef} className="flex-1 min-h-[420px] overflow-hidden rounded-lg border p-border p-surface">
          {dims.w > 0 && <MCTSTree root={mctsTree} width={dims.w} height={dims.h} onNodeClick={setSelectedNode} selectedNode={selectedNode} />}
        </div>
      </div>
      <MctsBranchInspector
        selected={selectedNode}
        detail={detail ?? fallbackDetail}
        loading={!!selectedNode && !detail && !detailError}
        error={detailError}
        onClose={() => setSelectedNode(null)}
        onOpenNode={openNodeById}
      />
    </div>
  );
}

function findMctsNode(root: MCTSNode, id: string): MCTSNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findMctsNode(child, id);
    if (found) return found;
  }
  return null;
}

function mctsNodeToDetail(node: MCTSNode): MCTSNodeDetail {
  return {
    id: node.id,
    parentId: node.parentId,
    depth: node.depth,
    visits: node.visits,
    value: node.value,
    status: node.status,
    action: node.action,
    task: node.task ?? "",
    observation: node.observation ?? "",
    codeUsed: node.codeUsed ?? null,
    branchAgentKey: node.branchAgentKey ?? null,
    msgId: node.msgId ?? null,
    createdAt: node.createdAt,
    path: [{
      id: node.id,
      parentId: node.parentId,
      depth: node.depth,
      visits: node.visits,
      value: node.value,
      status: node.status,
      action: node.action,
      createdAt: node.createdAt,
    }],
    children: node.children.map(toMctsSummary),
  };
}

function toMctsSummary(node: MCTSNode): MCTSNodeSummary {
  return {
    id: node.id,
    parentId: node.parentId,
    depth: node.depth,
    visits: node.visits,
    value: node.value,
    status: node.status,
    action: node.action,
    createdAt: node.createdAt,
  };
}

function scoreColor(value: number): string {
  if (value >= 0.7) return "p-success";
  if (value >= 0.4) return "p-warning";
  return "p-danger";
}

function formatScore(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function cleanBranchTitle(value: string | null | undefined, fallback: string): string {
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

function statusLabel(status: string): string {
  if (status === "terminal") return "winner";
  if (status === "pruned") return "pruned";
  if (status === "failed") return "failed";
  return "candidate";
}

function statusSentence(status: string): string {
  if (status === "terminal") return "Selected as the best branch in this search.";
  if (status === "pruned") return "No longer being explored after scoring and comparison.";
  if (status === "failed") return "The branch failed or could not be evaluated usefully.";
  return "Still available for further exploration.";
}

function MctsBranchInspector({
  selected,
  detail,
  loading,
  error,
  onClose,
  onOpenNode,
}: {
  selected: MCTSNode | null;
  detail: MCTSNodeDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onOpenNode: (id: string) => void;
}) {
  if (!selected) {
    return (
      <div className="rounded-lg border p-border p-surface p-4 min-h-0 flex flex-col justify-center">
        <EmptyState
          icon={<TreeStructureIcon size={28} />}
          title="Select a branch"
          hint="Pick a node to inspect the branch result, score, path, and child branches."
        />
      </div>
    );
  }

  const branch = detail ?? mctsNodeToDetail(selected);
  const parentVisits = branch.path.length >= 2 ? Math.max(1, branch.path[branch.path.length - 2]!.visits) : Math.max(1, branch.visits);
  const uct = branch.visits > 0
    ? branch.value + Math.SQRT2 * Math.sqrt(Math.log(parentVisits) / branch.visits)
    : Infinity;
  const branchAnswer = branch.observation || branch.action || "(no branch output captured)";
  const title = cleanBranchTitle(branch.action || branch.observation, branch.task || branch.id);
  const label = statusLabel(branch.status);

  return (
    <aside className="min-h-0 rounded-lg border p-border p-surface overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b p-border shrink-0">
        <div className="flex items-center gap-2">
          <span className={`size-1.5 rounded-full shrink-0 ${branch.status === "terminal" ? "p-dot-success" : branch.status === "failed" ? "p-dot-danger" : branch.status === "pruned" ? "p-dot-neutral" : "p-dot-warning"}`} />
          <span className="text-[10px] uppercase p-text-3 tracking-normal">{label}</span>
          <span className="text-[10px] p-text-3">depth {branch.depth}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>Close</Button>
        </div>
        <div className="mt-2 min-w-0">
          <div className="text-sm font-semibold p-text leading-snug line-clamp-3" title={title}>
            {title}
          </div>
          <div className="text-[10px] p-text-3 font-mono mt-1 truncate">{branch.id}</div>
        </div>
      </div>

      <div className="p-4 overflow-y-auto min-h-0 space-y-4">
        {loading && <div className="flex items-center gap-2 text-[11px] p-text-3"><Loader size="sm" /> Refreshing branch details...</div>}
        {error && <div className="text-[11px] p-danger">Could not refresh branch details: {error}</div>}

        <div className="rounded-lg border p-border p-elevated p-3">
          <div className="flex items-start gap-3">
            <div className={`text-3xl font-semibold leading-none tabular-nums ${scoreColor(branch.value)}`}>{formatScore(branch.value)}</div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium p-text">Search verdict</div>
              <div className="text-[11px] p-text-3 leading-relaxed mt-0.5">{statusSentence(branch.status)}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <Metric label="Explored" value={`${branch.visits}x`} />
            <Metric label="Priority" value={isFinite(uct) ? uct.toFixed(2) : "new"} />
            <Metric label="Depth" value={branch.depth} />
            <Metric label="Next branches" value={branch.children.length} />
          </div>
        </div>

        <DetailSection title="Branch answer">
          <div className="rounded-lg border p-border p-card px-3 py-2 text-[11px] p-text-2 leading-relaxed max-h-80 overflow-y-auto">
            <MarkdownContent content={branchAnswer} />
          </div>
        </DetailSection>

        {branch.codeUsed && (
          <DetailSection title="Code draft">
            <pre className="text-[10px] p-text-2 leading-relaxed whitespace-pre-wrap break-words max-h-56 overflow-y-auto rounded-md p-elevated border p-border p-2">
              {branch.codeUsed}
            </pre>
          </DetailSection>
        )}

        {branch.task && (
          <details className="rounded-lg border p-border p-card px-3 py-2">
            <summary className="cursor-pointer text-[10px] uppercase tracking-normal p-text-3">Original task</summary>
            <p className="text-[11px] p-text-2 leading-relaxed whitespace-pre-wrap break-words mt-2">{branch.task}</p>
          </details>
        )}

        <DetailSection title="Search path">
          <div className="space-y-1">
            {branch.path.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onOpenNode(p.id)}
                className={`w-full flex items-start gap-2 rounded-md px-2 py-1 text-left transition-colors ${p.id === branch.id ? "p-elevated" : "hover:p-card"}`}
              >
                <span className="text-[9px] p-text-3 font-mono w-5 text-right shrink-0">{i}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] p-text-2 truncate" title={cleanBranchTitle(p.action, p.id)}>{cleanBranchTitle(p.action, "(root)")}</div>
                  <div className="text-[9px] p-text-3 font-mono">{p.id.slice(0, 12)} · {formatScore(p.value)} · {statusLabel(p.status)}</div>
                </div>
              </button>
            ))}
          </div>
        </DetailSection>

        {branch.children.length > 0 && (
          <DetailSection title="Next branches">
            <div className="space-y-1">
              {branch.children.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onOpenNode(c.id)}
                  className="w-full flex items-start gap-2 rounded-md px-2 py-1 p-elevated text-left hover:p-card transition-colors"
                >
                  <span className={`mt-1 size-1.5 rounded-full shrink-0 ${c.status === "terminal" ? "p-dot-success" : c.status === "failed" ? "p-dot-danger" : c.status === "pruned" ? "p-dot-neutral" : "p-dot-warning"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] p-text-2 truncate" title={cleanBranchTitle(c.action, c.id)}>{cleanBranchTitle(c.action, "(branch)")}</div>
                    <div className="text-[9px] p-text-3 font-mono">{c.id.slice(0, 12)} · {formatScore(c.value)} · {c.visits} visits</div>
                  </div>
                </button>
              ))}
            </div>
          </DetailSection>
        )}

        {(branch.branchAgentKey || branch.msgId) && (
          <details className="rounded-lg border p-border px-3 py-2">
            <summary className="cursor-pointer text-[10px] uppercase tracking-normal p-text-3">Debug references</summary>
            <div className="space-y-1 text-[10px] p-text-3 font-mono break-all mt-2">
              {branch.branchAgentKey && <div>branch_agent_key: {branch.branchAgentKey}</div>}
              {branch.msgId && <div>msg_id: {branch.msgId}</div>}
            </div>
          </details>
        )}
      </div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border p-border bg-black/10 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-normal p-text-3">{label}</div>
      <div className="text-[11px] p-text font-mono tabular-nums">{value}</div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-normal p-text-3">{title}</div>
      {children}
    </section>
  );
}

/* ── Branching heads ───────────────────────────────────────────── */

interface HeadStepToolCall { name: string; input?: unknown; output?: unknown }
interface HeadStep { text: string; reasoning?: string; toolCalls: HeadStepToolCall[] }
interface HeadEntry {
  id: string; task: string; rationale: string; status: string; summary: string | null;
  errorMessage: string | null; tokenInput: number; tokenOutput: number; wallClockMs: number;
  toolCalls: Array<{ name: string; status: string }>;
  decisions: Array<{ question: string; choice: string; rationale: string }>;
  steps: HeadStep[];
}
interface HeadRun {
  rootId: string; task: string; rationale: string; status: string; spawnedAt: number;
  heads: HeadEntry[];
  merge: { narrative: string; headCount: number; totalTokens: number } | null;
}

function statusDot(status: string): string {
  if (status === "completed") return "p-dot-success";
  if (status === "errored" || status === "failed") return "p-dot-danger";
  if (status === "budget_exceeded") return "p-dot-warning";
  return "p-dot-warning";
}

/** Compact one-line digest of a tool call's input/output value. */
function digestValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// One reasoning step: ordinal + optional reasoning + prose + its tool calls
// (name with input → output). This is the "what each branch actually did,
// turn by turn" view the run timeline drills into.
function StepRow({ step, n }: { step: HeadStep; n: number }) {
  return (
    <div className="flex gap-2">
      <span className="text-[9px] p-text-3 tabular-nums pt-0.5 w-4 shrink-0 text-right">{n}</span>
      <div className="min-w-0 flex-1 space-y-1 border-l p-border pl-2">
        {step.reasoning && (
          <div className="flex items-start gap-1 text-[10px] p-text-3 italic">
            <BrainIcon size={10} className="shrink-0 mt-0.5" />
            <span className="line-clamp-3 whitespace-pre-wrap">{step.reasoning}</span>
          </div>
        )}
        {step.text && <div className="text-[10px] p-text-2 whitespace-pre-wrap break-words">{step.text}</div>}
        {step.toolCalls.map((t, i) => {
          const inp = digestValue(t.input);
          const out = digestValue(t.output);
          return (
            <div key={i} className="text-[10px] flex items-start gap-1">
              <WrenchIcon size={10} className="p-text-3 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <code className="p-accent">{t.name}</code>
                {inp && <span className="p-text-3 break-all"> ({inp.length > 120 ? inp.slice(0, 120) + "…" : inp})</span>}
                {out && <div className="p-text-3 break-all line-clamp-2">→ {out.length > 160 ? out.slice(0, 160) + "…" : out}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface HeadSelection { run: HeadRun; head: HeadEntry }

function HeadListButton({
  h,
  selected,
  onSelect,
}: {
  h: HeadEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-start gap-2 text-left rounded-md px-2 py-1.5 transition-colors ${selected ? "p-elevated" : "hover:p-card"}`}
    >
      <span className={`mt-1 size-1.5 rounded-full shrink-0 ${statusDot(h.status)}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] p-text-2 truncate" title={h.task}>{h.task}</div>
        {h.summary && <div className="text-[10px] p-text-3 line-clamp-2">{h.summary}</div>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0 text-[9px] p-text-3 tabular-nums pt-0.5">
        {h.steps.length > 0 && <span>{h.steps.length} steps</span>}
        {h.toolCalls.length > 0 && <span className="flex items-center gap-0.5"><WrenchIcon size={10} />{h.toolCalls.length}</span>}
      </div>
    </button>
  );
}

function HeadBranchInspector({ selection }: { selection: HeadSelection | null }) {
  if (!selection) {
    return (
      <div className="rounded-lg border p-border p-surface p-4 min-h-0 flex flex-col justify-center">
        <EmptyState icon={<GitForkIcon size={28} />} title="Select a branch" hint="Select a head to inspect its steps, tool calls, decisions, and merge context." />
      </div>
    );
  }

  const { run, head } = selection;
  const totalTokens = head.tokenInput + head.tokenOutput;
  return (
    <aside className="min-h-0 rounded-lg border p-border p-surface overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b p-border flex items-start gap-2 shrink-0">
        <span className={`mt-1.5 size-1.5 rounded-full shrink-0 ${statusDot(head.status)}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium p-text truncate" title={head.task}>{head.task}</div>
          <div className="text-[10px] p-text-3 font-mono truncate">{head.id}</div>
        </div>
        <Badge variant="secondary">{head.status}</Badge>
      </div>

      <div className="p-3 overflow-y-auto min-h-0 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Steps" value={head.steps.length} />
          <Metric label="Tools" value={head.toolCalls.length} />
          <Metric label="Tokens" value={totalTokens} />
          <Metric label="Wall" value={`${head.wallClockMs}ms`} />
          <Metric label="Decisions" value={head.decisions.length} />
          <Metric label="Run heads" value={run.heads.length} />
        </div>

        <DetailSection title="Run">
          <p className="text-[11px] p-text-2 leading-relaxed whitespace-pre-wrap break-words">{run.task || run.rationale}</p>
        </DetailSection>

        {head.rationale && (
          <DetailSection title="Rationale">
            <p className="text-[11px] p-text-2 leading-relaxed whitespace-pre-wrap break-words">{head.rationale}</p>
          </DetailSection>
        )}

        {head.summary && (
          <DetailSection title="Summary">
            <p className="text-[11px] p-text-2 leading-relaxed whitespace-pre-wrap break-words">{head.summary}</p>
          </DetailSection>
        )}

        {head.errorMessage && (
          <DetailSection title="Error">
            <div className="text-[11px] p-danger break-words">{head.errorMessage}</div>
          </DetailSection>
        )}

        <DetailSection title="Progress">
          {head.steps.length > 0 ? (
            <div className="space-y-1.5">
              {head.steps.map((s, i) => <StepRow key={i} step={s} n={i + 1} />)}
            </div>
          ) : head.toolCalls.length > 0 ? (
            <div className="space-y-1">
              {head.toolCalls.map((t, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px]">
                  <WrenchIcon size={10} className="p-text-3 shrink-0" />
                  <code className="p-text-2">{t.name}</code>
                  {t.status && <span className={/error|exit=[1-9]/.test(t.status) ? "p-danger" : "p-text-3"}>{t.status}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] p-text-3">No step trace captured for this head.</div>
          )}
        </DetailSection>

        {head.decisions.length > 0 && (
          <DetailSection title="Decisions">
            <div className="space-y-1">
              {head.decisions.map((d, i) => (
                <div key={i} className="rounded-md p-elevated border p-border p-2 text-[10px]">
                  <div className="p-text-2">{d.question}</div>
                  <div className="p-accent mt-0.5">→ {d.choice}</div>
                  {d.rationale && <div className="p-text-3 mt-0.5">{d.rationale}</div>}
                </div>
              ))}
            </div>
          </DetailSection>
        )}

        {run.merge && (
          <DetailSection title="Merge">
            <p className="text-[11px] p-text-2 leading-relaxed whitespace-pre-wrap break-words">{run.merge.narrative}</p>
            <div className="text-[10px] p-text-3 mt-1 font-mono">{run.merge.headCount} heads · {run.merge.totalTokens} tokens</div>
          </DetailSection>
        )}
      </div>
    </aside>
  );
}

function BranchesView({ rpc }: { rpc: Rpc }) {
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null);
  const load = useCallback(() => rpc<HeadRun[]>("getHeadRuns", [20]), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const runs = lastValue(resource);
  if (runs === null) {
    if (resource.status === "error") return <LoadFailure what="the branching-head runs" message={resource.message} onRetry={reload} />;
    return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }
  if (runs.length === 0) return <EmptyState icon={<GitForkIcon size={28} />} title="No branching-head runs yet" hint="When the agent runs think(strategy:'heads'), the parallel reasoning branches and their merge appear here." />;
  const selections: HeadSelection[] = runs.flatMap((run) => run.heads.map((head) => ({ run, head })));
  const selected = selections.find((s) => s.head.id === selectedHeadId) ?? selections[0] ?? null;
  return (
    <div className="h-full min-h-0 grid gap-3 lg:grid-cols-[minmax(280px,420px)_minmax(0,1fr)] animate-fade-in">
      <div className="min-h-0 overflow-y-auto rounded-lg border p-border p-surface p-2 space-y-3">
        {runs.map((run) => (
          <section key={run.rootId} className="space-y-1.5">
            <div className="flex items-center gap-2 px-1">
              <GitForkIcon size={13} className="p-accent shrink-0" />
              <span className="text-xs font-medium p-text truncate flex-1" title={run.task}>{run.task}</span>
              <Badge variant="secondary">{run.heads.length} heads</Badge>
            </div>
            <div className="space-y-1">
              {run.heads.map((h) => (
                <HeadListButton
                  key={h.id}
                  h={h}
                  selected={selected?.head.id === h.id}
                  onSelect={() => setSelectedHeadId(h.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <HeadBranchInspector selection={selected} />
    </div>
  );
}

/* ── GEPA ──────────────────────────────────────────────────────── */

interface GepaRunRow { runId: string; target: string; startedAt: number; status: string; winnerId: string | null; iterations: number; metricCalls: number }
interface GepaCandidate { id: string; parentId: string | null; aggregateScore: number; scores: Record<string, number>; createdAt: number }
interface GepaRunDetail { run: GepaRunRow | null; candidates: GepaCandidate[]; pareto: Array<{ candidateId: string; instanceId: string; score: number }> }

function GepaView({ rpc }: { rpc: Rpc }) {
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<AsyncResource<GepaRunDetail>>({ status: "loading" });
  const load = useCallback(() => rpc<GepaRunRow[]>("getGepaRuns", [20]), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const open = useCallback((runId: string) => {
    setSel(runId);
    setDetail({ status: "loading" });
    rpc<GepaRunDetail>("getGepaRun", [runId]).then(
      (d) => setDetail(loadSucceeded(d)),
      (err) => setDetail((prev) => loadFailed(prev, err)),
    );
  }, [rpc]);

  const runs = lastValue(resource);
  if (runs === null) {
    if (resource.status === "error") return <LoadFailure what="the self-tuning runs" message={resource.message} onRetry={reload} />;
    return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }
  if (runs.length === 0) return <EmptyState icon={<DatabaseIcon size={28} />} title="No self-tuning runs yet" hint="Trigger a scaffold self-tuning pass (GEPA) from Settings; its candidates + Pareto front appear here." />;

  const loadedDetail = lastValue(detail);
  const paretoIds = new Set((loadedDetail?.pareto ?? []).map((p) => p.candidateId));
  const maxAgg = Math.max(0.0001, ...(loadedDetail?.candidates ?? []).map((c) => c.aggregateScore));
  return (
    <div className="space-y-3 animate-fade-in overflow-y-auto h-full">
      <div className="space-y-1">
        {runs.map((r) => (
          <button key={r.runId} onClick={() => open(r.runId)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${sel === r.runId ? "p-elevated" : "hover:p-card"}`}>
            <span className={`size-1.5 rounded-full shrink-0 ${r.status === "completed" ? "p-dot-success" : r.status === "running" ? "p-dot-warning" : "p-dot-neutral"}`} />
            <span className="text-[11px] p-text-2 flex-1 truncate">{r.target} · {r.iterations} iters · {r.metricCalls} evals</span>
            <span className="text-[10px] p-text-3 shrink-0">{new Date(r.startedAt).toLocaleDateString()}</span>
          </button>
        ))}
      </div>

      {sel && (loadedDetail === null ? (
        detail.status === "error"
          ? <LoadFailure what="this run's candidates" message={detail.message} onRetry={() => open(sel)} />
          : <div className="flex justify-center py-4"><Loader size="sm" /></div>
      ) : (
        <div className="space-y-2">
          <div className="text-[11px] p-text-3">{loadedDetail.candidates.length} candidates · {paretoIds.size} on the Pareto front · winner {loadedDetail.run?.winnerId?.slice(0, 8) ?? "—"}</div>
          {/* Candidate aggregate-score bars; Pareto-front + winner highlighted. */}
          <div className="space-y-1">
            {loadedDetail.candidates.map((c) => {
              const onPareto = paretoIds.has(c.id);
              const isWinner = loadedDetail.run?.winnerId === c.id;
              // The aggregate is a mean over a handful of judged instances —
              // shown with its interval so two candidates aren't read apart on
              // a gap the eval set can't resolve.
              const ci = scoreInterval(Object.values(c.scores));
              return (
                <div key={c.id} className="flex items-center gap-2 text-[10px]">
                  <span className={`font-mono shrink-0 w-14 truncate ${isWinner ? "p-success" : "p-text-3"}`}>{c.id.slice(0, 8)}</span>
                  <div className="flex-1 h-2 rounded-full p-elevated overflow-hidden" title={`95% CI ${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)} over ${ci.n} instances`}>
                    <div className={`h-full ${isWinner ? "p-dot-success" : onPareto ? "p-dot-info" : "p-dot-neutral"}`} style={{ width: `${(c.aggregateScore / maxAgg) * 100}%` }} />
                  </div>
                  <span className="font-mono p-text-3 tabular-nums shrink-0 w-10 text-right">{c.aggregateScore.toFixed(2)}</span>
                  <span className="hidden sm:inline font-mono p-text-3 tabular-nums shrink-0 w-20 text-right opacity-70">[{ci.lo.toFixed(2)}–{ci.hi.toFixed(2)}]</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Quality scoreboard ────────────────────────────────────────── */

// The replay-eval loss curve (getReplayEvals): the live scaffold re-scored
// against graded turns over time. Each row is tagged with the scaffold_version
// it ran under, so version changes mark before-vs-after-evolution boundaries.
interface ReplayEvalRow {
  id: string; ranAt: number; sampleSize: number;
  acceptedCount: number; negativeCount: number;
  meanScore: number; loss: number; scaffoldVersion: number | null;
  /** 95% interval on meanScore — a dozen judge verdicts is not a point. */
  interval: ScoreInterval;
}

// A reported score is never shown alone: the 95% interval sits under it, at
// the sample sizes these runs use it is the whole story.
function ScoreWithInterval({ value, interval, className }: { value: number; interval: ScoreInterval; className?: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className={className}>{value.toFixed(3)}</span>
      <span className="text-[9px] p-text-3 tabular-nums">95% CI {interval.lo.toFixed(2)}–{interval.hi.toFixed(2)}</span>
    </span>
  );
}

// Both quality signals load together so the pane resolves once, rather than
// flashing an empty state while the second call is still in flight.
function QualityView({ rpc }: { rpc: Rpc }) {
  const load = useCallback(async () => {
    const [rows, align] = await Promise.all([
      rpc<ReplayEvalRow[]>("getReplayEvals", [50]),
      rpc<AlignmentConvergence>("getAlignmentConvergence"),
    ]);
    return { rows, align };
  }, [rpc]);
  const { resource, reload } = useAsyncResource(load);

  const data = lastValue(resource);
  if (data === null) {
    if (resource.status === "error") return <LoadFailure what="the quality history" message={resource.message} onRetry={reload} />;
    return <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }
  const { rows, align } = data;
  const hasAlignment = align.overall.turns > 0;
  if (rows.length === 0 && !hasAlignment) return <EmptyState icon={<GaugeIcon size={28} />} title="No quality history yet" hint="Replay-eval runs (fired by lifetime evolution; browsable via agent.replayEvals) re-score the live scaffold against graded turns. The loss curve, K_align, and latest aggregate appear here." />;

  return (
    <div className="space-y-4 animate-fade-in overflow-y-auto h-full">
      {hasAlignment && <AlignmentPanel k={align} />}
      {rows.length > 0 && <ReplayEvalPanel rows={rows} />}
    </div>
  );
}

function ReplayEvalPanel({ rows }: { rows: ReplayEvalRow[] }) {
  const chrono = [...rows].reverse(); // oldest → newest for the curve
  const latest = rows[0];
  const latestLoss = lossInterval(latest.interval);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric label="Latest score" value={<ScoreWithInterval value={latest.meanScore} interval={latest.interval} className={scoreColor(latest.meanScore)} />} />
        <Metric label="Loss" value={<ScoreWithInterval value={latest.loss} interval={latestLoss} />} />
        <Metric label="Sample" value={`${latest.sampleSize} (${latest.acceptedCount}✓ / ${latest.negativeCount}✗)`} />
        <Metric label="Scaffold" value={latest.scaffoldVersion ?? "—"} />
      </div>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-normal p-text-3">Mean score over time</div>
          <div className="text-[10px] p-text-3">floor {DEFAULT_QUALITY_THRESHOLD.toFixed(2)}</div>
        </div>
        <QualitySparkline points={chrono} threshold={DEFAULT_QUALITY_THRESHOLD} />
      </section>

      <section className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-normal p-text-3">Recent runs</div>
        <div className="space-y-1">
          {rows.map((r, i) => {
            const prev = rows[i + 1]; // next-oldest
            const evolved = prev != null && prev.scaffoldVersion !== r.scaffoldVersion;
            return (
              <div key={r.id} className="flex items-center gap-2 text-[10px]">
                <span className="p-text-3 shrink-0 w-16 truncate">{new Date(r.ranAt).toLocaleDateString()}</span>
                {r.scaffoldVersion != null && (
                  <span className={`shrink-0 font-mono ${evolved ? "p-accent" : "p-text-3"}`} title={evolved ? "scaffold evolved" : undefined}>v{r.scaffoldVersion}{evolved ? "↑" : ""}</span>
                )}
                <div className="flex-1 h-2 rounded-full p-elevated overflow-hidden" title={`95% CI ${r.interval.lo.toFixed(2)}–${r.interval.hi.toFixed(2)} over ${r.sampleSize} turns`}>
                  <div className={`h-full ${r.meanScore >= 0.7 ? "p-dot-success" : r.meanScore >= 0.4 ? "p-dot-warning" : "p-dot-danger"}`} style={{ width: `${Math.max(0, Math.min(1, r.meanScore)) * 100}%` }} />
                </div>
                <span className="font-mono p-text-3 tabular-nums shrink-0 w-10 text-right">{r.meanScore.toFixed(2)}</span>
                <span className="hidden sm:inline font-mono p-text-3 tabular-nums shrink-0 w-20 text-right opacity-70">[{r.interval.lo.toFixed(2)}–{r.interval.hi.toFixed(2)}]</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ── K_align (Alignment Convergence Rate) ──────────────────────── */

// How often the user had to correct the agent, per 100 graded turns, split by
// the scaffold version that served them — computed from the turn_outcomes
// ledger alone (no benchmark, no judge). Every rate is shown WITH its 95%
// Wilson interval, and a segment whose interval is too wide to read is drawn
// muted, because the point of this panel is to stop small numbers being
// over-read as progress.
const TREND_STYLE: Record<AlignmentConvergence["trend"], { label: string; className: string }> = {
  improving: { label: "improving", className: "p-success" },
  worsening: { label: "worsening", className: "p-danger" },
  flat: { label: "no detectable change", className: "p-text-2" },
  insufficient: { label: "not enough data", className: "p-text-3" },
};

function AlignmentPanel({ k }: { k: AlignmentConvergence }) {
  const trend = TREND_STYLE[k.trend];
  // One shared scale so segment intervals are visually comparable; the floor
  // keeps a near-zero rate from filling the whole track.
  const scaleMax = Math.max(20, ...k.segments.map((s) => s.rate.highPer100));
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] uppercase tracking-normal p-text-3">K_align · corrections per 100 turns</div>
        <div className={`text-[10px] ${trend.className}`}>
          {trend.label}{k.deltaPer100 !== null ? ` (${k.deltaPer100 > 0 ? "+" : ""}${k.deltaPer100.toFixed(1)})` : ""}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Metric label="Rate" value={`${k.overall.rate.per100.toFixed(1)}`} />
        <Metric label="95% interval" value={`${k.overall.rate.lowPer100.toFixed(1)}–${k.overall.rate.highPer100.toFixed(1)}`} />
        <Metric label="Graded turns" value={`${k.overall.turns}${k.overall.abandoned > 0 ? ` (+${k.overall.abandoned} ungraded)` : ""}`} />
      </div>
      <div className="space-y-1">
        {k.segments.map((s) => (
          <div key={`${s.scaffoldVersion ?? "none"}-${s.firstAt}`}
            className={`flex items-center gap-2 text-[10px] ${s.rate.reliable ? "" : "opacity-50"}`}
            title={s.rate.reliable ? undefined : "interval too wide to read as a rate"}>
            <span className="shrink-0 font-mono p-text-3 w-8">v{s.scaffoldVersion ?? "?"}</span>
            <span className="shrink-0 p-text-3 w-12 tabular-nums">n={s.turns}</span>
            <div className="flex-1 h-2 rounded-full p-elevated relative overflow-hidden">
              <div className="absolute inset-y-0 p-dot-info opacity-40" style={{
                left: `${(s.rate.lowPer100 / scaleMax) * 100}%`,
                width: `${Math.max(1, ((s.rate.highPer100 - s.rate.lowPer100) / scaleMax) * 100)}%`,
              }} />
              <div className="absolute inset-y-0 w-0.5 p-dot-info" style={{ left: `${(s.rate.per100 / scaleMax) * 100}%` }} />
            </div>
            <span className="font-mono p-text-3 tabular-nums shrink-0 w-8 text-right">{s.rate.per100.toFixed(1)}</span>
          </div>
        ))}
      </div>
      <div className="text-[10px] p-text-3">{k.note}</div>
    </section>
  );
}

// Inline SVG mean-score curve with a dashed quality-floor reference. Points are
// coloured by score band; the path uses a non-scaling stroke so it stays crisp
// under preserveAspectRatio="none".
function QualitySparkline({ points, threshold }: { points: ReplayEvalRow[]; threshold: number }) {
  const W = 100, H = 32, pad = 2;
  const n = points.length;
  const x = (i: number) => n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (score: number) => pad + (1 - Math.max(0, Math.min(1, score))) * (H - 2 * pad);
  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.meanScore).toFixed(2)}`).join(" ");
  // The 95% band the means sit inside — drawn so the curve can't be read as
  // more precise than it is.
  const band = [
    ...points.map((p, i) => `${x(i).toFixed(2)},${y(p.interval.hi).toFixed(2)}`),
    ...[...points].reverse().map((p, i) => `${x(points.length - 1 - i).toFixed(2)},${y(p.interval.lo).toFixed(2)}`),
  ].join(" ");
  const floorY = y(threshold).toFixed(2);
  const dotColor = (s: number) => s >= 0.7 ? "var(--c-success, #34d399)" : s >= 0.4 ? "var(--c-warning, #fbbf24)" : "var(--c-danger, #f87171)";
  return (
    <div className="rounded-lg border p-border p-surface p-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-24">
        <line x1={pad} y1={floorY} x2={W - pad} y2={floorY} stroke="var(--c-text-3, #888)" strokeWidth={0.4} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" opacity={0.6} />
        {n > 1 && <polygon points={band} fill="var(--c-accent, #38bdf8)" opacity={0.14} />}
        {n > 1 && <polyline points={line} fill="none" stroke="var(--c-accent, #38bdf8)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        {points.map((p, i) => (
          <circle key={p.id} cx={x(i)} cy={y(p.meanScore)} r={1.4} fill={dotColor(p.meanScore)} vectorEffect="non-scaling-stroke">
            <title>{`${new Date(p.ranAt).toLocaleString()} · score ${p.meanScore.toFixed(3)} (95% CI ${p.interval.lo.toFixed(2)}–${p.interval.hi.toFixed(2)}) · loss ${p.loss.toFixed(3)}${p.scaffoldVersion != null ? ` · scaffold v${p.scaffoldVersion}` : ""}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
