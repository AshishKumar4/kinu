/**
 * Output surface — what the agent PRODUCED. Two views: the live app Preview
 * (exposePort, promoted out of the buried Executors card) and the cumulative
 * Workspace Diff (the change-set since the baseline — code/docs/data the agent
 * wrote, reviewable, with "mark reviewed" to re-baseline). Generic artifact
 * viewers (media/reports) layer in here over time.
 */
import { lazy, Suspense, useState, useEffect, useCallback, useRef } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { MonitorIcon, GitDiffIcon, CheckIcon, CaretDownIcon, CaretRightIcon, NotePencilIcon } from "@phosphor-icons/react";
import type { Rpc } from "@/lib/protocol";
import { planReviewAwaitingDecision, type FileDiff, type PlanReview } from "@kinu.run/core";
import {
  executorLabel, executorSortKey, isActiveExecutionDevice, pickDefaultExecutor, type ExecutorInfo,
} from "@/lib/executors";
import { PreviewFrame } from "@/components/PreviewFrame";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { tabCls } from "@/components/ui/form";
import { describeError, lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState, EMPTY_HINTS, DiffLines } from "./shared";

export interface PinnedPort { executor: string; port: number; url: string; name?: string }

const PlanReviewView = lazy(() => import("./PlanReviewView"));

export interface OutputSurfaceProps {
  pinnedPorts: PinnedPort[];
  previewError: string | null;
  onRefreshPorts: () => void;
  executors: ExecutorInfo[];
  lastActiveExecutor?: string | null;
  plan: PlanReview | null;
  rpc: Rpc;
  planRpc?: Rpc;
}

type OutputView = "preview" | "diff" | "plan";

export function OutputSurface({
  pinnedPorts, previewError, onRefreshPorts, executors, lastActiveExecutor, plan, rpc, planRpc,
}: OutputSurfaceProps) {
  const [view, setView] = useState<OutputView>(plan ? "plan" : pinnedPorts.length > 0 ? "preview" : "diff");
  useEffect(() => {
    if (pinnedPorts.length > 0 && !planReviewAwaitingDecision(plan)) setView("preview");
  }, [pinnedPorts.length, plan?.status, plan?.handoffAccepted]);
  useEffect(() => {
    if (plan) setView("plan");
  }, [plan?.id, plan?.revision]);
  return (
    <div className="h-full flex flex-col -m-5">
      <div className="flex items-center gap-1 px-3 py-1.5 border-b p-border shrink-0">
        {(["preview", "diff", "plan"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-2.5 py-1 text-[11px] rounded-md capitalize transition-colors flex items-center gap-1.5 ${view === v ? "p-fill p-text font-medium" : "p-text-3 hover:p-text-2"}`}>
            {v === "preview" ? <MonitorIcon size={12} /> : v === "diff" ? <GitDiffIcon size={12} /> : <NotePencilIcon size={12} />}{v}
            {v === "preview" && pinnedPorts.length > 0 && <span className="size-1.5 rounded-full p-dot-success" />}
            {v === "plan" && plan?.status === "pending" && <span className="size-1.5 rounded-full p-dot-accent" />}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {view === "preview" ? <PreviewView pinnedPorts={pinnedPorts} error={previewError} onRetry={onRefreshPorts} />
          : view === "diff" ? <DiffView executors={executors} lastActiveExecutor={lastActiveExecutor} rpc={rpc} />
            : <Suspense fallback={<div className="h-full grid place-items-center"><Loader size="sm" /></div>}>
                <PlanReviewView plan={plan} rpc={planRpc ?? rpc} />
              </Suspense>}
      </div>
    </div>
  );
}

/* ── Live preview ──────────────────────────────────────────────── */

function PreviewView({ pinnedPorts, error, onRetry }: {
  pinnedPorts: PinnedPort[];
  error: string | null;
  onRetry: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const port = selectPreviewPort(pinnedPorts, activeId);
  const selectedId = port ? previewPortId(port) : null;
  useEffect(() => {
    if (activeId !== selectedId) setActiveId(selectedId);
  }, [activeId, selectedId]);
  if (pinnedPorts.length === 0) {
    if (error) return <div className="p-5"><LoadFailure what="live previews" message={error} onRetry={onRetry} /></div>;
    return <div className="p-5"><EmptyState icon={<MonitorIcon size={28} />} title="No live output yet" hint={EMPTY_HINTS.preview} /></div>;
  }
  if (!port) return null;
  return (
    <div className="flex flex-col h-full">
      {error && <LoadFailure what="all live previews" message={error} onRetry={onRetry} className="border-b p-border px-3 py-2" />}
      {pinnedPorts.length > 1 && (
        <div className="flex items-center px-2 border-b p-border">
          {pinnedPorts.map((p) => (
            <button key={previewPortId(p)} onClick={() => setActiveId(previewPortId(p))}
              className={`${tabCls} py-1.5 text-[11px] ${previewPortId(p) === selectedId ? "p-tab-active" : ""}`}>
              {p.name ?? `${executorLabel(p.executor)} · :${p.port}`}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <PreviewFrame url={port.url} label={`${executorLabel(port.executor)} · :${port.port}${port.name ? ` · ${port.name}` : ""}`} />
      </div>
    </div>
  );
}

export function previewPortId(port: Pick<PinnedPort, "executor" | "port">): string {
  return `${port.executor}:${port.port}`;
}

export function selectPreviewPort(
  ports: readonly PinnedPort[],
  activeId: string | null,
): PinnedPort | null {
  return (activeId === null ? null : ports.find((port) => previewPortId(port) === activeId))
    ?? ports[0]
    ?? null;
}

/* ── Cumulative workspace diff ─────────────────────────────────── */

const STATUS_TONE = {
  added: "p-success",
  removed: "p-danger",
  changed: "p-warning",
} satisfies Record<FileDiff["status"], string>;

interface DiffResult {
  files: FileDiff[];
  mode: "git" | "vfs-baseline";
  baselineJustCaptured?: boolean;
  notGitRepo?: boolean;
  error?: string;
}

interface LoadedDiff {
  executor: string;
  result: DiffResult;
}

function DiffView({ executors, lastActiveExecutor, rpc }: {
  executors: ExecutorInfo[];
  lastActiveExecutor?: string | null;
  rpc: Rpc;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Selector options: available execution devices first, internal state VFS last.
  const availableDevices = executors
    .filter(isActiveExecutionDevice)
    .sort((a, b) => executorSortKey(a.name) - executorSortKey(b.name) || a.name.localeCompare(b.name))
    .map((e) => e.name);
  const options = Array.from(new Set([...availableDevices, "workspace"]));
  const defaultExecutor = pickDefaultExecutor(executors, lastActiveExecutor);
  const userSelected = useRef(false);
  const [exec, setExec] = useState(defaultExecutor);

  // Executor status arrives after the surface mounts. Follow the place where
  // work actually happened until the user deliberately chooses another chip.
  useEffect(() => {
    if (!userSelected.current && options.includes(defaultExecutor)) setExec(defaultExecutor);
  }, [defaultExecutor, options]);

  // If the selected executor disappears, resume following the live default.
  useEffect(() => {
    if (!options.includes(exec)) {
      userSelected.current = false;
      setExec(options.includes(defaultExecutor) ? defaultExecutor : "workspace");
    }
  }, [defaultExecutor, exec, options]);

  const load = useCallback(async (): Promise<LoadedDiff> => ({
    executor: exec,
    result: await rpc<DiffResult>("getExecutorDiff", [exec]),
  }), [rpc, exec]);
  const revalidate = useCallback(() => 2_000, []);
  const { resource, reload } = useAsyncResource(load, revalidate);
  const loaded = lastValue(resource);
  const result = loaded?.executor === exec ? loaded.result : null;

  // Re-baselining is what "Mark reviewed" means: without a catch a failed
  // write left the button un-busying with the change-set still on screen,
  // while the user believed the baseline had moved.
  const markReviewed = useCallback(async () => {
    setBusy(true);
    setActionErr(null);
    try { await rpc("resetWorkspaceBaseline", []); setExpanded(new Set()); reload(); }
    catch (e) { setActionErr(`Couldn't mark reviewed: ${describeError(e)}`); }
    finally { setBusy(false); }
  }, [rpc, reload]);

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
            <button key={name} onClick={() => { userSelected.current = true; setExec(name); }}
              className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${
                exec === name
                  ? "p-fill p-text font-medium"
                  : name === "workspace"
                    ? "p-text-3 hover:p-text-2 opacity-80"
                    : "p-text-3 hover:p-text-2"
              }`}>
              {executorLabel(name)}
            </button>
          ))}
        </div>
      )}

      {actionErr && <div className="text-[11px] p-danger mb-2">{actionErr}</div>}
      {result !== null && resource.status === "error" && (
        <LoadFailure what="the latest change-set" message={resource.message} onRetry={reload} className="mb-3" />
      )}

      {result === null ? (
        resource.status === "error"
          ? <LoadFailure what="the change-set" message={resource.message} onRetry={reload} />
          : <div className="flex justify-center py-8"><Loader size="sm" /></div>
      ) : result.error ? (
        <div className="text-xs p-notice-danger rounded-md px-3 py-2">{result.error}</div>
      ) : result.notGitRepo ? (
        <EmptyState icon={<GitDiffIcon size={28} />} title="Not a git repository"
          hint={`${executorLabel(exec)}'s /workspace isn't a git repo, so changes can't be tracked here. Have the agent run "git init" there, or switch to ${executorLabel("workspace")}.`} />
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
                <button onClick={() => toggle(f.path)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left p-card-hover transition-colors">
                  {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
                  <span className={`text-[10px] uppercase font-mono shrink-0 ${STATUS_TONE[f.status]}`}>{f.status[0]}</span>
                  <span className="text-xs font-mono p-text truncate flex-1">{f.path}</span>
                  {f.added > 0 && <span className="text-[10px] p-success shrink-0">+{f.added}</span>}
                  {f.removed > 0 && <span className="text-[10px] p-danger shrink-0">−{f.removed}</span>}
                </button>
                {open && <div className="border-t p-border"><DiffLines lines={f.lines} truncated={f.truncated} /></div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
