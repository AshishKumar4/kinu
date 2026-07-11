/**
 * Output surface — what the agent PRODUCED. Two views: the live app Preview
 * (exposePort, promoted out of the buried Executors card) and the cumulative
 * Workspace Diff (the change-set since the baseline — code/docs/data the agent
 * wrote, reviewable, with "mark reviewed" to re-baseline). Generic artifact
 * viewers (media/reports) layer in here over time.
 */
import { useState, useEffect, useCallback } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { MonitorIcon, GitDiffIcon, CheckIcon, CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { Rpc } from "@/lib/protocol";
import type { FileDiff } from "@/lib/diff";
import { pickDefaultExecutor } from "@/lib/executor-default";
import { PreviewFrame } from "@/components/PreviewFrame";
import { EmptyState, EMPTY_HINTS, DiffLines } from "./shared";

export interface PinnedPort { port: number; url: string; name?: string }
export interface ExecutorInfo {
  name: string;
  kind: string;
  capabilities: string[];
  available: boolean;
  configured?: boolean;
  active?: boolean;
  status?: "not_configured" | "idle" | "active" | "disconnected" | "error";
  reason?: string;
}

export interface OutputSurfaceProps {
  pinnedPorts: PinnedPort[];
  executors: ExecutorInfo[];
  lastActiveExecutor?: string | null;
  rpc: Rpc;
}

export function OutputSurface({ pinnedPorts, executors, lastActiveExecutor, rpc }: OutputSurfaceProps) {
  const [view, setView] = useState<"preview" | "diff">(pinnedPorts.length > 0 ? "preview" : "diff");
  useEffect(() => {
    if (pinnedPorts.length > 0) setView("preview");
  }, [pinnedPorts.length]);
  return (
    <div className="h-full flex flex-col -m-5">
      <div className="flex items-center gap-1 px-3 py-1.5 border-b p-border shrink-0">
        {(["preview", "diff"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-2.5 py-1 text-[11px] rounded-md capitalize transition-colors flex items-center gap-1.5 ${view === v ? "p-elevated p-text font-medium" : "p-text-3 hover:p-text-2"}`}>
            {v === "preview" ? <MonitorIcon size={12} /> : <GitDiffIcon size={12} />}{v}
            {v === "preview" && pinnedPorts.length > 0 && <span className="size-1.5 rounded-full bg-emerald-500" />}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {view === "preview" ? <PreviewView pinnedPorts={pinnedPorts} /> : <DiffView executors={executors} lastActiveExecutor={lastActiveExecutor} rpc={rpc} />}
      </div>
    </div>
  );
}

/* ── Live preview ──────────────────────────────────────────────── */

function PreviewView({ pinnedPorts }: { pinnedPorts: PinnedPort[] }) {
  const [active, setActive] = useState(0);
  if (pinnedPorts.length === 0) {
    return <div className="p-5"><EmptyState icon={<MonitorIcon size={28} />} title="No live output yet" hint={EMPTY_HINTS.preview} /></div>;
  }
  const idx = Math.min(active, pinnedPorts.length - 1);
  const port = pinnedPorts[idx]!;
  return (
    <div className="flex flex-col h-full">
      {pinnedPorts.length > 1 && (
        <div className="flex items-center gap-1 px-2 pt-2 border-b p-border">
          {pinnedPorts.map((p, i) => (
            <button key={p.port} onClick={() => setActive(i)}
              className={`px-2.5 py-1 text-[11px] rounded-t-md border-b -mb-px transition-colors ${i === idx ? "p-tab-active border-b-[1.5px]" : "p-text-3 border-transparent hover:p-text-2"}`}>
              {p.name ?? `:${p.port}`}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <PreviewFrame url={port.url} label={`:${port.port}${port.name ? ` · ${port.name}` : ""}`} />
      </div>
    </div>
  );
}

/* ── Cumulative workspace diff ─────────────────────────────────── */

const STATUS_TONE: Record<string, string> = {
  added: "text-emerald-400",
  removed: "text-red-400",
  changed: "text-amber-400",
};

interface DiffResult {
  files: FileDiff[];
  mode: "git" | "vfs-baseline";
  baselineJustCaptured?: boolean;
  notGitRepo?: boolean;
  error?: string;
}

const EXECUTOR_LABELS: Record<string, string> = { sandbox: "Sandbox", laptop: "Your PC", workspace: "Workspace state", nimbus: "Nimbus" };
const EXECUTOR_ORDER = ["laptop", "nimbus", "sandbox", "workspace"];

function executorSortKey(name: string): number {
  const idx = EXECUTOR_ORDER.indexOf(name);
  return idx === -1 ? 99 : idx;
}

function isVisibleDiffDevice(exec: ExecutorInfo): boolean {
  if (exec.name === "workspace") return false;
  if (!exec.available) return false;
  if (exec.name === "laptop") return true;
  return exec.active === true || exec.status === "active";
}

function DiffView({ executors, lastActiveExecutor, rpc }: { executors: ExecutorInfo[]; lastActiveExecutor?: string | null; rpc: Rpc }) {
  const [result, setResult] = useState<DiffResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Selector options: available execution devices first, internal state VFS last.
  const availableDevices = executors
    .filter(isVisibleDiffDevice)
    .sort((a, b) => executorSortKey(a.name) - executorSortKey(b.name) || a.name.localeCompare(b.name))
    .map((e) => e.name);
  const options = Array.from(new Set([...availableDevices, "workspace"]));
  const pickVisibleDefault = useCallback(() => {
    const preferred = pickDefaultExecutor(executors, lastActiveExecutor);
    return options.includes(preferred) ? preferred : options[0] ?? "workspace";
  }, [executors, lastActiveExecutor, options]);
  const [exec, setExec] = useState(pickVisibleDefault);

  // If the selected executor disappears, fall back to a sensible default.
  useEffect(() => {
    if (!options.includes(exec)) {
      setExec(pickVisibleDefault());
    }
  }, [exec, options, pickVisibleDefault]);

  const load = useCallback(() => {
    setResult(null);
    rpc<DiffResult>("getExecutorDiff", [exec])
      .then(setResult)
      .catch(() => setResult({ files: [], mode: "git", error: "failed to load diff" }));
  }, [rpc, exec]);
  useEffect(() => { load(); }, [load]);

  const markReviewed = useCallback(async () => {
    setBusy(true);
    try { await rpc("resetWorkspaceBaseline", []); setExpanded(new Set()); load(); } finally { setBusy(false); }
  }, [rpc, load]);

  const toggle = (path: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const files = result?.files ?? [];

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="flex items-center gap-2 mb-3">
        <GitDiffIcon size={14} className="p-text-2" />
        <span className="text-sm font-medium p-text">{result?.mode === "vfs-baseline" ? "Workspace changes" : "Uncommitted changes"}</span>
        {files.length > 0 && <Badge variant="secondary">{files.length}</Badge>}
        {result?.mode === "vfs-baseline" && files.length > 0 && (
          <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={markReviewed}
            icon={busy ? <Loader size="sm" /> : <CheckIcon size={12} />}>Mark reviewed</Button>
        )}
      </div>

      {options.length > 1 && (
        <div className="flex items-center gap-1 mb-3">
          {options.map((name) => (
            <button key={name} onClick={() => setExec(name)}
              className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${
                exec === name
                  ? "p-elevated p-text font-medium"
                  : name === "workspace"
                    ? "p-text-3 hover:p-text-2 opacity-80"
                    : "p-text-3 hover:p-text-2"
              }`}>
              {EXECUTOR_LABELS[name] ?? name}
            </button>
          ))}
        </div>
      )}

      {result === null ? (
        <div className="flex justify-center py-8"><Loader size="sm" /></div>
      ) : result.error ? (
        <div className="text-xs text-red-400 border border-red-400/40 rounded-md px-3 py-2">{result.error}</div>
      ) : result.notGitRepo ? (
        <EmptyState icon={<GitDiffIcon size={28} />} title="Not a git repository"
          hint={`${EXECUTOR_LABELS[exec] ?? exec}'s /workspace isn't a git repo, so changes can't be tracked here. Have the agent run "git init" there, or switch to Workspace state.`} />
      ) : files.length === 0 ? (
        <EmptyState icon={<GitDiffIcon size={28} />} title="No changes"
          hint={result.mode === "vfs-baseline"
            ? "Files the agent creates or edits appear here as a reviewable change-set. “Mark reviewed” re-baselines."
            : "Uncommitted changes the agent makes in this device's /workspace appear here (git diff)."} />
      ) : (
        <div className="space-y-1.5">
          {files.map((f) => {
            const open = expanded.has(f.path);
            return (
              <div key={f.path} className="rounded-md border p-border overflow-hidden">
                <button onClick={() => toggle(f.path)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:p-card transition-colors">
                  {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
                  <span className={`text-[10px] uppercase font-mono shrink-0 ${STATUS_TONE[f.status]}`}>{f.status[0]}</span>
                  <span className="text-xs font-mono p-text truncate flex-1">{f.path}</span>
                  {f.added > 0 && <span className="text-[10px] text-emerald-400 shrink-0">+{f.added}</span>}
                  {f.removed > 0 && <span className="text-[10px] text-red-400 shrink-0">−{f.removed}</span>}
                </button>
                {open && <div className="border-t p-border"><DiffLines lines={f.lines} /></div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
