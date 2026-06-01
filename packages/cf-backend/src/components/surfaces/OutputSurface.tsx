/**
 * Output surface — what the agent PRODUCED. Two views: the live app Preview
 * (exposePort, promoted out of the buried Executors card) and the cumulative
 * Workspace Diff (the change-set since the baseline — code/docs/data the agent
 * wrote, reviewable, with "mark reviewed" to re-baseline). Generic artifact
 * viewers (media/reports) layer in here over time.
 */
import { useState, useEffect, useCallback } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { MonitorIcon, ArrowSquareOutIcon, GitDiffIcon, CheckIcon, CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { Rpc } from "@/lib/protocol";
import type { FileDiff } from "@/lib/diff";
import { EmptyState, EMPTY_HINTS, DiffLines } from "./shared";

export interface PinnedPort { port: number; url: string; name?: string }

export interface OutputSurfaceProps {
  pinnedPorts: PinnedPort[];
  rpc: Rpc;
}

export function OutputSurface({ pinnedPorts, rpc }: OutputSurfaceProps) {
  const [view, setView] = useState<"preview" | "diff">(pinnedPorts.length > 0 ? "preview" : "diff");
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
        {view === "preview" ? <PreviewView pinnedPorts={pinnedPorts} /> : <DiffView rpc={rpc} />}
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
      <div className="flex items-center gap-2 px-3 py-1.5 border-b p-border text-xs shrink-0">
        <span className="text-emerald-400 text-[10px]">● live</span>
        <span className="font-mono p-text-2">{port.name ?? `port ${port.port}`}</span>
        <a href={port.url} target="_blank" rel="noopener noreferrer" className="ml-auto p-accent hover:opacity-80 flex items-center gap-1" title="Open in new tab">
          <span className="text-[10px]">open</span><ArrowSquareOutIcon size={11} />
        </a>
      </div>
      <iframe src={port.url} title={`preview-${port.port}`} className="flex-1 w-full bg-white" />
    </div>
  );
}

/* ── Cumulative workspace diff ─────────────────────────────────── */

const STATUS_TONE: Record<string, string> = {
  added: "text-emerald-400",
  removed: "text-red-400",
  changed: "text-amber-400",
};

function DiffView({ rpc }: { rpc: Rpc }) {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    rpc<{ files: FileDiff[]; baselineJustCaptured: boolean }>("getWorkspaceDiff", [])
      .then((r) => setFiles(r.files)).catch(() => setFiles([]));
  }, [rpc]);
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

  if (files === null) return <div className="flex justify-center py-8"><Loader size="sm" /></div>;

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="flex items-center gap-2 mb-3">
        <GitDiffIcon size={14} className="p-text-2" />
        <span className="text-sm font-medium p-text">Workspace changes</span>
        {files.length > 0 && <Badge variant="secondary">{files.length}</Badge>}
        {files.length > 0 && (
          <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={markReviewed}
            icon={busy ? <Loader size="sm" /> : <CheckIcon size={12} />}>Mark reviewed</Button>
        )}
      </div>
      {files.length === 0 ? (
        <EmptyState icon={<GitDiffIcon size={28} />} title="No changes since baseline"
          hint="Files the agent creates or edits appear here as a reviewable change-set. “Mark reviewed” re-baselines." />
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
