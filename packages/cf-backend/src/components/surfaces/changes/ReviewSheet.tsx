import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { CaretDownIcon, CaretUpIcon, ChatCircleDotsIcon, ChatCircleTextIcon, XIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import { Segmented } from "@/components/ui/Segmented";
import { useMediaQuery } from "@/hooks/use-media-query";
import { inReadingOrder, vfsBasename, vfsDirname, type ChangeSet, type FileDiff } from "@kinu.run/core";
import { ChangeMark, Counts, count } from "./diff";
import { FileBody } from "./ChangesPanel";
import { FileTree, IconButton, MarkReviewed, Since, Summary, typing } from "./parts";
import { SendFeedback, useNotes, type ChangeNote } from "./notes";

// Lazy: plannotator's panel loads only with the first note.
const NotesPanel = lazy(() => import("./notes-panel"));

const LAYOUT_KEY = "kinu:changes-layout";

const LayoutSchema = v.picklist(["unified", "split"]);

type Layout = v.InferOutput<typeof LayoutSchema>;

function storedLayout(): Layout {
  const parsed = v.safeParse(LayoutSchema, localStorage.getItem(LAYOUT_KEY));

  return parsed.success ? parsed.output : "split";
}

function FileNotes({ path }: { path: string }) {
  const notes = useNotes();
  const button = useRef<HTMLButtonElement>(null);

  if (notes === null) return null;
  const onFile = notes.notes.filter((note) => note.anchor?.scope === "file" && note.anchor.path === path);

  const write = (): void => {
    if (button.current === null) return;
    notes.write({ path, scope: "file", side: "new", lineStart: 0, lineEnd: 0, baseline: notes.baseline }, path, button.current);
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

function FileCard({ file, git, split, register, onOpenInFiles }: {
  file: FileDiff;
  git: boolean;
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
        <span className="min-w-0 truncate p-meta p-text-3 max-md:hidden">{vfsDirname(file.path)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          <Counts added={file.added} removed={file.removed} />
          <FileNotes path={file.path} />
        </span>
      </header>
      {!folded && <FileBody file={file} git={git} stacked split={split} onOpenInFiles={onOpenInFiles === null ? null : () => onOpenInFiles(file.path)} />}
    </section>
  );
}

function Stepper({ files, current, onShow }: { files: readonly FileDiff[]; current: string | null; onShow: (path: string) => void }) {
  const at = files.findIndex((file) => file.path === current);

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <span className="mr-1 p-meta tabular-nums p-text-3">{at + 1} of {files.length}</span>
      <IconButton label="Previous file (k)" onClick={() => onShow(files[at - 1]?.path ?? "")} disabled={at <= 0}><CaretUpIcon size={13} /></IconButton>
      <IconButton label="Next file (j)" onClick={() => onShow(files[at + 1]?.path ?? "")} disabled={at === files.length - 1}><CaretDownIcon size={13} /></IconButton>
    </div>
  );
}

function AnnotationsToggle({ open, onToggle, compact = false }: { open: boolean; onToggle: () => void; compact?: boolean }) {
  const notes = useNotes();

  if (notes === null || notes.notes.length === 0) return null;

  return (
    <button type="button" onClick={onToggle} aria-expanded={open} data-annotations-toggle
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${open ? "bg-[var(--c-fill)] p-text" : "p-text-2 hover:bg-[var(--c-elevated)] hover:p-text"}`}>
      <ChatCircleDotsIcon size={14} />
      {!compact && "Annotations"}
      <span className="font-mono tabular-nums p-info">{notes.notes.length}</span>
    </button>
  );
}

interface SheetProps {
  readonly set: ChangeSet;
  readonly now: number;
  readonly file: string | null;
  readonly layout?: Layout;
  readonly annotationsOpen?: boolean;
  readonly pickerOpen?: boolean;
  readonly onClose: () => void;
  readonly onReviewed: () => void;
  readonly onOpenInFiles: ((path: string) => void) | null;
  readonly onSend?: (notes: readonly ChangeNote[]) => void;
}

function Picker({ files, current, onPick, onClose }: { files: readonly FileDiff[]; current: string | null; onPick: (path: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[55] flex flex-col justify-end" data-file-picker>
      <div className="p-scrim absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative max-h-[72vh] overflow-y-auto rounded-t-2xl border-t p-border p-sidebar pb-[max(env(safe-area-inset-bottom),12px)] animate-fade-in">
        <div className="sticky top-0 flex h-12 items-center justify-between border-b p-border p-sidebar px-4">
          <span className="p-row-text font-medium p-text">{count(files.length)} files changed</span>
          <IconButton label="Close" onClick={onClose}><XIcon size={15} /></IconButton>
        </div>
        <FileTree files={files} current={current} onOpen={onPick} />
      </div>
    </div>
  );
}

function useSheetKeys({ files, current, show, onClose }: {
  files: readonly FileDiff[];
  current: string | null;
  show: (path: string) => void;
  onClose: () => void;
}): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || document.querySelector("[data-comment-popover]") !== null) return;

      const at = files.findIndex((each) => each.path === current);
      const target = event.key === "j" ? files[at + 1] : files[at - 1];

      if (event.key === "Escape") onClose();
      else if ((event.key === "j" || event.key === "k") && target !== undefined) show(target.path);
      else return;

      event.preventDefault();
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  });
}

function Stack({ files, set, split, register, stack, onScroll, onOpenInFiles }: {
  files: readonly FileDiff[];
  set: ChangeSet;
  split: boolean;
  register: (path: string, element: HTMLElement | null) => void;
  stack: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onOpenInFiles: ((path: string) => void) | null;
}) {
  return (
    <div ref={stack} onScroll={onScroll} className="min-w-0 flex-1 overflow-y-auto" data-review-stack>
      <div className="space-y-4 px-5 py-4 max-md:px-2.5 max-md:py-3">
        {files.map((each) => <FileCard key={each.path} file={each} git={set.mode === "git"} split={split} register={register} onOpenInFiles={onOpenInFiles} />)}
      </div>
    </div>
  );
}

export function ReviewSheet({ set, now, file, layout: pinned, annotationsOpen = false, pickerOpen = false, onClose, onReviewed, onOpenInFiles, onSend }: SheetProps) {
  const phone = !useMediaQuery("(min-width: 768px)");
  const [layout, setLayoutState] = useState<Layout>(() => pinned ?? storedLayout());
  const [panelOpen, setPanelOpen] = useState(annotationsOpen);
  const [picking, setPicking] = useState(pickerOpen);
  const files = useMemo(() => inReadingOrder(set.files), [set]);
  const [current, setCurrent] = useState<string | null>(file ?? files[0]?.path ?? null);
  const cards = useRef(new Map<string, HTMLElement>());
  const stack = useRef<HTMLDivElement>(null);
  const notes = useNotes();
  const noted = (notes?.notes.length ?? 0) > 0;

  const setLayout = (next: Layout): void => {
    localStorage.setItem(LAYOUT_KEY, next);
    setLayoutState(next);
  };

  const register = (path: string, element: HTMLElement | null): void => {
    if (element === null) cards.current.delete(path);
    else cards.current.set(path, element);
  };

  const show = (path: string): void => {
    if (path === "") return;
    setCurrent(path);
    cards.current.get(path)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const reveal = (note: ChangeNote): void => {
    const mark = document.querySelector<HTMLElement>(`[data-note-mark="${CSS.escape(note.id)}"]`);

    if (mark !== null) mark.scrollIntoView({ block: "center", behavior: "smooth" });
    else if (note.anchor !== undefined) show(note.anchor.path);
  };

  useEffect(() => {
    if (file !== null) cards.current.get(file)?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [file]);

  useEffect(() => {
    if (notes?.selected !== null && notes?.selected !== undefined) setPanelOpen(true);
  }, [notes?.selected]);

  const follow = (): void => {
    const top = stack.current?.getBoundingClientRect().top ?? 0;
    let reached = files[0]?.path ?? null;

    for (const each of files) {
      const card = cards.current.get(each.path);

      if (card !== undefined && card.getBoundingClientRect().top - top <= 24) reached = each.path;
    }

    setCurrent(reached);
  };

  useSheetKeys({ files, current, show, onClose });

  const openFile = files.find((each) => each.path === current);

  if (phone) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col p-bg animate-fade-in" role="dialog" aria-modal="true" aria-label="Changes" data-review-sheet="phone" data-kinu-annotations>
        <header className="shrink-0 border-b p-border p-sidebar px-2 pb-1.5 pt-1.5">
          <div className="flex h-10 items-center gap-1.5">
            <IconButton label="Close" onClick={onClose}><XIcon size={16} /></IconButton>
            <Summary set={set} />
            <div className="ml-auto"><AnnotationsToggle open={panelOpen} onToggle={() => setPanelOpen((value) => !value)} compact /></div>
          </div>
          <div className="flex h-10 items-center gap-1 pl-1">
            <button type="button" onClick={() => setPicking(true)} data-file-picker-open
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border p-border px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--c-elevated)]">
              {openFile !== undefined && <ChangeMark status={openFile.status} />}
              <span className="min-w-0 truncate p-row-text font-medium p-text">{openFile === undefined ? "Files" : vfsBasename(openFile.path)}</span>
              <CaretDownIcon size={11} className="ml-auto shrink-0 p-text-3" />
            </button>
            <Stepper files={files} current={current} onShow={show} />
          </div>
        </header>
        <Stack files={files} set={set} split={false} register={register} stack={stack} onScroll={follow} onOpenInFiles={onOpenInFiles} />
        {noted && onSend !== undefined && (
          <footer className="flex shrink-0 items-center gap-2 border-t p-border p-sidebar px-3 pb-[max(env(safe-area-inset-bottom),10px)] pt-2.5">
            <span className="min-w-0 flex-1 p-meta p-text-3">{notes?.notes.length} {notes?.notes.length === 1 ? "note" : "notes"} for the agent</span>
            <SendFeedback onSend={onSend} />
          </footer>
        )}
        {picking && <Picker files={files} current={current} onClose={() => setPicking(false)} onPick={(path) => { setPicking(false); show(path); }} />}
        {notes !== null && <Suspense><NotesPanel open={panelOpen} onClose={() => setPanelOpen(false)} files={files} onReveal={(note) => { setPanelOpen(false); reveal(note); }} /></Suspense>}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 animate-fade-in" role="dialog" aria-modal="true" aria-label="Changes" data-review-sheet="wide">
      <div className="p-scrim absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-3 flex flex-col overflow-hidden rounded-2xl border p-border p-bg p-shadow-overlay" data-kinu-annotations>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b p-border p-sidebar pl-5 pr-3">
          <Summary set={set} />
          <span className="flex min-w-0 items-center gap-1.5 p-meta p-text-3">
            <Since set={set} now={now} />
            {!noted && notes !== null && <span className="truncate max-lg:hidden">· Select any code to leave a note</span>}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Segmented label="Layout" value={layout} onChange={setLayout}
              segments={[{ id: "unified", label: "Unified" }, { id: "split", label: "Split" }]} />
            <AnnotationsToggle open={panelOpen} onToggle={() => setPanelOpen((value) => !value)} />
            {noted && onSend !== undefined ? <SendFeedback onSend={onSend} /> : set.mode === "vfs-baseline" && <MarkReviewed onClick={onReviewed} />}
            <IconButton label="Close (Esc)" onClick={onClose}><XIcon size={15} /></IconButton>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Changed files" className={`flex w-64 shrink-0 flex-col border-r p-border p-sidebar ${panelOpen ? "max-[90rem]:hidden" : ""}`}>
            <div className="flex h-10 shrink-0 items-center border-b p-border pl-3.5 pr-1.5">
              <span className="min-w-0 flex-1 p-meta font-medium p-text-2">Files</span>
              <Stepper files={files} current={current} onShow={show} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <FileTree files={files} current={current} onOpen={show} />
            </div>
          </nav>
          <Stack files={files} set={set} split={layout === "split"} register={register} stack={stack} onScroll={follow} onOpenInFiles={onOpenInFiles} />
          {notes !== null && <Suspense><NotesPanel open={panelOpen} onClose={() => setPanelOpen(false)} files={files} onReveal={reveal} /></Suspense>}
        </div>
      </div>
    </div>
  );
}
