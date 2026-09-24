import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowRightIcon, ArrowsOutSimpleIcon, CaretDownIcon, CaretLeftIcon, CaretUpIcon, ChatCircleDotsIcon, CheckCircleIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import { changeBlocks, changeBody, inReadingOrder, vfsBasename, vfsDirname, type ChangeSet, type FileDiff } from "@kinu.run/core";
import { ChangeMark, count, Counts, DiffBody, sinceLabel } from "./diff";
import { FileTree, IconButton, MarkReviewed, Since, SourceMenu, Summary, typing } from "./parts";
import { SendFeedback, useNotes, type ChangeNote } from "./notes";

function NoLines({ file, onOpenInFiles }: { file: FileDiff; onOpenInFiles: (() => void) | null }) {
  const body = changeBody(file);
  let text: ReactNode = null;

  if (body.kind === "binary") text = "A binary file. It changed, but it has no lines to compare.";
  else if (body.kind === "counted") text = <>{count(file.added)} lines added and {count(file.removed)} removed: too many to show here.</>;
  else if (body.kind === "uncompared") text = "Over 2 MB, so it was not compared. It changed, and the Files tab can open it.";
  else if (body.kind === "empty") text = file.status === "changed" ? "No lines changed." : "An empty file.";

  if (text === null) return null;

  return (
    <div className="m-3 rounded-lg p-recessed px-3.5 py-3" data-no-lines={body.kind}>
      <p className="p-row-text p-text-2">{text}</p>
      {onOpenInFiles !== null && <button type="button" onClick={onOpenInFiles} className="mt-1.5 p-meta p-accent-fg hover:underline">Open in Files</button>}
    </div>
  );
}

function CappedNote({ file }: { file: FileDiff }) {
  const body = changeBody(file);

  if (body.kind !== "capped") return null;

  return (
    <p className="border-t p-border px-4 py-2.5 p-meta p-text-3" data-capped>
      The diff stops here{body.hidden > 0 ? `, ${count(body.hidden)} ${body.hidden === 1 ? "change" : "changes"} short` : ""}. The counts above cover the whole file.
    </p>
  );
}

export function FileBody({ file, git, stacked, split = false, onOpenInFiles }: {
  file: FileDiff;
  git: boolean;
  stacked: boolean;
  split?: boolean;
  onOpenInFiles: (() => void) | null;
}) {
  const body = changeBody(file);
  const blocks = useMemo(() => (body.kind === "rows" || body.kind === "capped" ? changeBlocks(file, git, stacked) : []), [body.kind, file, git, stacked]);

  if (blocks.length === 0) return <NoLines file={file} onOpenInFiles={onOpenInFiles} />;

  return (
    <>
      <DiffBody path={file.path} blocks={blocks} split={split && file.status === "changed"} />
      <CappedNote file={file} />
    </>
  );
}

function NextFile({ next, reviewable, onOpen, onReviewed, onList }: {
  next: FileDiff | undefined;
  reviewable: boolean;
  onOpen: (path: string) => void;
  onReviewed: () => void;
  onList: () => void;
}) {
  if (next === undefined) {
    return (
      <div className="mx-3 mb-6 mt-4 flex items-center gap-3 rounded-lg border p-border px-3.5 py-3">
        <span className="min-w-0 flex-1 p-row-text p-text-2">That is every change.</span>
        {reviewable ? <MarkReviewed onClick={onReviewed} /> : <button type="button" onClick={onList} className="p-meta p-accent-fg hover:underline">All files</button>}
      </div>
    );
  }

  return (
    <button type="button" onClick={() => onOpen(next.path)} data-next-file
      className="mx-3 mb-6 mt-4 flex w-[calc(100%-1.5rem)] items-center gap-2.5 rounded-lg border p-border px-3.5 py-2.5 text-left transition-colors hover:border-[var(--c-border-strong)] hover:bg-[var(--c-elevated)]">
      <span className="shrink-0 p-meta p-text-3">Next</span>
      <ChangeMark status={next.status} />
      <span className="min-w-0 flex-1 truncate p-row-text p-text">{vfsBasename(next.path)}</span>
      <Counts added={next.added} removed={next.removed} />
      <ArrowRightIcon size={13} className="shrink-0 p-text-3" />
    </button>
  );
}

export interface PanelProps {
  readonly sets: readonly ChangeSet[];
  readonly source: string;
  readonly onSource: (source: string) => void;
  readonly now: number;
  readonly file?: string | null;
  readonly menuOpen?: boolean;
  readonly reviewedAt: number | null;
  readonly onReviewed: () => void;
  readonly onUndo?: (() => void) | null;
  readonly onExpand: ((file: string | null) => void) | null;
  /** Null where the Files tab cannot open the source's paths: a machine's git checkout. */
  readonly onOpenInFiles: ((path: string) => void) | null;
  readonly onShowNotes?: () => void;
  readonly onSend?: (notes: readonly ChangeNote[]) => void;
}

function ListHeader({ sets, set, now, menuOpen, reviewable, onPick, onExpand, onReviewed }: {
  sets: readonly ChangeSet[];
  set: ChangeSet;
  now: number;
  menuOpen: boolean;
  reviewable: boolean;
  onPick: (source: string) => void;
  onExpand: (() => void) | null;
  onReviewed: () => void;
}) {
  const read = set.error === undefined;

  return (
    <header className="shrink-0 border-b p-border px-4 pb-3 pt-3.5">
      <div className="flex items-center gap-2">
        {read
          ? <Summary set={set} />
          : <span className="flex min-w-0 items-center gap-2 p-row-text font-medium p-text"><WarningCircleIcon size={15} className="shrink-0 p-warning" />Can't read {set.label}</span>}
        {onExpand !== null && read && (
          <IconButton label="Expand: every file side by side" onClick={onExpand} className="-mr-1.5 ml-auto">
            <ArrowsOutSimpleIcon size={15} />
          </IconButton>
        )}
      </div>
      <div className="mt-1.5 flex min-h-7 items-center gap-1.5 p-meta p-text-3">
        <SourceMenu sets={sets} source={set.source} initiallyOpen={menuOpen} onPick={onPick} />
        {sets.length > 1 && read && <span aria-hidden="true">·</span>}
        {read && <Since set={set} now={now} />}
        {set.mode === "vfs-baseline" && read && reviewable && <MarkReviewed onClick={onReviewed} className="ml-auto" />}
      </div>
    </header>
  );
}

function NotesBar({ onShowNotes, onSend }: { onShowNotes?: () => void; onSend?: (notes: readonly ChangeNote[]) => void }) {
  const notes = useNotes();

  if (notes === null || notes.notes.length === 0 || onShowNotes === undefined || onSend === undefined) return null;

  return (
    <footer className="flex shrink-0 items-center gap-2 border-t p-border px-3 py-2.5" data-notes-bar>
      <button type="button" onClick={onShowNotes} className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 -ml-1.5 p-meta p-text-2 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
        <ChatCircleDotsIcon size={14} className="p-info" />
        {notes.notes.length} {notes.notes.length === 1 ? "note" : "notes"} for the agent
      </button>
      <SendFeedback onSend={onSend} className="ml-auto" />
    </footer>
  );
}

function FileHeader({ files, at, onGo, onExpand }: {
  files: readonly FileDiff[];
  at: number;
  onGo: (path: string | null) => void;
  onExpand: (() => void) | null;
}) {
  const open = files[at];

  if (open === undefined) return null;

  return (
    <header className="shrink-0 border-b p-border px-2 pb-2.5 pt-2">
      <div className="flex items-center gap-1">
        <IconButton label="All files" onClick={() => onGo(null)}><CaretLeftIcon size={15} /></IconButton>
        <ChangeMark status={open.status} />
        <span className="ml-1 min-w-0 flex-1 truncate p-row-text font-medium p-text" data-open-file>{vfsBasename(open.path)}</span>
        <IconButton label="Previous file (k)" onClick={() => onGo(files[at - 1]?.path ?? null)} disabled={at === 0}><CaretUpIcon size={14} /></IconButton>
        <IconButton label="Next file (j)" onClick={() => onGo(files[at + 1]?.path ?? null)} disabled={at === files.length - 1}><CaretDownIcon size={14} /></IconButton>
        {onExpand !== null && <IconButton label="Expand: every file side by side" onClick={onExpand}><ArrowsOutSimpleIcon size={15} /></IconButton>}
      </div>
      <div className="flex items-center gap-2 pl-[34px] pr-2 p-meta p-text-3">
        <span className="min-w-0 truncate">{vfsDirname(open.path) || "Top level"}</span>
        <Counts added={open.added} removed={open.removed} />
        <span className="ml-auto shrink-0 tabular-nums">{at + 1} of {files.length}</span>
      </div>
    </header>
  );
}

export function ChangesPanel({ sets, source, onSource, now, file: initialFile = null, menuOpen = false, reviewedAt, onReviewed, onUndo = null, onExpand, onOpenInFiles, onShowNotes, onSend }: PanelProps) {
  const [path, setPath] = useState<string | null>(initialFile);
  const set = sets.find((each) => each.source === source) ?? sets[0];
  const files = useMemo(() => inReadingOrder(set?.files ?? []), [set]);
  const at = files.findIndex((file) => file.path === path);
  const open = files[at];
  const root = useRef<HTMLDivElement>(null);
  const noted = (useNotes()?.notes.length ?? 0) > 0;
  const moved = useRef(false);
  const last = useRef<string | null>(null);

  const go = (next: string | null): void => {
    moved.current = true;

    if (next !== null) last.current = next;
    setPath(next);
  };

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;

    const selector = path === null ? `[data-file-row="${CSS.escape(last.current ?? "")}"]` : 'button[aria-label="All files"]';

    root.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: path !== null });
  }, [path]);

  if (set === undefined) return null;

  if (reviewedAt !== null) {
    return (
      <div className="px-4 py-4" data-changes="reviewed">
        <p className="flex items-center gap-2 p-row-text font-medium p-text">
          <CheckCircleIcon size={15} weight="fill" className="p-success" />Reviewed at {sinceLabel(reviewedAt, now)}
          {onUndo !== null && <button type="button" onClick={onUndo} data-undo-reviewed className="ml-auto p-meta font-normal p-accent-fg hover:underline">Undo</button>}
        </p>
        <p className="mt-1 pl-[23px] p-meta p-text-3">New changes show here as they happen.</p>
      </div>
    );
  }

  const step = (by: number): void => {
    const next = files[at + by];

    if (next !== undefined) go(next.path);
  };

  const opener = (file: FileDiff): (() => void) | null => (onOpenInFiles === null ? null : () => onOpenInFiles(file.path));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

    if (open !== undefined && event.key === "Escape") go(null);
    else if (open !== undefined && (event.key === "j" || event.key === "k")) step(event.key === "j" ? 1 : -1);
    else if (open === undefined && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-file-row]")];
      const focused = rows.findIndex((row) => row === document.activeElement);
      rows[Math.min(rows.length - 1, Math.max(0, focused + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else return;

    event.preventDefault();
  };

  const pick = (next: string): void => {
    onSource(next);
    go(null);
  };

  const git = set.mode === "git";

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown} data-changes={open === undefined ? "list" : "file"} data-kinu-annotations>
      {open === undefined ? (
        <ListHeader sets={sets} set={set} now={now} menuOpen={menuOpen} reviewable={!noted} onPick={pick}
          onExpand={onExpand === null ? null : () => onExpand(null)} onReviewed={onReviewed} />
      ) : (
        <FileHeader files={files} at={at} onGo={go} onExpand={onExpand === null ? null : () => onExpand(open.path)} />
      )}

      <div key={open?.path ?? "list"} className="min-h-0 flex-1 overflow-y-auto">
        {open === undefined && set.error !== undefined && <p className="px-4 py-3.5 p-row-text p-text-2" data-changes-error>{set.error}</p>}
        {open === undefined
          ? set.error === undefined && <FileTree files={files} current={null} onOpen={go} />
          : (
            <div className="pt-1.5">
              <FileBody file={open} git={git} stacked={false} onOpenInFiles={opener(open)} />
              <NextFile next={files[at + 1]} reviewable={set.mode === "vfs-baseline" && !noted} onOpen={go} onReviewed={onReviewed} onList={() => go(null)} />
            </div>
          )}
      </div>
      <NotesBar onShowNotes={onShowNotes} onSend={onSend} />
    </div>
  );
}
