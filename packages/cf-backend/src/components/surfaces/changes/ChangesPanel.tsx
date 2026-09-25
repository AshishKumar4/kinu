import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowRightIcon, CaretDownIcon, CaretLeftIcon, CaretUpIcon, ChatCircleDotsIcon, ChatCircleTextIcon, CheckCircleIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import * as v from "valibot";
import { Segmented } from "@/components/ui/Segmented";
import { useWidthsReached } from "@/hooks/use-element-size";
import {
  changeBlocks, changeBody, inReadingOrder, vfsBasename, vfsDirname, type ChangeSet, type FileDiff, type ReviewAnnotation,
} from "@kinu.run/core";
import { ChangeMark, count, Counts, DiffBody, sinceLabel } from "./diff";
import { FileTree, IconButton, MarkReviewed, Since, SourceMenu, Summary, typing } from "./parts";
import { NotesFailure, SendFeedback, useNotes } from "./notes";

// Lazy: plannotator's panel loads only with the first note.
const NotesPanel = lazy(() => import("./notes-panel"));

/** The least each column needs. */
const COLUMN_PX = { tree: 224, notes: 304, diff: 416, split: 736 } as const;

/** Narrower than `expanded`, one file at a time; open notes take the tree's place until `all`. */
const PANE_PX = {
  expanded: COLUMN_PX.tree + COLUMN_PX.diff,
  split: COLUMN_PX.tree + COLUMN_PX.split,
  splitBesideNotes: COLUMN_PX.notes + COLUMN_PX.split,
  all: COLUMN_PX.tree + COLUMN_PX.notes + COLUMN_PX.split,
};

/** What the pane's width affords: every file at once, a split diff, and the tree beside open notes. */
function paneRoom(fits: (name: keyof typeof PANE_PX) => boolean, notesShown: boolean) {
  return { expanded: fits("expanded"), split: fits(notesShown ? "splitBesideNotes" : "split"), tree: !notesShown || fits("all") };
}

export const LAYOUT_KEY = "kinu:changes-layout";

const LayoutSchema = v.picklist(["unified", "split"]);

type Layout = v.InferOutput<typeof LayoutSchema>;

const LAYOUTS = [{ id: "unified", label: "Unified" }, { id: "split", label: "Split" }] as const;

function storedLayout(): Layout {
  const parsed = v.safeParse(LayoutSchema, localStorage.getItem(LAYOUT_KEY));

  return parsed.success ? parsed.output : "split";
}

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

function FileBody({ file, stacked, split = false, onOpenInFiles }: {
  file: FileDiff;
  stacked: boolean;
  split?: boolean;
  onOpenInFiles: (() => void) | null;
}) {
  const body = changeBody(file);
  const blocks = useMemo(() => (body.kind === "rows" || body.kind === "capped" ? changeBlocks(file, stacked) : []), [body.kind, file, stacked]);

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
  readonly notesOpen?: boolean;
  readonly reviewedAt: number | null;
  readonly onReviewed: () => void;
  readonly onUndo?: (() => void) | null;
  /** Null where the Files tab cannot open the source's paths: a machine's git checkout. */
  readonly onOpenInFiles: ((path: string) => void) | null;
}

function ListHeader({ sets, set, now, menuOpen, reviewable, hint, layout, onPick, onReviewed }: {
  sets: readonly ChangeSet[];
  set: ChangeSet;
  now: number;
  menuOpen: boolean;
  reviewable: boolean;
  hint: boolean;
  layout: ReactNode;
  onPick: (source: string) => void;
  onReviewed: () => void;
}) {
  const read = set.error === undefined;
  const changed = read && set.files.length > 0;

  return (
    <header className="shrink-0 border-b p-border px-4 pb-3 pt-3.5">
      <div className="flex items-center gap-2">
        {read
          ? <Summary set={set} />
          : <span className="flex min-w-0 items-center gap-2 p-row-text font-medium p-text"><WarningCircleIcon size={15} className="shrink-0 p-warning" />Can't read {set.label}</span>}
        {layout !== null && <div className="-my-1 ml-auto">{layout}</div>}
      </div>
      {(sets.length > 1 || read) && (
        <div className="mt-1.5 flex min-h-7 items-center gap-1.5 p-meta p-text-3">
          <SourceMenu sets={sets} source={set.source} initiallyOpen={menuOpen} onPick={onPick} />
          {sets.length > 1 && read && <span aria-hidden="true">·</span>}
          {read && <Since set={set} now={now} />}
          {hint && <span className="truncate">· Select any code to leave a note</span>}
          {set.mode === "vfs-baseline" && changed && reviewable && <MarkReviewed onClick={onReviewed} className="ml-auto" />}
        </div>
      )}
    </header>
  );
}

function NotesBar({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const notes = useNotes();

  if (notes === null || notes.notes.length === 0) return null;

  return (
    <footer className="flex shrink-0 items-center gap-2 border-t p-border px-3 py-2.5" data-notes-bar>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className={`-ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 p-meta transition-colors ${open ? "bg-[var(--c-fill)] p-text" : "p-text-2 hover:bg-[var(--c-elevated)] hover:p-text"}`}>
        <ChatCircleDotsIcon size={14} className="p-info" />
        {notes.notes.length} {notes.notes.length === 1 ? "note" : "notes"} for the agent
      </button>
      <NotesFailure />
      <SendFeedback className="ml-auto" />
    </footer>
  );
}

function FileHeader({ files, at, onGo }: {
  files: readonly FileDiff[];
  at: number;
  onGo: (path: string | null) => void;
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
      </div>
      <div className="flex items-center gap-2 pl-[34px] pr-2 p-meta p-text-3">
        <span className="min-w-0 truncate">{vfsDirname(open.path) || "Top level"}</span>
        <Counts added={open.added} removed={open.removed} />
        <span className="ml-auto shrink-0 tabular-nums">{at + 1} of {files.length}</span>
      </div>
    </header>
  );
}

function FileNotes({ path }: { path: string }) {
  const notes = useNotes();
  const button = useRef<HTMLButtonElement>(null);

  if (notes === null) return null;
  const onFile = notes.notes.filter((note) => note.anchor?.scope === "file" && note.anchor.path === path);

  const write = (): void => {
    if (button.current === null) return;
    notes.write({ scope: "file", path, baseline: notes.baseline }, path, button.current);
  };

  return (
    <>
      {onFile.map((note) => (
        <button key={note.id} type="button" onClick={() => notes.select(note.id)} title={note.text} data-file-note={note.id}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 p-info transition-colors hover:bg-[var(--c-elevated)]">
          <ChatCircleTextIcon size={13} weight="fill" />
        </button>
      ))}
      <button ref={button} type="button" onClick={write} aria-label={`Note on ${vfsBasename(path)}`} title="Note on this file" data-note-file
        className="flex size-7 shrink-0 items-center justify-center rounded-md p-text-4 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
        <ChatCircleTextIcon size={14} />
      </button>
    </>
  );
}

function FileCard({ file, split, register, onOpenInFiles }: {
  file: FileDiff;
  split: boolean;
  register: (path: string, element: HTMLElement | null) => void;
  onOpenInFiles: ((path: string) => void) | null;
}) {
  const [folded, setFolded] = useState(false);

  return (
    <section ref={(element) => register(file.path, element)} data-file-card={file.path} aria-label={file.path}
      className="scroll-mt-3 overflow-clip rounded-xl border p-border p-sidebar">
      <header className={`sticky top-0 z-[1] flex h-10 items-center gap-2 p-sidebar pl-2 pr-2 ${folded ? "" : "border-b p-border"}`}>
        <IconButton label={folded ? `Show ${file.path}` : `Fold ${file.path}`} onClick={() => setFolded((value) => !value)}>
          <CaretDownIcon size={12} className={`transition-transform ${folded ? "-rotate-90" : ""}`} />
        </IconButton>
        <ChangeMark status={file.status} />
        <span className="shrink-0 p-row-text font-medium p-text">{vfsBasename(file.path)}</span>
        <span className="min-w-0 truncate p-meta p-text-3">{vfsDirname(file.path)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          <Counts added={file.added} removed={file.removed} />
          <FileNotes path={file.path} />
        </span>
      </header>
      {!folded && <FileBody file={file} stacked split={split} onOpenInFiles={onOpenInFiles === null ? null : () => onOpenInFiles(file.path)} />}
    </section>
  );
}

function Stepper({ files, current, onShow }: { files: readonly FileDiff[]; current: string | null; onShow: (path: string) => void }) {
  const at = files.findIndex((file) => file.path === current);
  const before = files[at - 1];
  const after = files[at + 1];

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <span className="mr-1 p-meta tabular-nums p-text-3">{at + 1} of {files.length}</span>
      <IconButton label="Previous file (k)" onClick={() => { if (before !== undefined) onShow(before.path); }} disabled={before === undefined}><CaretUpIcon size={13} /></IconButton>
      <IconButton label="Next file (j)" onClick={() => { if (after !== undefined) onShow(after.path); }} disabled={after === undefined}><CaretDownIcon size={13} /></IconButton>
    </div>
  );
}

function Expanded({ files, file, split, tree, notesShown, onNotes, onOpenInFiles }: {
  files: readonly FileDiff[];
  file: string | null;
  split: boolean;
  tree: boolean;
  notesShown: boolean;
  onNotes: (open: boolean) => void;
  onOpenInFiles: ((path: string) => void) | null;
}) {
  const [current, setCurrent] = useState(() => files.find((each) => each.path === file)?.path ?? files[0]?.path ?? null);
  const cards = useRef(new Map<string, HTMLElement>());
  const stack = useRef<HTMLDivElement>(null);
  const selected = useNotes()?.selected ?? null;

  const register = (path: string, element: HTMLElement | null): void => {
    if (element === null) cards.current.delete(path);
    else cards.current.set(path, element);
  };

  const show = (path: string): void => {
    setCurrent(path);
    cards.current.get(path)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const reveal = (note: ReviewAnnotation): void => {
    const mark = stack.current?.querySelector<HTMLElement>(`[data-note-mark="${CSS.escape(note.id)}"]`) ?? null;

    if (mark !== null) mark.scrollIntoView({ block: "center", behavior: "smooth" });
    else if (note.anchor !== undefined) show(note.anchor.path);
  };

  useEffect(() => {
    if (file !== null) cards.current.get(file)?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [file]);

  useEffect(() => {
    if (selected !== null) onNotes(true);
  }, [selected]);

  const follow = (): void => {
    const top = stack.current?.getBoundingClientRect().top ?? 0;
    let reached = files[0]?.path ?? null;

    for (const each of files) {
      const card = cards.current.get(each.path);

      if (card !== undefined && card.getBoundingClientRect().top - top <= 24) reached = each.path;
    }

    setCurrent(reached);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.key !== "j" && event.key !== "k") || typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

    const at = files.findIndex((each) => each.path === current);
    const next = files[at + (event.key === "j" ? 1 : -1)];

    if (next === undefined) return;
    event.preventDefault();
    show(next.path);
  };

  return (
    <div className="flex min-h-0 flex-1" onKeyDown={onKeyDown}>
      {tree && (
        <nav aria-label="Changed files" style={{ width: COLUMN_PX.tree }} className="flex shrink-0 flex-col border-r p-border">
          <div className="flex h-10 shrink-0 items-center border-b p-border pl-3.5 pr-1.5">
            <span className="min-w-0 flex-1 p-meta font-medium p-text-2">Files</span>
            <Stepper files={files} current={current} onShow={show} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FileTree files={files} current={current} onOpen={show} />
          </div>
        </nav>
      )}
      <div ref={stack} onScroll={follow} tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto p-bg outline-none" data-review-stack>
        <div className="space-y-4 px-5 py-4 max-md:px-2.5 max-md:py-3">
          {files.map((each) => <FileCard key={each.path} file={each} split={split} register={register} onOpenInFiles={onOpenInFiles} />)}
        </div>
      </div>
      {notesShown && <Suspense><NotesPanel width={`${String(COLUMN_PX.notes)}px`} onClose={() => onNotes(false)} onReveal={reveal} /></Suspense>}
    </div>
  );
}

function Reviewed({ sets, source, at, now, menuOpen, onSource, onUndo }: {
  sets: readonly ChangeSet[];
  source: string;
  at: number;
  now: number;
  menuOpen: boolean;
  onSource: (source: string) => void;
  onUndo: (() => void) | null;
}) {
  return (
    <div className="px-4 py-4" data-changes="reviewed">
      <p className="flex items-center gap-2 p-row-text font-medium p-text">
        <CheckCircleIcon size={15} weight="fill" className="p-success" />Reviewed at {sinceLabel(at, now)}
        {onUndo !== null && <button type="button" onClick={onUndo} data-undo-reviewed className="ml-auto p-meta font-normal p-accent-fg hover:underline">Undo</button>}
      </p>
      <p className="mt-1 pl-[23px] p-meta p-text-3">New changes show here as they happen.</p>
      {sets.length > 1 && (
        <div className="mt-2.5 flex min-h-7 items-center pl-[23px] p-meta p-text-3">
          <SourceMenu sets={sets} source={source} initiallyOpen={menuOpen} onPick={onSource} />
        </div>
      )}
    </div>
  );
}

function NarrowBody({ set, files, at, path, reviewable, onGo, onReviewed, onOpenInFiles }: {
  set: ChangeSet;
  files: readonly FileDiff[];
  at: number;
  path: string | null;
  reviewable: boolean;
  onGo: (path: string | null) => void;
  onReviewed: () => void;
  onOpenInFiles: ((path: string) => void) | null;
}) {
  const open = files[at];

  if (open === undefined) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {set.error === undefined ? (
          <>
            {path !== null && <p className="px-4 pt-3 p-meta p-text-3" data-changes-gone>{vfsBasename(path)} has no changes now.</p>}
            <FileTree files={files} current={null} onOpen={onGo} />
          </>
        ) : <p className="px-4 py-3.5 p-row-text p-text-2" data-changes-error>{set.error}</p>}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="pt-1.5">
        <FileBody file={open} stacked={false} onOpenInFiles={onOpenInFiles === null ? null : () => onOpenInFiles(open.path)} />
        <NextFile next={files[at + 1]} reviewable={reviewable} onOpen={onGo} onReviewed={onReviewed} onList={() => onGo(null)} />
      </div>
    </div>
  );
}

export function ChangesPanel({ sets, source, onSource, now, file: initialFile = null, menuOpen = false, notesOpen: notesInitiallyOpen = false, reviewedAt, onReviewed, onUndo = null, onOpenInFiles }: PanelProps) {
  const [path, setPath] = useState<string | null>(initialFile);
  const [notesOpen, setNotesOpen] = useState(notesInitiallyOpen);
  const [layout, setLayout] = useState<Layout>(storedLayout);
  const { attach, fits } = useWidthsReached(PANE_PX);
  const set = sets.find((each) => each.source === source) ?? sets[0];
  const files = useMemo(() => inReadingOrder(set?.files ?? []), [set]);
  const at = files.findIndex((each) => each.path === path);
  const open = files[at];
  const root = useRef<HTMLDivElement | null>(null);
  const notes = useNotes();
  const noted = (notes?.notes.length ?? 0) > 0;
  const moved = useRef(false);
  const last = useRef<string | null>(null);

  const mount = useCallback((element: HTMLDivElement | null): void => {
    root.current = element;
    attach(element);
  }, [attach]);

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

  // Out of notes, the list closes: a later first note must not cover the diff it is on.
  useEffect(() => {
    if (!noted) setNotesOpen(false);
  }, [noted]);

  if (set === undefined) return null;

  if (reviewedAt !== null) return <Reviewed sets={sets} source={set.source} at={reviewedAt} now={now} menuOpen={menuOpen} onSource={onSource} onUndo={onUndo} />;

  const step = (by: number): void => {
    const next = files[at + by];

    if (next !== undefined) go(next.path);
  };

  const review = (): void => {
    setPath(null);
    onReviewed();
  };

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

  const pickLayout = (next: Layout): void => {
    localStorage.setItem(LAYOUT_KEY, next);
    setLayout(next);
  };

  const revealInFile = (note: ReviewAnnotation): void => {
    if (note.anchor === undefined) return;
    setNotesOpen(false);
    go(note.anchor.path);
    requestAnimationFrame(() => root.current?.querySelector(`[data-note-mark="${CSS.escape(note.id)}"]`)?.scrollIntoView({ block: "center" }));
  };

  const notesShown = notesOpen && noted;
  const room = paneRoom(fits, notesShown);
  const expanded = room.expanded && set.error === undefined && files.length > 0;
  const flow = open === undefined ? "list" : "file";

  return (
    <div ref={mount} className="flex h-full min-h-0 flex-col" onKeyDown={expanded ? undefined : onKeyDown}
      data-changes={expanded ? "expanded" : flow} data-kinu-annotations>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {expanded || open === undefined ? (
          <ListHeader sets={sets} set={set} now={now} menuOpen={menuOpen} reviewable={!noted} hint={expanded && notes !== null && !noted}
            layout={expanded && room.split ? <Segmented label="Layout" value={layout} onChange={pickLayout} segments={LAYOUTS} /> : null}
            onPick={pick} onReviewed={review} />
        ) : (
          <FileHeader files={files} at={at} onGo={go} />
        )}
        {expanded ? (
          <Expanded files={files} file={path} split={room.split && layout === "split"} tree={room.tree}
            notesShown={notesShown} onNotes={setNotesOpen} onOpenInFiles={onOpenInFiles} />
        ) : (
          <NarrowBody key={open?.path ?? "list"} set={set} files={files} at={at} path={path} reviewable={set.mode === "vfs-baseline" && !noted}
            onGo={go} onReviewed={review} onOpenInFiles={onOpenInFiles} />
        )}
        {notesShown && !expanded && (
          <div className="absolute inset-0 z-10 flex" data-notes-page>
            <Suspense><NotesPanel width="100%" onClose={() => setNotesOpen(false)} onReveal={revealInFile} /></Suspense>
          </div>
        )}
      </div>
      <NotesBar open={notesShown} onToggle={() => setNotesOpen(!notesShown)} />
    </div>
  );
}
