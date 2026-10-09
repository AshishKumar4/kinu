import { Effect, Cause } from 'effect';
import { detach } from '@kinu.run/core/obs';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  executorLabel, executorSortKey, isActiveExecutionDevice, keepUnchanged, oneAtATime, pickDefaultExecutor,
  workspacePath, WORKSPACE_ROOT, type ChangeNotesResult, type ChangeSet, type ExecutorDiffResult, type ExecutorInfo, type ChangeNote, type Rpc,
} from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { describeError, lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { Loader } from "@cloudflare/kumo";
import { lazyRoute } from "@/lazy-route";
import type { NotesStore } from "./changes/notes-provider";
import type { ChangesViewProps } from "./changes/ChangesView";

const ChangesView = lazyRoute<ChangesViewProps>(async () => {
  const { ChangesView: view } = await import("./changes/ChangesView");

  return { default: view };
});

function changeSetOf(source: string, result: ExecutorDiffResult): ChangeSet {
  const error = result.error ?? (result.notGitRepo === true ? "Its folder holds no git repository, so there is nothing to compare." : undefined);

  return {
    source, label: executorLabel(source), mode: result.mode, files: result.files, trackedSince: result.trackedSince, baseline: result.baseline,
    repositories: result.repositories, error,
  };
}

function answered(call: () => Promise<ChangeNotesResult>): Effect.Effect<ChangeNotesResult> {
  return Effect.catchCause(Effect.promise(call), (failed) => Effect.succeed({ ok: false, error: describeError({ cause: Cause.squash(failed) }) }));
}

function notesStore(rpc: Rpc, source: string, current: () => ChangeSet | undefined): NotesStore {
  return {
    load: () => answered(async () => ({ ok: true, notes: await rpc<ChangeNote[]>("getChangeNotes", [source]) })),
    save: (notes) => answered(() => rpc<ChangeNotesResult>("saveChangeNotes", [source, notes])),
    send: () => answered(() => {
      const set = current();

      if (set === undefined) return Promise.resolve({ ok: false, error: "the change-set is no longer listed" });

      return rpc<ChangeNotesResult>("sendChangeNotes", [{ source, label: set.label, mode: set.mode, ...(set.trackedSince !== undefined && { trackedSince: set.trackedSince }) }]);
    }),
  };
}

/** `nonce` lets the same place open twice. */
export interface ChangesFocus {
  readonly source: string;
  readonly path: string | null;
  readonly nonce: number;
}

function sourcesOf(executors: readonly ExecutorInfo[]): string[] {
  const devices = executors
    .filter(isActiveExecutionDevice)
    .sort((a, b) => executorSortKey(a.name) - executorSortKey(b.name) || a.name.localeCompare(b.name))
    .map((executor) => executor.name);

  return Array.from(new Set(["workspace", ...devices]));
}

/** A folder outside git is not `unreadable`. */
interface Read {
  readonly sets: readonly ChangeSet[];
  readonly unreadable: boolean;
}

/** Null hides the tab; 0 shows it unnumbered. */
function countOf(read: Read | null, failed: boolean, shown: number): number | null {
  if (read === null) return failed ? 0 : null;

  if (read.sets.some((set) => set.files.length > 0)) return shown;

  return read.unreadable ? 0 : null;
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

function useDocumentVisible(): boolean {
  // A render with no document (the static renderer) is as seen as a visible page.
  const [visible, setVisible] = useState(() => !("document" in globalThis) || document.visibilityState === "visible");

  useEffect(() => {
    const follow = (): void => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", follow);

    return () => document.removeEventListener("visibilitychange", follow);
  }, []);

  return visible;
}

const UNDO_MS = 10_000;

export function ChangesSurface({ executors, lastActiveExecutor, rpc, focus = null, active, moved, turnLive, onOpenFile, onCount }: {
  executors: ExecutorInfo[];
  lastActiveExecutor?: string | null;
  rpc: Rpc;
  focus?: ChangesFocus | null;
  /** Whether Changes is the surface shown: only then does it poll. */
  active: boolean;
  moved?: number;
  /** Whether the workspace's turn is running: its writes are all in once it closes. */
  turnLive: boolean;
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

  // Executor status arrives after mount: follow the default until the reader picks a source.
  useEffect(() => {
    if (!picked.current && sources.includes(defaultSource)) setSource(defaultSource);
  }, [defaultSource, sourceKey]);

  useEffect(() => {
    if (focus === null) return;
    picked.current = true;
    setSource(focus.source);
  }, [focus]);

  const load = useCallback(async (): Promise<Read> => {
    const results = await Promise.all(sourceKey.split("\n").map(async (name) =>
      [name, await rpc<ExecutorDiffResult>("getExecutorDiff", [name])] as const));

    const held = live.current.sets;

    return {
      sets: results.map(([name, result]) => {
        const set = changeSetOf(name, result);
        const before = held?.find((each) => each.source === name);

        return before === undefined ? set : { ...set, files: keepUnchanged(before.files, set.files) };
      }),
      unreadable: results.some(([, result]) => result.error !== undefined),
    };
  }, [rpc, sourceKey]);

  const visible = useDocumentVisible();
  const seen = active && visible;
  // Unseen, it reads only when the workspace says its change-set moved, a turn closes, it comes into view or the
  // window takes focus.
  const revalidate = useCallback(() => (seen ? 2_000 : null), [seen]);
  const serialLoad = useMemo(() => oneAtATime(load), [load]);
  const { resource, reload } = useAsyncResource(serialLoad, revalidate);
  const wasLive = useRef(turnLive);
  const wasSeen = useRef(seen);
  const wasMoved = useRef(moved);

  useEffect(() => {
    if (moved !== wasMoved.current) reload();
    wasMoved.current = moved;
  }, [moved, reload]);

  useEffect(() => {
    if (seen && !wasSeen.current) reload();
    wasSeen.current = seen;
  }, [seen, reload]);

  useEffect(() => {
    window.addEventListener("focus", reload);

    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  // The poll alone shows a turn's writes up to one period after it closes.
  useEffect(() => {
    if (wasLive.current && !turnLive) reload();
    wasLive.current = turnLive;
  }, [turnLive, reload]);
  const read = lastValue(resource);
  const sets = read?.sets ?? null;
  // Read after an await: the listing and reload of now, not of the click.
  const live = useRef({ sets, reload });
  live.current = { sets, reload };
  const shown = sets?.find((set) => set.source === source) ?? sets?.[0];
  const shownSource = shown?.source ?? null;

  const store = useMemo(() => (shownSource === null ? null
    : notesStore(rpc, shownSource, () => live.current.sets?.find((set) => set.source === shownSource))), [rpc, shownSource]);

  const shownFiles = shown?.files.length ?? 0;
  // Mark reviewed moves the workspace's baseline; a machine's changes are measured from its own commit.
  const reviewedAt = shown?.mode === "vfs-baseline" ? reviewedAtOf(reviewed, sets, shownFiles) : null;
  const count = countOf(read, resource.status === "error", shownFiles);

  useEffect(() => { onCount(count); }, [count, onCount]);

  useEffect(() => {
    if (!undoable) return;
    const timer = setTimeout(() => setUndoable(false), UNDO_MS);

    return () => clearTimeout(timer);
  }, [undoable]);

  // A failed re-baseline must surface; otherwise the reader believes the baseline moved.
  const markReviewed = () => Effect.gen(function* () {
    const at = Date.now();
    setFailure(null);
    setReviewed({ at, on: null });

    return yield* Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => rpc("resetWorkspaceBaseline", []));
      setReviewed({ at, on: live.current.sets });
      setUndoable(true);
      live.current.reload();
    }), (failed) => Effect.sync(() => {
      const cause = Cause.squash(failed);
      setReviewed(null);
      setFailure(`Could not mark reviewed: ${describeError({ cause })}`);
    }));
  });

  const undoReviewed = useCallback(() => detach(Effect.gen(function* () {
    setUndoable(false);
    setFailure(null);

    const refusal = yield* Effect.catchCause(
      Effect.map(Effect.promise(() => rpc<Restored>("restoreWorkspaceBaseline", [])), (restored) => (restored.ok ? null : restored.error)),
      (failed) => Effect.succeed(describeError({ cause: Cause.squash(failed) })),
    );

    if (refusal !== null) {
      setFailure(`Could not undo: ${refusal}`);

      return;
    }

    setReviewed((prior) => prior && { ...prior, undone: live.current.sets });
    live.current.reload();
  })), [rpc]);

  if (sets === null || shown === undefined) {
    return resource.status === "error" ? <div className="p-4"><LoadFailure what="the change-set" message={resource.message} onRetry={reload} /></div> : null;
  }

  const openInFiles = shown.mode === "vfs-baseline" ? (path: string): void => onOpenFile(workspacePath(path, WORKSPACE_ROOT)) : null;

  const now = Date.now();

  return (
    <ShownOnce active={active}>
      <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="sm" /></div>}>
        <ChangesView key={shown.source} notes={{ baseline: shown.baseline ?? "", files: shown.files, store, now: Date.now }} panelKey={focus?.nonce ?? 0}
          banner={<>
            {failure !== null && <p role="alert" className="mx-3 mt-3 rounded-md px-3 py-2 text-xs p-notice-danger">{failure}</p>}
            {resource.status === "error" && <LoadFailure what="the latest change-set" message={resource.message} onRetry={reload} className="mx-3 mt-3" />}
          </>}
          file={focus?.path ?? null} sets={sets} source={shown.source}
          onSource={(next) => { picked.current = true; setSource(next); }} now={now}
          reviewedAt={reviewedAt} onReviewed={() => detach(markReviewed())} onUndo={undoable ? undoReviewed : null}
          onOpenInFiles={openInFiles} />
      </Suspense>
    </ShownOnce>
  );
}

/** The panel is drawn, and its chunk loaded, from the first time Changes is shown; the counts load before it. */
function ShownOnce({ active, children }: { active: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(active);

  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);

  return opened ? children : null;
}
