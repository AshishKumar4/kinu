import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnnotationToolbar } from "@plannotator/ui/components/AnnotationToolbar";
import { CommentPopover } from "@plannotator/ui/components/CommentPopover";
import { AnnotationType } from "@plannotator/ui/types";
import {
  ALL_CHANGES_BLOCK, anchoredText, createPlanAnnotationSaveQueue, type ChangeNotesResult, type DiffAnchor, type FileDiff, type ReviewAnnotation,
} from "@kinu.run/core";
import { describeError } from "@/hooks/use-async-resource";
import { storedType } from "../annotation-type";
import { NotesContext, type Draft, type Notes } from "./notes";

function followingElement(range: Range | null): HTMLElement {
  const element = document.createElement("span");
  let last = range?.getBoundingClientRect() ?? new DOMRect();

  const marks = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-note-mark="draft"]')];

  element.getBoundingClientRect = () => {
    const rects = marks().map((mark) => mark.getBoundingClientRect());
    let rect: DOMRect | null = null;

    if (rects.length > 0) {
      const top = Math.min(...rects.map((each) => each.top));
      const left = Math.min(...rects.map((each) => each.left));
      rect = new DOMRect(left, top, Math.max(...rects.map((each) => each.right)) - left, Math.max(...rects.map((each) => each.bottom)) - top);
    } else if (range?.startContainer.isConnected === true) {
      rect = range.getBoundingClientRect();
    }

    if (rect !== null && rect.width + rect.height > 0) last = rect;

    return last;
  };

  element.scrollIntoView = (options) => marks()[0]?.scrollIntoView(options);

  return element;
}

function nextId(notes: readonly ReviewAnnotation[]): string {
  return `note-${String(notes.length + 1)}-${String(Date.now())}`;
}

export function noteOf(fields: { id: string; type: AnnotationType; quote: string; createdA: number; anchor?: DiffAnchor; text?: string }): ReviewAnnotation {
  const { anchor, text } = fields;
  const lines = anchor === undefined || anchor.scope === "file" ? { startOffset: 0, endOffset: 0 } : { startOffset: anchor.lineStart, endOffset: anchor.lineEnd };

  return {
    id: fields.id, type: storedType(fields.type), originalText: fields.quote, createdA: fields.createdA,
    blockId: anchor === undefined ? ALL_CHANGES_BLOCK : anchor.path, ...lines,
    ...(anchor !== undefined && { anchor }), ...(text !== undefined && { text }),
  };
}

/** The quote comes from the diff, never the page, so `moved` reads it back by the same rule. */
function quoteOf(anchor: DiffAnchor, files: readonly FileDiff[]): string | null {
  const file = files.find((each) => each.path === anchor.path);

  return file === undefined ? null : anchoredText(file, anchor);
}

function moved(note: ReviewAnnotation, files: readonly FileDiff[]): boolean {
  const anchor = note.anchor;

  if (anchor === undefined || anchor.scope === "file") return false;

  if (!files.some((each) => each.path === anchor.path)) return true;
  const now = quoteOf(anchor, files);

  return now !== null && now !== note.originalText;
}

export interface NotesStore {
  load(): Promise<ChangeNotesResult>;
  save(notes: readonly ReviewAnnotation[]): Promise<ChangeNotesResult>;
  send(): Promise<ChangeNotesResult>;
}

export interface OpenDraft {
  readonly anchor?: DiffAnchor;
  readonly quote: string;
  readonly initialText?: string;
}

export function NotesProvider({ baseline, files, store, initial = [], writing, now, children }: {
  baseline: string;
  files: readonly FileDiff[];
  store: NotesStore | null;
  initial?: readonly ReviewAnnotation[];
  writing?: OpenDraft;
  now: () => number;
  children: ReactNode;
}) {
  const [notes, setNotes] = useState<readonly ReviewAnnotation[]>(initial);
  const [draft, setDraft] = useState<Draft | null>(() => (writing === undefined ? null : { ...writing, target: followingElement(null), stage: "comment" }));
  const [selected, setSelected] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const touched = useRef(false);
  const failed = (...rejection: [unknown]): void => { setFailure(describeError({ cause: rejection[0] })); };

  const saves = useMemo(() => (store === null ? null : createPlanAnnotationSaveQueue<ReviewAnnotation>(async (next) => {
    const saved = await store.save(next);

    setFailure(saved.ok ? null : saved.error);

    return saved.ok;
  })), [store]);

  useEffect(() => {
    if (store === null) return;
    let live = true;

    store.load().then((kept) => {
      if (!live) return;

      if (!kept.ok) setFailure(kept.error);
      else if (!touched.current) setNotes(kept.notes);
    }).catch(failed);

    return () => { live = false; };
  }, [store]);

  const change = (next: readonly ReviewAnnotation[]): void => {
    touched.current = true;
    setNotes(next);
    saves?.enqueue(next).catch(failed);
  };

  const movedIds = useMemo(() => new Set(notes.filter((note) => moved(note, files)).map((note) => note.id)), [notes, files]);

  const value = useMemo<Notes>(() => ({
    notes, moved: movedIds, draft, selected, baseline, failure, sending,
    offer: (picked) => setDraft({ anchor: picked.anchor, quote: quoteOf(picked.anchor, files) ?? "", target: followingElement(picked.range), stage: "toolbar" }),
    write: (anchor, quote, target) => setDraft({ ...(anchor !== undefined && { anchor }), quote, target, stage: "comment" }),
    select: setSelected,
    remove: (id) => change(notes.filter((note) => note.id !== id)),
    edit: (id, text) => change(notes.map((note) => (note.id === id ? { ...note, text } : note))),
    send: () => {
      if (store === null || sending) return;
      setSending(true);
      store.send().then((sent) => {
        setFailure(sent.ok ? null : sent.error);

        if (sent.ok) setNotes([]);
      }).catch(failed).finally(() => { setSending(false); });
    },
  }), [notes, movedIds, draft, selected, baseline, failure, sending, store, files]);

  const add = (type: AnnotationType, text?: string): void => {
    if (draft === null) return;
    const note = noteOf({ id: nextId(notes), type, quote: draft.quote, createdA: now(), ...(draft.anchor !== undefined && { anchor: draft.anchor }), ...(text !== undefined && { text }) });

    change([...notes, note]);
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  };

  const close = (): void => {
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <NotesContext.Provider value={value}>
      {children}
      {draft?.stage === "toolbar" && (
        <AnnotationToolbar element={draft.target} positionMode="center-above" copyText={draft.quote} onClose={close}
          onAnnotate={(type) => add(type)}
          onRequestComment={(initialText) => setDraft({ ...draft, stage: "comment", initialText })} />
      )}
      {draft?.stage === "comment" && (
        <CommentPopover anchorEl={draft.target} contextText={draft.quote.length > 80 ? `${draft.quote.slice(0, 80)}…` : draft.quote}
          isGlobal={draft.anchor === undefined} initialText={draft.initialText} allowImages={false}
          onSubmit={(text) => add(draft.anchor === undefined ? AnnotationType.GLOBAL_COMMENT : AnnotationType.COMMENT, text)}
          onClose={close} />
      )}
    </NotesContext.Provider>
  );
}
