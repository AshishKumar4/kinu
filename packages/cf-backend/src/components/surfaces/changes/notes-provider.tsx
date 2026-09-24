import { useMemo, useState, type ReactNode } from "react";
import { AnnotationToolbar } from "@plannotator/ui/components/AnnotationToolbar";
import { CommentPopover } from "@plannotator/ui/components/CommentPopover";
import { AnnotationType } from "@plannotator/ui/types";
import { NotesContext, type ChangeAnchor, type ChangeNote, type Draft, type Notes } from "./notes";

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

export interface OpenDraft {
  readonly anchor?: ChangeAnchor;
  readonly quote: string;
  readonly initialText?: string;
}

export function NotesProvider({ baseline, initial = [], writing, now, children }: {
  baseline: string;
  initial?: readonly ChangeNote[];
  writing?: OpenDraft;
  now: () => number;
  children: ReactNode;
}) {
  const [notes, setNotes] = useState<readonly ChangeNote[]>(initial);
  const [draft, setDraft] = useState<Draft | null>(() => (writing === undefined ? null : { ...writing, target: followingElement(null), stage: "comment" }));
  const [selected, setSelected] = useState<string | null>(null);

  const value = useMemo<Notes>(() => ({
    notes, draft, selected, baseline,
    offer: (picked) => setDraft({ anchor: picked.anchor, quote: picked.quote, target: followingElement(picked.range), stage: "toolbar" }),
    write: (anchor, quote, target) => setDraft({ anchor, quote, target, stage: "comment" }),
    select: setSelected,
    remove: (id) => setNotes((prior) => prior.filter((note) => note.id !== id)),
    edit: (id, text) => setNotes((prior) => prior.map((note) => (note.id === id ? { ...note, text } : note))),
  }), [notes, draft, selected, baseline]);

  const add = (type: AnnotationType, text?: string): void => {
    if (draft === null) return;
    const note: ChangeNote = { id: nextId(notes), type, originalText: draft.quote, createdA: now(), anchor: draft.anchor, text };

    setNotes((prior) => [...prior, note]);
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
