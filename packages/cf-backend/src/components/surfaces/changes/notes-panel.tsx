import { AnnotationPanel } from "@/components/plan-review/AnnotationPanel";
import { changeNoteAnchor, inNoteOrder, type ChangeNote } from "@kinu.run/core";
import { panelNote, placeLabel, useNotes } from "./notes";

function placeOf(note: ChangeNote | undefined) {
  return note === undefined ? undefined : changeNoteAnchor(note);
}

export default function NotesPanel({ width, onClose, onReveal }: {
  width: string;
  onClose: () => void;
  onReveal: (note: ChangeNote) => void;
}) {
  const notes = useNotes();

  if (notes === null) return null;
  const byId = new Map(notes.notes.map((note) => [note.id, note]));
  const hasGlobal = notes.notes.some((note) => note.type === "GLOBAL_COMMENT");

  const addGlobal = (): void => {
    const button = document.querySelector<HTMLElement>("[data-annotation-add-global]");

    if (button !== null) notes.write(undefined, "", button);
  };

  return (
    <AnnotationPanel isOpen annotations={inNoteOrder(notes.notes).map(panelNote)} selectedId={notes.selected}
      width={width} onClose={onClose}
      onSelect={(id) => {
        const note = byId.get(id);

        notes.select(id);

        if (note !== undefined) onReveal(note);
      }}
      onDelete={notes.remove} onEdit={(id, updates) => notes.edit(id, updates.text ?? "")}
      placeOf={(annotation) => `${placeLabel(placeOf(byId.get(annotation.id)))}${notes.moved.has(annotation.id) ? " · changed since" : ""}`}
      onAddGlobal={hasGlobal ? undefined : addGlobal} globalLabel="Note on all the changes" />
  );
}
