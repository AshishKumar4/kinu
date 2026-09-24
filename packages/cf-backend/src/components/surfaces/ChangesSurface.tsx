import { useCallback, useEffect, useRef, useState } from "react";
import {
  executorLabel, executorSortKey, isActiveExecutionDevice, pickDefaultExecutor,
  workspacePath, type ChangeSet, type ExecutorDiffResult, type ExecutorInfo, type Rpc,
} from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { describeError, lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { ChangesPanel } from "./changes/ChangesPanel";
import { ReviewSheet } from "./changes/ReviewSheet";

function changeSetOf(source: string, result: ExecutorDiffResult): ChangeSet {
  const error = result.error ?? (result.notGitRepo === true ? "Its folder is not a git repository, so there is nothing to compare." : undefined);

  return { source, label: executorLabel(source), mode: result.mode, files: result.files, trackedSince: result.trackedSince, error };
}

function sourcesOf(executors: readonly ExecutorInfo[]): string[] {
  const devices = executors
    .filter(isActiveExecutionDevice)
    .sort((a, b) => executorSortKey(a.name) - executorSortKey(b.name) || a.name.localeCompare(b.name))
    .map((executor) => executor.name);

  return Array.from(new Set(["workspace", ...devices]));
}

/** Null keeps the tab away; 0 keeps it without a number, for a failed read. */
function countOf(sets: readonly ChangeSet[] | null, failed: boolean, shown: number): number | null {
  if (sets === null) return failed ? 0 : null;

  return sets.some((set) => set.files.length > 0) ? shown : null;
}

/** `on`: the listing reviewed over (null while the reset runs); `undone`: the listing Undo left. */
interface Reviewed {
  readonly at: number;
  readonly on: readonly ChangeSet[] | null;
  readonly undone?: readonly ChangeSet[] | null;
}

function reviewedAtOf(reviewed: Reviewed | null, sets: readonly ChangeSet[] | null, shown: number): number | null {
  if (reviewed === null || (reviewed.undone !== undefined && reviewed.undone !== sets)) return null;

  return reviewed.on === null || reviewed.on === sets || shown === 0 ? reviewed.at : null;
}

type Restored = { readonly ok: true } | { readonly ok: false; readonly error: string };

const UNDO_MS = 10_000;

export function ChangesSurface({ executors, lastActiveExecutor, rpc, onOpenFile, onCount }: {
  executors: ExecutorInfo[];
  lastActiveExecutor?: string | null;
  rpc: Rpc;
  onOpenFile: (path: string) => void;
  onCount: (count: number | null) => void;
}) {
  const sources = sourcesOf(executors);
  const sourceKey = sources.join("\n");
  const defaultSource = pickDefaultExecutor(executors, lastActiveExecutor);
  const picked = useRef(false);
  const [source, setSource] = useState(defaultSource);
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const [undoable, setUndoable] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ readonly file: string | null } | null>(null);

  // Executor status arrives after mount: follow the default until the reader picks a source.
  useEffect(() => {
    if (!picked.current && sources.includes(defaultSource)) setSource(defaultSource);
  }, [defaultSource, sourceKey]);

  const load = useCallback(() => Promise.all(sourceKey.split("\n").map(async (name) =>
    changeSetOf(name, await rpc<ExecutorDiffResult>("getExecutorDiff", [name])))), [rpc, sourceKey]);

  const revalidate = useCallback(() => 2_000, []);
  const { resource, reload } = useAsyncResource(load, revalidate);
  const sets = lastValue(resource);
  // Read after an await: the listing and reload of now, not of the click.
  const live = useRef({ sets, reload });
  live.current = { sets, reload };
  const shown = sets?.find((set) => set.source === source) ?? sets?.[0];
  const shownFiles = shown?.files.length ?? 0;
  const reviewedAt = reviewedAtOf(reviewed, sets, shownFiles);
  const count = countOf(sets, resource.status === "error", shownFiles);

  useEffect(() => { onCount(count); }, [count, onCount]);

  useEffect(() => {
    if (!undoable) return;
    const timer = setTimeout(() => setUndoable(false), UNDO_MS);

    return () => clearTimeout(timer);
  }, [undoable]);

  // A failed re-baseline must surface; otherwise the reader believes the baseline moved.
  const markReviewed = async (): Promise<void> => {
    const at = Date.now();
    setFailure(null);
    setSheet(null);
    setReviewed({ at, on: null });

    try {
      await rpc("resetWorkspaceBaseline", []);
      setReviewed({ at, on: live.current.sets });
      setUndoable(true);
      live.current.reload();
    } catch (cause) {
      setReviewed(null);
      setFailure(`Could not mark reviewed: ${describeError({ cause })}`);
    }
  };

  const undoReviewed = async (): Promise<void> => {
    setUndoable(false);
    setFailure(null);
    let restored: Restored;

    try {
      restored = await rpc<Restored>("restoreWorkspaceBaseline", []);
    } catch (cause) {
      restored = { ok: false, error: describeError({ cause }) };
    }

    if (!restored.ok) {
      setFailure(`Could not undo: ${restored.error}`);

      return;
    }

    setReviewed((prior) => prior && { ...prior, undone: live.current.sets });
    live.current.reload();
  };

  if (sets === null || shown === undefined) {
    return resource.status === "error" ? <div className="p-4"><LoadFailure what="the change-set" message={resource.message} onRetry={reload} /></div> : null;
  }

  const openInFiles = shown.mode === "vfs-baseline"
    ? (path: string): void => { setSheet(null); onOpenFile(workspacePath(path)); }
    : null;

  const now = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {failure !== null && <p role="alert" className="mx-3 mt-3 rounded-md px-3 py-2 text-xs p-notice-danger">{failure}</p>}
      {resource.status === "error" && <LoadFailure what="the latest change-set" message={resource.message} onRetry={reload} className="mx-3 mt-3" />}
      <div className="min-h-0 flex-1">
        <ChangesPanel sets={sets} source={shown.source} onSource={(next) => { picked.current = true; setSource(next); }} now={now}
          reviewedAt={reviewedAt} onReviewed={() => void markReviewed()} onUndo={undoable ? () => void undoReviewed() : null}
          onExpand={(file) => setSheet({ file })} onOpenInFiles={openInFiles} />
      </div>
      {sheet !== null && (
        <ReviewSheet set={shown} now={now} file={sheet.file} onClose={() => setSheet(null)} onReviewed={() => void markReviewed()} onOpenInFiles={openInFiles} />
      )}
    </div>
  );
}
