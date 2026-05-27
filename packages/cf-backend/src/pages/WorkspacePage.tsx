import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useLocation, Link, useNavigate } from "react-router-dom";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { Button, Badge, Empty, InputArea, Loader } from "@cloudflare/kumo";
import { Code } from "@cloudflare/kumo/components/code";
import {
  PaperPlaneRightIcon, StopIcon, WrenchIcon, SparkleIcon,
  CaretDownIcon, CaretRightIcon, MagnifyingGlassIcon,
  FingerprintIcon, PackageIcon, DatabaseIcon, TreeStructureIcon,
  ClockIcon, WifiSlashIcon, ArrowsClockwiseIcon, BrainIcon,
  FolderOpenIcon, GitBranchIcon, CheckCircleIcon, TrashIcon,
  CopyIcon, TerminalIcon, GearIcon, ArrowSquareOutIcon,
  GearSixIcon, TimerIcon,
} from "@phosphor-icons/react";
import { ScoreBar } from "@/components/ui/score-bar";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProteus, type EvolutionEventRow, type LogEntry } from "@/hooks/use-proteus";
import { touchAgent } from "@/lib/user-api";
import { MCTSTree } from "@/components/mcts-tree";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ExecutorTerminal } from "@/components/ExecutorTerminal";
import { ConnectionIndicator } from "@/components/connection-indicator";
import type { MCTSNode } from "@/lib/protocol";

const TABS = ["Identity", "Tools", "Memory", "MCTS Tree", "Evolution", "Executors", "Logs"] as const;
type Tab = (typeof TABS)[number];
// MODELS are pulled dynamically from /api/user/models (which unions the
// connected providers' menus). The picker re-fetches on every page mount.

/* ── Code block ───────────────────────────────────────────────── */

function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, "");
  const lang = className?.replace(/^language-/, "") ?? "";
  return (
    <div className="relative group my-2">
      <div className="flex items-center justify-between px-3 py-1 rounded-t-lg p-elevated border border-b-0 p-border text-[10px] p-text-3">
        <span>{lang || "code"}</span>
        <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="flex items-center gap-1 hover:p-text transition-colors">
          <CopyIcon size={12} />{copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <div className="rounded-b-lg border border-t-0 p-border overflow-hidden">
        <Code language={lang || "text"} theme="auto">{code}</Code>
      </div>
    </div>
  );
}

/**
 * Detect a Proteus path-style preview URL anywhere inside a tool result.
 * Tool outputs are usually strings (e.g. `https://.../_preview/8080/.../`)
 * but can also be objects with a `url` field (the exposeSandboxPort RPC
 * returns `{url}`). Returns the URL or null.
 */
function extractPreviewUrl(output: unknown): string | null {
  const re = /https:\/\/[^\s"']+\/_preview\/\d+\/[^/\s"']+\/[a-z0-9_]+\/?[^\s"']*/i;
  if (typeof output === "string") {
    const m = output.match(re);
    return m ? m[0] : null;
  }
  if (output && typeof output === "object") {
    const url = (output as { url?: unknown }).url;
    if (typeof url === "string") {
      const m = url.match(re);
      return m ? m[0] : null;
    }
    // Last-resort: serialise + scan (covers nested fields).
    try {
      const m = JSON.stringify(output).match(re);
      return m ? m[0] : null;
    } catch { return null; }
  }
  return null;
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{
      code({ className, children, ...props }) {
        if (!className) return <code className="p-elevated px-1.5 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
        return <CodeBlock className={className}>{children}</CodeBlock>;
      },
      a({ href, children }) { return <a href={href} target="_blank" rel="noopener noreferrer" className="p-accent hover:underline">{children}</a>; },
      table({ children }) { return <div className="overflow-x-auto my-2"><table className="w-full text-xs border-collapse">{children}</table></div>; },
      th({ children }) { return <th className="border p-border px-2 py-1 text-left font-medium p-elevated">{children}</th>; },
      td({ children }) { return <td className="border p-border px-2 py-1">{children}</td>; },
      pre({ children }) { return <>{children}</>; },
    }}>{content}</Markdown>
  );
}

/* ── Message rendering ────────────────────────────────────────── */

function getMessageText(msg: UIMessage): string {
  return msg.parts.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("");
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function MessageTimestamp({ createdAt }: { createdAt?: string | number | Date }) {
  if (!createdAt) return null;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (isNaN(d.getTime())) return null;
  return <span className="text-[10px] p-text-3 mt-1 block">{formatTime(d)}</span>;
}

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="p-card rounded-lg px-3 py-2 my-1.5" style={{ borderLeftWidth: 2, borderLeftColor: "var(--c-accent)" }}>
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-xs text-purple-400/80 w-full text-left">
        <GearIcon size={12} className="shrink-0" />
        <span className="font-medium">Thinking</span>
        {expanded ? <CaretDownIcon size={12} className="ml-auto" /> : <CaretRightIcon size={12} className="ml-auto" />}
      </button>
      <div className={`mt-1 text-xs p-text-2 whitespace-pre-wrap ${!expanded ? "line-clamp-2" : ""}`}>
        {expanded ? text : text.length > 100 ? text.slice(0, 100) + "..." : text}
      </div>
    </div>
  );
}

function ToolCallBlock({ toolName, input, output, isRunning, isError }: {
  toolName: string; input?: Record<string, unknown>; output?: unknown; isRunning: boolean; isError: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const startTime = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    if (isRunning) {
      // Tool just started running — record the start time
      startTime.current = Date.now();
      wasRunning.current = true;
      setElapsed(null);
    } else if (wasRunning.current && startTime.current) {
      // Tool finished — we actually observed it running, so compute real duration
      setElapsed(Date.now() - startTime.current);
      wasRunning.current = false;
    }
    // If component mounts with isRunning=false and wasRunning is false,
    // we never observed the tool running — don't show any duration.
  }, [isRunning]);

  const durationLabel = elapsed !== null && elapsed > 100 ? `${(elapsed / 1000).toFixed(1)}s` : null;

  return (
    <div className="my-1.5">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-xs p-text-2 hover:p-text transition-colors">
        {isRunning ? <Loader size="sm" /> : isError ? <WrenchIcon size={12} className="text-red-400" /> : <CheckCircleIcon size={12} className="text-green-400" />}
        <span className="font-mono">{toolName}</span>
        {isRunning && <span className="text-amber-400/80 text-[11px]">running...</span>}
        {durationLabel && !isRunning && <span className="p-text-3 text-[10px] flex items-center gap-0.5"><TimerIcon size={10} />{durationLabel}</span>}
        {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
      </button>
      {expanded && (
        <div className="mt-1.5 ml-5 space-y-1 animate-scale-in">
          {input != null && <pre className="rounded-lg p-elevated border p-border p-2.5 text-xs font-mono p-text-2 max-h-40 overflow-auto">{JSON.stringify(input, null, 2)}</pre>}
          {output != null && <pre className="rounded-lg p-elevated border p-border p-2.5 text-xs font-mono p-text-2 max-h-40 overflow-auto whitespace-pre-wrap">{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

function MessageView({
  message, isLast, isStreaming, onFork,
}: {
  message: UIMessage;
  isLast: boolean;
  isStreaming: boolean;
  /** Called with the message id when user clicks "Fork from here". */
  onFork?: (messageId: string) => void;
}) {
  const isUser = message.role === "user";
  const isLive = isLast && isStreaming && !isUser;
  // Fork button disabled on the mid-stream last assistant — that message
  // isn't durably persisted yet.
  const canFork = !isLive && !!onFork && !!message.id;

  if (isUser) {
    return (
      <div className="flex flex-col items-end animate-fade-in group">
        <div className="relative max-w-[75%] px-4 py-3 rounded-2xl rounded-br-sm p-user-bubble text-sm leading-relaxed whitespace-pre-wrap">
          {getMessageText(message)}
          {canFork && (
            <button
              onClick={() => onFork!(message.id)}
              className="absolute -left-9 top-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px] p-text-3 hover:p-text px-1.5 py-0.5 rounded"
              title="Fork from here"
            >
              <GitBranchIcon size={12} />
            </button>
          )}
        </div>
        <MessageTimestamp createdAt={(message as { createdAt?: string }).createdAt} />
      </div>
    );
  }

  const hasContent = message.parts.some(p =>
    (p.type === "text" && (p as { text: string }).text) ||
    (p.type === "reasoning" && (p as { text?: string }).text) ||
    isToolUIPart(p)
  );

  if (isLive && !hasContent) {
    return (
      <div className="flex items-center gap-2 animate-fade-in py-2">
        <div className="flex gap-1">
          <span className="size-1.5 rounded-full bg-[var(--c-text-3)] animate-bounce [animation-delay:0ms]" />
          <span className="size-1.5 rounded-full bg-[var(--c-text-3)] animate-bounce [animation-delay:150ms]" />
          <span className="size-1.5 rounded-full bg-[var(--c-text-3)] animate-bounce [animation-delay:300ms]" />
        </div>
        <span className="text-xs p-text-3">Thinking...</span>
      </div>
    );
  }

  return (
    <div className="group relative max-w-[85%] space-y-1 animate-fade-in">
      {canFork && (
        <button
          onClick={() => onFork!(message.id)}
          className="absolute -right-9 top-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px] p-text-3 hover:p-text px-1.5 py-0.5 rounded"
          title="Fork from here"
        >
          <GitBranchIcon size={12} />
        </button>
      )}
      {message.parts.map((part, i) => {
        if (part.type === "reasoning") {
          const t = (part as { text?: string }).text;
          return t ? <ReasoningBlock key={i} text={t} /> : null;
        }
        if (part.type === "text") {
          const t = (part as { text: string }).text;
          if (!t) return null;
          const isLastText = message.parts.slice(i + 1).every(p => p.type !== "text");
          return (
            <div key={i} className="prose-chat p-text">
              <MarkdownContent content={t} />
              {isLive && isLastText && <span className="inline-block w-0.5 h-[1em] ml-0.5 align-text-bottom animate-blink-cursor" style={{ background: "var(--c-accent)" }} />}
            </div>
          );
        }
        if (isToolUIPart(part)) {
          const output = part.state === "output-available" ? (part as { output?: unknown }).output : undefined;
          const previewUrl = extractPreviewUrl(output);
          return (
            <div key={part.toolCallId}>
              <ToolCallBlock toolName={getToolName(part)}
                input={part.input as Record<string, unknown> | undefined}
                output={output}
                isRunning={part.state === "input-available" || part.state === "input-streaming"}
                isError={part.state === "output-error"} />
              {/* Inline preview card — when a tool returns a /_preview/ URL,
                  surface a live iframe under the tool block so the user
                  doesn't have to switch to the Executors tab.
                  (STABILITY-AUDIT §C4.) */}
              {previewUrl && (
                <div className="mt-2 rounded-md p-bg border p-border overflow-hidden">
                  <div className="px-2 py-1 flex items-center gap-2 text-[11px] p-text-2">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    <span className="font-mono truncate flex-1">{previewUrl}</span>
                    <a href={previewUrl} target="_blank" rel="noreferrer" className="ml-auto p-text-2 hover:underline">
                      open
                    </a>
                  </div>
                  <iframe src={previewUrl} className="w-full h-56 bg-white" title="preview" />
                </div>
              )}
            </div>
          );
        }
        return null;
      })}
      {!isLive && <MessageTimestamp createdAt={(message as { createdAt?: string }).createdAt} />}
    </div>
  );
}

/* ── Fork modal ───────────────────────────────────────────────── */

function ForkModal({
  sourceName, messagesUpToHere, craftedToolsCount, onCancel, onSubmit,
}: {
  sourceName: string;
  messagesUpToHere: number;
  craftedToolsCount: number;
  onCancel: () => void;
  /** Throws on RPC error so the modal can display it. */
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(name.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [name, busy, onSubmit]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl border p-border p-elevated p-5 space-y-4 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <GitBranchIcon size={18} className="p-accent" />
          <h3 className="text-base font-semibold p-text">Fork from here</h3>
        </div>
        <div className="text-xs p-text-2 leading-relaxed space-y-1.5">
          <p>Create a new agent that branches off of <span className="font-mono p-text">{sourceName}</span> at this message.</p>
          <ul className="list-disc list-inside space-y-0.5 p-text-3">
            <li>Copies: soul, {messagesUpToHere} message{messagesUpToHere === 1 ? "" : "s"}, memory, {craftedToolsCount} crafted tool{craftedToolsCount === 1 ? "" : "s"}</li>
            <li>Resets: MCTS tree, evolution events, scaffold, craft scores</li>
            <li>Source agent is unaffected</li>
          </ul>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] p-text-3 block">Fork name (optional)</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${sourceName}-fork-<6-char-id>`}
            disabled={busy}
            className="w-full px-3 py-1.5 rounded-md border p-border p-card text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]"
          />
          <p className="text-[10px] p-text-3">Allowed: A-Z, a-z, 0-9, _, -</p>
        </div>

        {err && (
          <div className="text-xs text-red-400 border border-red-400/40 rounded-md px-3 py-2" style={{ background: "rgba(248,113,113,0.08)" }}>
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={submit} disabled={busy}>
            {busy ? <><Loader size="sm" /><span className="ml-1">Forking…</span></> : "Fork"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Sidebar components ───────────────────────────────────────── */

const EVO_COLORS: Record<string, string> = {
  turn_complete: "bg-cyan-500", craft_discovered: "bg-green-500", mcts_complete: "bg-green-500",
  reflection: "bg-blue-500", consolidation: "bg-amber-500", scaffold_proposed: "bg-purple-500",
  mcts_started: "bg-gray-500",
};

function EvolutionItem({ event }: { event: EvolutionEventRow }) {
  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="flex flex-col items-center">
        <div className={`size-2 rounded-full mt-1.5 ${EVO_COLORS[event.type] ?? "bg-[var(--c-text-3)]"}`} />
        <div className="flex-1 w-px" style={{ background: "var(--c-border)" }} />
      </div>
      <div className="pb-4">
        <div className="flex items-center gap-2 text-xs p-text-2 mb-0.5">
          <span className="font-mono text-[11px]">{new Date(event.created_at).toLocaleTimeString()}</span>
          <Badge variant="secondary">{event.type}</Badge>
        </div>
        <span className="text-sm p-text block">{event.message}</span>
      </div>
    </div>
  );
}

const TIMESCALE_MAP: Record<string, "turn" | "session" | "lifetime"> = {
  turn_complete: "turn", reflection: "turn", craft_discovered: "turn",
  consolidation: "session",
  scaffold_proposed: "lifetime", mcts_complete: "lifetime", mcts_started: "lifetime",
};
const TIMESCALE_LABEL: Record<string, string> = { turn: "Turn", session: "Session", lifetime: "Lifetime" };
const TIMESCALE_BORDER: Record<string, string> = { turn: "border-l-blue-400", session: "border-l-amber-400", lifetime: "border-l-purple-400" };
type EvoFilter = "all" | "turn" | "session" | "lifetime";

function EvolutionTab({ events, onRefresh }: { events: EvolutionEventRow[]; onRefresh: () => void }) {
  const [filter, setFilter] = useState<EvoFilter>("all");
  const filtered = filter === "all" ? events : events.filter(e => TIMESCALE_MAP[e.type] === filter);

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ClockIcon size={14} className="p-text-2" />
          <span className="text-sm font-medium p-text">Evolution Timeline</span>
          {events.length > 0 && <Badge variant="secondary">{events.length}</Badge>}
        </div>
        <Button variant="secondary" size="sm" onClick={onRefresh}>Refresh</Button>
      </div>
      {events.length > 0 && (
        <div className="flex items-center gap-1 mb-3">
          {(["all", "turn", "session", "lifetime"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-2 py-1 text-[11px] rounded-md transition-colors ${filter === f ? "p-elevated p-text font-medium" : "p-text-3 hover:p-text-2"}`}>
              {f === "all" ? "All" : TIMESCALE_LABEL[f]}
            </button>
          ))}
        </div>
      )}
      {filtered.length === 0 ? (
        <EmptyTab icon={<SparkleIcon size={28} />} title={events.length === 0 ? "No evolution events yet" : "No events match filter"} hint={events.length === 0 ? EMPTY_HINTS.evolution : undefined} />
      ) : filtered.map(e => {
        const scale = TIMESCALE_MAP[e.type] ?? "turn";
        return (
          <div key={e.id} className={`flex gap-3 animate-fade-in border-l-2 ${TIMESCALE_BORDER[scale]} pl-3 mb-3`}>
            <div className="pb-1">
              <div className="flex items-center gap-2 text-xs p-text-2 mb-0.5">
                <span className="font-mono text-[11px]">{new Date(e.created_at).toLocaleTimeString()}</span>
                <Badge variant="secondary">{e.type}</Badge>
                <span className="text-[10px] p-text-3">{TIMESCALE_LABEL[scale]}</span>
              </div>
              <span className="text-sm p-text block">{e.message}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyTab({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="p-text-3 mb-3 opacity-60">{icon}</div>
      <p className="text-sm p-text-2">{title}</p>
      {hint && <p className="text-xs p-text-3 mt-1.5 max-w-xs leading-relaxed">{hint}</p>}
    </div>
  );
}

/* Default hints for each empty pane */
const EMPTY_HINTS: Record<string, string> = {
  memory: "Your agent will remember important information here. Ask it to remember something!",
  tools: "Tools your agent learns will appear here. They're extracted from successful conversations.",
  evolution: "Evolution events will appear as your agent improves over time through MCTS exploration.",
  mcts: "Exploration trees will appear when the agent uses the explore tool to investigate subproblems.",
  logs: "Activity from the agent's Durable Object will appear here.",
};

function MCTSTreeTab({ mctsTree }: { mctsTree: MCTSNode | null }) {
  const [selectedNode, setSelectedNode] = useState<MCTSNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 700, h: 400 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: Math.max(350, el.clientHeight - (selectedNode ? 200 : 0)) }));
    ro.observe(el); setDims({ w: el.clientWidth, h: Math.max(350, el.clientHeight - (selectedNode ? 200 : 0)) });
    return () => ro.disconnect();
  }, [selectedNode]);

  if (!mctsTree) return <EmptyTab icon={<GitBranchIcon size={28} />} title="No exploration history" hint={EMPTY_HINTS.mcts} />;
  function countN(n: MCTSNode): number { return 1 + n.children.reduce((s, c) => s + countN(c), 0); }
  function maxD(n: MCTSNode): number { return n.children.length === 0 ? n.depth : Math.max(...n.children.map(maxD)); }
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
                ["Avg Reward", <span className={scoreColor}>{selectedNode.value.toFixed(4)}</span>],
                ["UCT Score", isFinite(uct) ? uct.toFixed(4) : "\u221e"],
                ["Visits", selectedNode.visits],
                ["Status", selectedNode.status],
                ["Depth", selectedNode.depth],
                ["Children", selectedNode.children.length],
                ...(selectedNode.observation ? [["Observation", selectedNode.observation.slice(0, 80) + (selectedNode.observation.length > 80 ? "..." : "")]] : []),
              ] as [string, React.ReactNode][]).map(([k, v]) => (
                <div key={k} className="contents"><span className="p-text-2">{k}</span><span className="p-text font-mono">{typeof v === "string" || typeof v === "number" ? String(v) : v}</span></div>
              ));
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelSelector({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  const [models, setModels] = useState<Array<{ spec: string; label: string }>>([]);
  useEffect(() => {
    import("../lib/user-api").then(({ listAvailableModels }) => {
      listAvailableModels().then((m) => setModels(m.map((x) => ({ spec: x.spec, label: x.label }))))
        .catch(() => setModels([]));
    });
  }, []);
  return (
    <select value={current} onChange={e => onChange(e.target.value)}
      className="text-[11px] p-elevated border p-border rounded-md px-1.5 py-1 p-text focus:outline-none">
      {models.length === 0 && <option value="">(no providers connected)</option>}
      {models.map(m => <option key={m.spec} value={m.spec}>{m.label}</option>)}
    </select>
  );
}

/* ── Executors tab ──────────────────────────────────────────────── */

interface ExecutorOutput {
  id: string; command: string; stdout: string; stderr: string; exit_code: number; created_at: number;
}

// Executor-name → display-name map. "workspace" was a confusing label to users
// (they expected a code editor), and "laptop" is friendlier as "Your PC".
const EXECUTOR_LABELS: Record<string, string> = {
  workspace: "Local",
  sandbox: "Sandbox",
  nimbus: "Nimbus",
  laptop: "Your PC",
};

function labelFor(name: string): string {
  return EXECUTOR_LABELS[name] ?? name;
}

function ExecutorsTab({ executors, outputs, onExecute, onBrowse, agentName, rpc, pinnedPorts }: {
  executors: Array<{ name: string; kind: string; capabilities: string[]; available: boolean }>;
  outputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<unknown>;
  onBrowse: (id: string, path: string) => Promise<unknown>;
  agentName?: string;
  rpc: (method: string, args?: unknown[]) => Promise<unknown>;
  pinnedPorts: Array<{ port: number; url: string; name?: string }>;
}) {
  // Sandbox-first ordering. We show every executor (available or not) as a tab;
  // unavailable ones render a connection card instead of the terminal so the
  // user sees a clear "how do I enable this?" path.
  const ORDER = ["sandbox", "laptop", "workspace"];
  const sorted = [...executors].sort((a, b) => {
    const ia = ORDER.indexOf(a.name), ib = ORDER.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const [activeExec, setActiveExec] = useState(
    sorted.find(e => e.available)?.name ?? sorted[0]?.name ?? "sandbox",
  );
  const [fileEntries, setFileEntries] = useState<string[]>([]);
  const [filePath, setFilePath] = useState("/");
  const [pcInstall, setPcInstall] = useState<string | null>(null);
  const [pcIssuing, setPcIssuing] = useState(false);

  const activeExecInfo = sorted.find(e => e.name === activeExec);
  const activeExecAvailable = activeExecInfo?.available ?? false;

  // Terminal is an xterm component; it manages its own scroll.

  // pinnedPorts is now hoisted into useProteus and provided via props so the
  // Executors-tab badge updates regardless of which tab is active.
  // (STABILITY-AUDIT §C4.)

  const issuePcToken = useCallback(async () => {
    setPcIssuing(true);
    try {
      const r = await rpc("issuePcToken", []) as { installCommand?: string };
      if (r.installCommand) setPcInstall(r.installCommand);
    } finally {
      setPcIssuing(false);
    }
  }, [rpc]);

  const browseTo = useCallback(async (path: string) => {
    setFilePath(path);
    try {
      const result = await onBrowse(activeExec, path) as { entries?: unknown; error?: string };
      if (result.entries) {
        const entries = Array.isArray(result.entries) ? result.entries.map(String) : String(result.entries).split('\n').filter(Boolean);
        setFileEntries(entries);
      }
    } catch { setFileEntries(["(error loading files)"]); }
  }, [activeExec, onBrowse]);

  useEffect(() => { browseTo("/"); }, [activeExec]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeOutputs = outputs.get(activeExec) ?? [];

  return (
    <div className="animate-fade-in h-full flex flex-col gap-3">
      {/* Executor tabs — ALL executors, dot colour = availability */}
      <div className="flex items-center gap-1 flex-wrap">
        {sorted.map(exec => (
          <button key={exec.name} onClick={() => setActiveExec(exec.name)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeExec === exec.name ? "p-elevated p-text" : "p-text-2 hover:p-elevated/50"
            }`}
            title={exec.available ? `${exec.name} — connected` : `${exec.name} — not connected`}
          >
            <span className={`size-1.5 rounded-full ${exec.available ? "bg-green-500" : "bg-zinc-500"}`} />
            {labelFor(exec.name)}
          </button>
        ))}
      </div>

      {/* Not-available state: show a connection card instead of the terminal */}
      {!activeExecAvailable && activeExec === "laptop" && (
        <div className="flex-1 rounded-lg p-elevated border p-border p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium p-text">
            <TerminalIcon size={16} className="p-text-2" />
            Connect Your PC
          </div>
          <p className="text-xs p-text-2 leading-relaxed">
            Install the Proteus PC daemon to let this agent run commands on your local machine.
            The daemon opens one outbound WebSocket — no inbound ports required.
          </p>
          {!pcInstall ? (
            <button
              onClick={issuePcToken}
              disabled={pcIssuing}
              className="self-start px-3 py-1.5 rounded-lg text-xs font-medium p-bg-accent p-text-on-accent hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {pcIssuing ? "Generating…" : "Generate install command"}
            </button>
          ) : (
            <>
              <div className="rounded-md p-bg border p-border p-3 font-mono text-[11px] p-text select-all break-all leading-relaxed">
                {pcInstall}
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  onClick={() => { navigator.clipboard.writeText(pcInstall).catch(() => {}); }}
                  className="p-text-2 hover:p-text transition-colors"
                >
                  Copy
                </button>
                <button
                  onClick={issuePcToken}
                  className="p-text-3 hover:p-text-2 transition-colors"
                >
                  Regenerate (revokes previous)
                </button>
                <span className="ml-auto p-text-3">
                  Agent: <span className="font-mono p-text-2">{agentName ?? "?"}</span>
                </span>
              </div>
            </>
          )}
          <p className="text-[11px] p-text-3 mt-1">
            Paste the command in your terminal. Daemon runs as your user (never root).
            Token is one-shot — regenerating revokes the previous.
          </p>
        </div>
      )}
      {!activeExecAvailable && activeExec !== "laptop" && (
        <div className="flex-1 rounded-lg p-elevated border p-border p-4 flex flex-col gap-2">
          <div className="text-sm font-medium p-text">{labelFor(activeExec)} — not connected</div>
          <p className="text-xs p-text-2">
            This executor needs a binding in <span className="font-mono">wrangler.jsonc</span>. See
            <span className="font-mono"> docs/EXECUTION.md</span>.
          </p>
        </div>
      )}

      {/* Pinned previews — exposed ports from the sandbox show here */}
      {activeExecAvailable && pinnedPorts.length > 0 && (
        <div className="rounded-lg p-elevated border p-border p-2">
          <div className="text-xs font-medium p-text mb-2">Exposed ports</div>
          <div className="grid grid-cols-2 gap-2 max-h-64 overflow-auto">
            {pinnedPorts.map(p => (
              <div key={p.port} className="rounded-md p-bg border p-border overflow-hidden">
                <div className="px-2 py-1 flex items-center gap-2 text-[11px] p-text">
                  <span className="size-1.5 rounded-full bg-green-500" />
                  <span className="font-mono">:{p.port}</span>
                  <a href={p.url} target="_blank" rel="noreferrer" className="ml-auto p-text-2 hover:underline">
                    open
                  </a>
                </div>
                <iframe src={p.url} className="w-full h-48 bg-white" title={`port-${p.port}`} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Terminal + Files split (only when connected) */}
      <div className={`flex-1 flex gap-3 min-h-0 ${activeExecAvailable ? "" : "hidden"}`}>
        {/* Terminal — xterm.js */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <TerminalIcon size={14} className="p-text-2" />
            <span className="text-xs font-medium p-text">Terminal</span>
            <Badge variant="secondary">{activeOutputs.length}</Badge>
            <span className="ml-auto text-[10px] p-text-3">{activeExec}</span>
          </div>
          <div className="flex-1 min-h-[240px]">
            <ExecutorTerminal
              executor={activeExec}
              outputs={activeOutputs}
              onExecute={(cmd) => onExecute(activeExec, cmd)}
            />
          </div>
        </div>

        {/* File browser */}
        <div className="w-48 flex flex-col min-h-0">
          <div className="flex items-center gap-2 mb-2">
            <FolderOpenIcon size={14} className="p-text-2" />
            <span className="text-xs font-medium p-text">Files</span>
          </div>
          <div className="flex-1 overflow-y-auto rounded-lg p-elevated border p-border p-2 text-xs space-y-0.5">
            <button onClick={() => browseTo("/")} className="p-text-2 hover:p-text text-[11px] block mb-1">/</button>
            {filePath !== "/" && (
              <button onClick={() => browseTo(filePath.split("/").slice(0, -1).join("/") || "/")}
                className="p-text-3 hover:p-text text-[11px] block">..</button>
            )}
            {fileEntries.map((entry, i) => {
              const isDir = entry.startsWith("d ") || entry.endsWith("/");
              const name = entry.replace(/^[d-] /, "").replace(/\/$/, "");
              return (
                <button key={i}
                  onClick={() => isDir ? browseTo(`${filePath === "/" ? "" : filePath}/${name}`) : undefined}
                  className={`block w-full text-left truncate text-[11px] ${isDir ? "p-text hover:underline cursor-pointer" : "p-text-2"}`}
                >
                  {isDir ? "📁 " : "📄 "}{name}
                </button>
              );
            })}
            {fileEntries.length === 0 && <span className="p-text-3">(empty)</span>}
          </div>
        </div>
      </div>

    </div>
  );
}

function LogsTab({ logs, connectionStatus }: { logs: LogEntry[]; connectionStatus: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs.length]);
  // info = fast (<1s, green), tool = slow (1-5s, amber), error = very slow (>5s, red)
  const C: Record<string, string> = { connection: "bg-blue-500", tool: "bg-amber-500", evolution: "bg-purple-500", error: "bg-red-500", info: "bg-emerald-500" };
  return (
    <div className="animate-fade-in space-y-1">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="p-text-2" />
          <span className="text-sm font-medium p-text">Activity Log</span>
          <Badge variant="secondary">{logs.length}</Badge>
        </div>
        <ConnectionIndicator status={connectionStatus as "connected" | "connecting" | "disconnected" | "error"} />
      </div>
      {logs.length === 0 ? <EmptyTab icon={<TerminalIcon size={28} />} title="No activity yet" hint={EMPTY_HINTS.logs} /> : (
        <div className="space-y-1 max-h-[calc(100vh-200px)] overflow-y-auto">
          {logs.map(log => (
            <div key={log.id} className="rounded border p-border p-elevated px-2.5 py-1.5 text-xs font-mono">
              <div className="flex items-center gap-2">
                <span className={`size-1.5 rounded-full shrink-0 ${C[log.type] ?? "bg-gray-500"}`} />
                <span className="p-text-3">{new Date(log.time).toLocaleTimeString()}</span>
                <span className="p-text-2">{log.message}</span>
              </div>
              {log.detail && <p className="mt-0.5 ml-4 p-text-3">{log.detail}</p>}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

/* ── Main page ────────────────────────────────────────────────── */

export default function WorkspacePage() {
  const { agentId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useProteus(agentId);
  const [activeTab, setActiveTab] = useState<Tab>("Identity");
  const [chatInput, setChatInput] = useState("");
  const [memorySearch, setMemorySearch] = useState("");
  const [forkFor, setForkFor] = useState<string | null>(null); // message id to fork at, or null
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initialPromptSent = useRef(false);

  useEffect(() => { if (agentId) touchAgent(agentId).catch(() => {}); }, [agentId]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [state.messages]);

  useEffect(() => {
    if (initialPromptSent.current) return;
    const ns = location.state as { initialPrompt?: string; displayName?: string } | null;
    if (!ns?.initialPrompt || state.connectionStatus !== "connected") return;
    initialPromptSent.current = true;
    if (ns.displayName) state.rpc("setDisplayName", [ns.displayName]).catch(() => {});
    setTimeout(() => state.sendChat(ns.initialPrompt!), 300);
  }, [state.connectionStatus, location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(() => {
    const t = chatInput.trim(); if (!t || state.isStreaming) return;
    state.sendChat(t); setChatInput("");
  }, [chatInput, state]);

  // First-paint loading: only when we genuinely have nothing to show.
  // (STABILITY-AUDIT §A1 — never unmount on transient WS errors.)
  if (state.connectionStatus === "connecting" && !state.agentStatus) return (
    <div className="h-full flex items-center justify-center"><div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" /><span>Connecting...</span></div></div>
  );

  const as = state.agentStatus;
  return (
    <div className="h-full flex flex-col">
      {/* Non-destructive disconnect banner. The chat panel below stays
          mounted so the in-flight assistant turn is preserved through
          partysocket auto-reconnect. (STABILITY-AUDIT §A1.) */}
      {state.connectionStatus === "disconnected" && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs text-amber-300 border-b p-border" style={{ background: "var(--c-accent-subtle)" }}>
          <ArrowsClockwiseIcon size={12} className="animate-spin" />Reconnecting...
        </div>
      )}
      <PanelGroup className="flex-1">
        {/* ── Chat Panel ──────────────────────────────────────── */}
        <Panel minSize={30} defaultSize={42}>
          <div className="flex flex-col h-full border-r p-border">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b p-border">
              <div className="flex items-center gap-3">
                <ConnectionIndicator status={state.connectionStatus} />
                <span className="font-medium text-sm p-text truncate max-w-[180px]">{as?.displayName || agentId}</span>
                {state.isStreaming && <Badge variant="primary">streaming</Badge>}
                {as?.forkLineage && (
                  <Link
                    to={`/agent/${as.forkLineage.sourceAgentName}`}
                    className="flex items-center gap-1 text-[10px] p-text-3 hover:p-text transition-colors px-1.5 py-0.5 rounded border p-border"
                    title={`Forked from ${as.forkLineage.sourceAgentName} at message ${as.forkLineage.sourceMessageId} on ${new Date(as.forkLineage.forkedAt).toLocaleString()}`}
                  >
                    <GitBranchIcon size={10} />
                    <span className="font-mono">{as.forkLineage.sourceAgentName}</span>
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-2">
                <ModelSelector current={as?.model ?? ""} onChange={state.setModel} />
                {state.messages.length > 0 && (
                  <Button variant="ghost" shape="square" size="sm" onClick={state.clearHistory} icon={<TrashIcon size={12} />} aria-label="Clear" />
                )}
                <Link to={`/settings/${agentId}`} className="p-text-2 hover:p-text transition-colors" title="Settings">
                  <GearSixIcon size={14} />
                </Link>
                <Link to={`/mcts/${agentId}`} className="flex items-center gap-1 text-[11px] p-accent hover:opacity-80 transition-opacity">
                  <TreeStructureIcon size={12} />MCTS<ArrowSquareOutIcon size={10} />
                </Link>
              </div>
            </div>

            {/* Messages — generous padding for spacious feel.
                ErrorBoundary'd so a single malformed message doesn't
                whitescreen the chat. (STABILITY-AUDIT §D2.) */}
            <ErrorBoundary label="Chat">
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8">
              {state.messages.length === 0 && !state.isStreaming && (
                <div className="flex flex-col items-center justify-center h-full">
                  <BrainIcon size={36} className="p-text-3 mb-3" />
                  <p className="text-sm p-text-3">Send a message to start</p>
                </div>
              )}
              {state.messages.map((msg, i) => (
                <MessageView
                  key={msg.id}
                  message={msg}
                  isLast={i === state.messages.length - 1}
                  isStreaming={state.isStreaming}
                  onFork={(mid) => setForkFor(mid)}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
            </ErrorBoundary>

            {/* Input */}
            <div className="px-5 py-3 border-t p-border lg:px-7">
              {state.error && <div className="mb-2 text-xs text-red-400 p-card rounded-lg px-3 py-1.5">{state.error}</div>}
              <div className="flex items-end gap-3 p-card rounded-xl p-3 p-focus transition-all">
                <InputArea value={chatInput} onValueChange={setChatInput}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Send a message..." disabled={state.connectionStatus !== "connected"} rows={1}
                  className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none" />
                {state.isStreaming
                  ? <Button variant="secondary" shape="square" onClick={state.abortChat} icon={<StopIcon size={16} weight="fill" />} aria-label="Stop" className="mb-0.5" />
                  : <button onClick={handleSend} disabled={!chatInput.trim() || state.connectionStatus !== "connected"} className="p-btn rounded-lg p-2 mb-0.5 cursor-pointer" aria-label="Send"><PaperPlaneRightIcon size={16} /></button>}
              </div>
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="w-[3px] bg-[var(--c-border)] hover:bg-[var(--c-accent-subtle)] transition-colors cursor-col-resize" />

        {/* ── Right Panel ─────────────────────────────────────── */}
        <Panel minSize={25} defaultSize={58}>
          <div className="flex flex-col h-full">
            {/* Tabs — thin accent underline */}
            <div className="flex items-center border-b p-border px-2 gap-0.5">
              {TABS.map(tab => {
                // Show a port-count badge on the Executors tab so the user
                // knows a preview is ready even from another tab.
                // (STABILITY-AUDIT §C4.)
                const portCount = tab === "Executors" ? state.pinnedPorts.length : 0;
                return (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    className={`px-3 py-2.5 text-xs font-medium transition-colors border-b -mb-px flex items-center gap-1.5 ${
                      activeTab === tab ? "p-tab-active border-b-[1.5px]" : "p-text-2 border-transparent hover:p-text"
                    }`}>
                    <span>{tab}</span>
                    {portCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-semibold">
                        {portCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {/* Each tab is wrapped in its own ErrorBoundary keyed by tab
                  name so a render-time throw doesn't whitescreen the whole
                  workspace. The boundary resets on tab switch because the
                  key changes. (STABILITY-AUDIT §D2.) */}
              <ErrorBoundary key={activeTab} label={activeTab}>
              {/* Identity */}
              {activeTab === "Identity" && (as ? (
                <div className="space-y-4 animate-fade-in">
                  <div className="flex items-center gap-3 mb-5">
                    <div className="size-11 rounded-xl flex items-center justify-center p-elevated border p-border">
                      <FingerprintIcon size={22} className="p-accent" />
                    </div>
                    <div>
                      <div className="font-medium p-text">{as.name}</div>
                      <div className="text-[11px] p-text-3 font-mono">{as.id.slice(0, 20)}...</div>
                    </div>
                  </div>
                  <div className="space-y-0">
                    {([
                      ["Purpose", as.purpose],
                      ["Model", as.model],
                      ["Scaffold", `v${as.scaffoldVersion}`],
                      ["MCTS Nodes", String(as.searchNodeCount)],
                      ["Crafted Tools", String(as.craftedToolCount)],
                      ["Messages", String(as.messageCount)],
                      ["Created", new Date(as.createdAt).toLocaleString()],
                    ]).map(([l, v]) => (
                      <div key={l} className="flex items-center justify-between py-2.5 border-b p-border last:border-0">
                        <span className="text-sm p-text-2">{l}</span>
                        <span className="text-sm p-text max-w-[60%] text-right">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : <div className="flex items-center justify-center h-32"><Loader /></div>)}

              {/* Tools */}
              {activeTab === "Tools" && (
                <div className="space-y-2 animate-fade-in">
                  {state.tools.length === 0 ? (
                    <EmptyTab icon={<PackageIcon size={28} />} title="No tools discovered yet" hint={EMPTY_HINTS.tools} />
                  ) : state.tools.map(tool => {
                    const isLearned = tool.scope === "global";
                    return (
                      <div key={tool.name} className="p-card rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <PackageIcon size={13} className="p-accent" />
                          <span className="text-sm font-medium font-mono p-text">{tool.name}</span>
                          <Badge variant={isLearned ? "primary" : "secondary"}>
                            {isLearned ? "Learned" : "Built-in"}
                          </Badge>
                          {tool.usageCount > 0 && (
                            <span className="text-[10px] p-text-3 ml-auto">{tool.usageCount} uses</span>
                          )}
                        </div>
                        <span className="text-xs p-text-2 block leading-relaxed mb-1.5">{tool.description}</span>
                        {isLearned && <ScoreBar value={tool.qualityScore} className="mt-1" />}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Memory */}
              {activeTab === "Memory" && (
                <div className="space-y-3 animate-fade-in">
                  <div className="relative">
                    <MagnifyingGlassIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 p-text-3" />
                    <input value={memorySearch} onChange={e => { setMemorySearch(e.target.value); state.searchMemory(e.target.value); }}
                      placeholder="Search memory..." className="w-full rounded-lg border p-border p-elevated pl-9 pr-3 py-2 text-sm p-text focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)] placeholder:p-text-3 transition-all" />
                  </div>
                  {!memorySearch && state.memoryContent ? (
                    <div className="p-card rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <DatabaseIcon size={13} className="p-accent" />
                        <span className="text-xs font-mono p-accent">memory/MEMORY.md</span>
                        <span className="text-[10px] p-text-3 ml-auto">{state.memoryContent.length} chars</span>
                      </div>
                      <div className="prose-chat p-text max-h-[500px] overflow-y-auto">
                        <MarkdownContent content={state.memoryContent} />
                      </div>
                    </div>
                  ) : !memorySearch ? (
                    <EmptyTab icon={<FolderOpenIcon size={28} />} title="No memories yet" hint={EMPTY_HINTS.memory} />
                  ) : state.memory.length === 0 ? (
                    <EmptyTab icon={<MagnifyingGlassIcon size={28} />} title="No results" />
                  ) : state.memory.map((entry, i) => (
                    <div key={i} className="p-card rounded-lg p-3">
                      <span className="text-[11px] font-mono p-accent">{entry.updatedAt}</span>
                      <p className="text-xs p-text-2 line-clamp-4 whitespace-pre-wrap mt-1 leading-relaxed">{entry.content}</p>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "MCTS Tree" && <MCTSTreeTab mctsTree={state.mctsTree} />}

              {/* Evolution */}
              {activeTab === "Evolution" && (
                <EvolutionTab events={state.evolutionEvents} onRefresh={state.refreshEvolution} />
              )}

              {activeTab === "Executors" && (
                <ExecutorsTab
                  executors={state.executors}
                  outputs={state.executorOutputs}
                  onExecute={state.executeInExecutor}
                  onBrowse={(id: string, path: string) => state.rpc("getExecutorFiles", [id, path])}
                  agentName={agentId}
                  rpc={state.rpc}
                  pinnedPorts={state.pinnedPorts}
                />
              )}

              {activeTab === "Logs" && <LogsTab logs={state.logs} connectionStatus={state.connectionStatus} />}
              </ErrorBoundary>
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {forkFor && (
        <ForkModal
          sourceName={as?.displayName || agentId || ""}
          messagesUpToHere={state.messages.findIndex(m => m.id === forkFor) + 1}
          craftedToolsCount={as?.craftedToolCount ?? 0}
          onCancel={() => setForkFor(null)}
          onSubmit={async (name) => {
            try {
              const result = await state.forkAgent(forkFor, name ? { name } : undefined);
              setForkFor(null);
              navigate(result.url);
            } catch (err) {
              // Surface the error inside the modal — return string rejects.
              throw err instanceof Error ? err : new Error(String(err));
            }
          }}
        />
      )}
    </div>
  );
}
