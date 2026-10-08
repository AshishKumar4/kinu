import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Cause, Effect } from "effect";
import { detach, settle } from "@kinu.run/core/obs";
import { AnnotationToolbar } from "@plannotator/ui/components/AnnotationToolbar";
import { CommentPopover } from "@plannotator/ui/components/CommentPopover";
import { AnnotationType } from "@plannotator/ui/types";
import {
  anchoredText, createPlanAnnotationSaveQueue, type ChangeNote, type ChangeNotesResult, type DiffAnchor, type FileDiff,
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

function nextId(notes: readonly ChangeNote[]): string {
  return `note-${String(notes.length + 1)}-${String(Date.now())}`;
}

/** A note on a place in the changes, or, without `anchor`, on all of them: that one has no block, offsets or quote. */
export function noteOf(fields: { id: string; type: AnnotationType; quote: string; createdA: number; anchor?: DiffAnchor; text?: string }): ChangeNote {
  const { anchor, text } = fields;

  if (anchor === undefined) return { id: fields.id, type: "GLOBAL_COMMENT", text: text ?? "", createdA: fields.createdA };
  const lines = anchor.scope === "file" ? { startOffset: 0, endOffset: 0 } : { startOffset: anchor.lineStart, endOffset: anchor.lineEnd };
  const type = storedType(fields.type);

  return {
    id: fields.id, type: type === "DELETION" ? "DELETION" : "COMMENT", originalText: fields.quote, createdA: fields.createdA,
    blockId: anchor.path, ...lines, anchor, ...(text !== undefined && { text }),
  };
}

/** The quote comes from the diff, never the page, so `moved` rereads it the same way. */
function quoteOf(anchor: DiffAnchor, files: readonly FileDiff[]): string | null {
  const file = files.find((each) => each.path === anchor.path);

  return file === undefined ? null : anchoredText(file, anchor);
}

function moved(note: ChangeNote, files: readonly FileDiff[]): boolean {
  if (note.type === "GLOBAL_COMMENT") return false;
  const anchor = note.anchor;

  if (anchor === undefined || anchor.scope === "file") return false;

  if (!files.some((each) => each.path === anchor.path)) return true;
  const now = quoteOf(anchor, files);

  return now !== null && now !== note.originalText;
}

/** Each answers the change-set notes' result; a transport failure is already folded into its `error`. */
export interface NotesStore {
  load(): Effect.Effect<ChangeNotesResult>;
  save(notes: readonly ChangeNote[]): Effect.Effect<ChangeNotesResult>;
  send(): Effect.Effect<ChangeNotesResult>;
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
  initial?: readonly ChangeNote[];
  writing?: OpenDraft;
  now: () => number;
  children: ReactNode;
}) {
  const [notes, setNotes] = useState<readonly ChangeNote[]>(initial);
  const [draft, setDraft] = useState<Draft | null>(() => (writing === undefined ? null : { ...writing, target: followingElement(null), stage: "comment" }));
  const [selected, setSelected] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const touched = useRef(false);
  const failed = (...rejection: [unknown]): void => { setFailure(describeError({ cause: rejection[0] })); };

  const saves = useMemo(() => (store === null ? null : createPlanAnnotationSaveQueue<ChangeNote>((next) => settle(Effect.map(store.save(next), (saved) => {
    setFailure(saved.ok ? null : saved.error);

    return saved.ok;
  })))), [store]);

  useEffect(() => {
    if (store === null) return;
    let live = true;

    detach(Effect.catchCause(Effect.map(store.load(), (kept) => {
      if (!live) return;

      if (!kept.ok) setFailure(kept.error);
      else if (!touched.current) setNotes(kept.notes);
    }), (cause) => Effect.sync(() => failed(Cause.squash(cause)))));

    return () => { live = false; };
  }, [store]);

  const change = useCallback((next: readonly ChangeNote[]): void => {
    touched.current = true;
    setNotes(next);
    detach(saves === null ? Effect.void : Effect.catchCause(Effect.promise(() => saves.enqueue(next)), (cause) => Effect.sync(() => failed(Cause.squash(cause)))));
  }, [saves]);

  const send = useCallback((): void => {
    if (store === null || sending) return;
    setSending(true);
    detach(Effect.ensuring(Effect.catchCause(Effect.map(store.send(), (sent) => {
      setFailure(sent.ok ? null : sent.error);

      if (sent.ok) setNotes([]);
    }), (cause) => Effect.sync(() => failed(Cause.squash(cause)))), Effect.sync(() => { setSending(false); })));
  }, [store, sending]);

  const movedIds = useMemo(() => new Set(notes.filter((note) => moved(note, files)).map((note) => note.id)), [notes, files]);

  const value = useMemo<Notes>(() => ({
    notes, moved: movedIds, draft, selected, baseline, failure, sending,
    offer: (picked) => setDraft({ anchor: picked.anchor, quote: quoteOf(picked.anchor, files) ?? "", target: followingElement(picked.range), stage: "toolbar" }),
    write: (anchor, quote, target) => setDraft({ ...(anchor !== undefined && { anchor }), quote, target, stage: "comment" }),
    select: setSelected,
    remove: (id) => change(notes.filter((note) => note.id !== id)),
    edit: (id, text) => change(notes.map((note) => (note.id === id ? { ...note, text } : note))),
    send,
  }), [notes, movedIds, draft, selected, baseline, failure, sending, files, change, send]);

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
