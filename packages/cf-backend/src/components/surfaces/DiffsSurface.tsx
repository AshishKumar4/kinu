import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { GitDiffIcon, CheckIcon, CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { Rpc } from "@kinu.run/core";
import type { FileDiff } from "@kinu.run/core";
import { executorLabel, executorSortKey, isActiveExecutionDevice, pickDefaultExecutor, type ExecutorInfo } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { describeError, lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useToggledSet } from "@/hooks/use-toggled-set";
import { EmptyState, DiffLines } from "./shared";

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
  hasChanges: boolean;
}

export function DiffsSurface({ executors, lastActiveExecutor, rpc, onPresence }: {
  executors: ExecutorInfo[];
  lastActiveExecutor?: string | null;
  rpc: Rpc;
  onPresence: (present: boolean) => void;
}) {
  const { set: expanded, toggle, clear: clearExpanded } = useToggledSet();
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const availableDevices = executors
    .filter(isActiveExecutionDevice)
    .sort((a, b) => executorSortKey(a.name) - executorSortKey(b.name) || a.name.localeCompare(b.name))
    .map((e) => e.name);

  const options = Array.from(new Set([...availableDevices, "workspace"]));
  const defaultExecutor = pickDefaultExecutor(executors, lastActiveExecutor);
  const userSelected = useRef(false);
  const [exec, setExec] = useState(defaultExecutor);

  // Executor status arrives after mount: follow it until the user picks a chip.
  useEffect(() => {
    if (!userSelected.current && options.includes(defaultExecutor)) setExec(defaultExecutor);
  }, [defaultExecutor, options]);

  useEffect(() => {
    if (!options.includes(exec)) {
      userSelected.current = false;
      setExec(options.includes(defaultExecutor) ? defaultExecutor : "workspace");
    }
  }, [defaultExecutor, exec, options]);

  const executorKey = options.join("\n");

  const load = useCallback(async (): Promise<LoadedDiff> => {
    const rows = await Promise.all(executorKey.split("\n").map(async executor => ({ executor, result: await rpc<DiffResult>("getExecutorDiff", [executor]) })));
    const selected = rows.find(row => row.executor === exec);

    if (!selected) throw new Error("The selected change-set executor is unavailable");

    return { ...selected, hasChanges: rows.some(row => row.result.files.length > 0 || Boolean(row.result.error)) };
  }, [rpc, exec, executorKey]);

  const revalidate = useCallback(() => 2_000, []);
  const { resource, reload } = useAsyncResource(load, revalidate);
  const loaded = lastValue(resource);
  const result = loaded?.executor === exec ? loaded.result : null;

  // A failed re-baseline must surface; otherwise the user believes the baseline moved.
  const markReviewed = useCallback(async () => {
    setBusy(true);
    setActionErr(null);

    try { await rpc("resetWorkspaceBaseline", []); clearExpanded(); reload(); }
    catch (e) { setActionErr(`Could not mark reviewed: ${describeError({ cause: e })}`); }
    finally { setBusy(false); }
  }, [rpc, reload, clearExpanded]);

  const files = result?.files ?? [];
  useEffect(() => { onPresence(loaded?.hasChanges === true || resource.status === "error" || Boolean(result?.error)); }, [loaded?.hasChanges, resource.status, result?.error, onPresence]);
  let notice: ReactNode = null;

  if (result === null && resource.status === "error") {
    notice = <LoadFailure what="the change-set" message={resource.message} onRetry={reload} />;
  } else if (result === null) {
    notice = <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  } else if (result.error) {
    notice = <div className="text-xs p-notice-danger rounded-md px-3 py-2">{result.error}</div>;
  } else if (result.notGitRepo === true) {
    notice = <EmptyState icon={<GitDiffIcon size={28} />} title="Not a git repository" />;
  } else if (files.length === 0) {
    notice = <EmptyState icon={<GitDiffIcon size={28} />} title="No diffs yet" />;
  }

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
          {options.map((name) => {
            const unselected = name === "workspace" ? "p-text-3 hover:p-text-2 opacity-80" : "p-text-3 hover:p-text-2";

            return (
              <button key={name} onClick={() => { userSelected.current = true; setExec(name); }}
                className={`px-2 py-0.5 p-t-control rounded-md transition-colors ${exec === name ? "p-fill p-text" : unselected}`}>
                {executorLabel(name)}
              </button>
            );
          })}
        </div>
      )}

      {actionErr && <div className="p-t-status p-danger mb-2">{actionErr}</div>}
      {result !== null && resource.status === "error" && (
        <LoadFailure what="the latest change-set" message={resource.message} onRetry={reload} className="mb-3" />
      )}

      {notice ?? (
        <div className="space-y-1.5">
          {files.map((f) => {
            const open = expanded.has(f.path);

            return (
              <div key={f.path} className="rounded-md border p-border overflow-hidden">
                <button onClick={() => toggle(f.path)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left p-card-hover transition-colors">
                  {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
                  <span className={`p-annotation uppercase shrink-0 ${STATUS_TONE[f.status]}`}>{f.status[0]}</span>
                  <span className="text-xs font-mono p-text truncate flex-1">{f.path}</span>
                  {f.added > 0 && <span className="p-meta p-success shrink-0">+{f.added}</span>}
                  {f.removed > 0 && <span className="p-meta p-danger shrink-0">−{f.removed}</span>}
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
