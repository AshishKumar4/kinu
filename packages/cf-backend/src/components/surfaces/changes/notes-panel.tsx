import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import type { FileDiff } from "@kinu.run/core";
import { orderNotes, panelNote, placeLabel, useNotes, type ChangeNote } from "./notes";

export default function NotesPanel({ open, onClose, files, onReveal }: {
  open: boolean;
  onClose: () => void;
  files: readonly FileDiff[];
  onReveal: (note: ChangeNote) => void;
}) {
  const notes = useNotes();

  if (notes === null) return null;
  const byId = new Map(notes.notes.map((note) => [note.id, note]));
  const hasGlobal = notes.notes.some((note) => note.anchor === undefined);

  const addGlobal = (): void => {
    const button = document.querySelector<HTMLElement>("[data-annotation-add-global]");

    if (button !== null) notes.write(undefined, "", button);
  };

  return (
    <AnnotationPanel isOpen={open} annotations={orderNotes(notes.notes, files.map((file) => file.path)).map(panelNote)} selectedId={notes.selected}
      width="19rem" onClose={onClose}
      onSelect={(id) => {
        const note = byId.get(id);

        notes.select(id);

        if (note !== undefined) onReveal(note);
      }}
      onDelete={notes.remove} onEdit={(id, updates) => notes.edit(id, updates.text ?? "")}
      placeOf={(annotation) => placeLabel(byId.get(annotation.id)?.anchor)}
      onAddGlobal={hasGlobal ? undefined : addGlobal} globalLabel="Note on all the changes" />
  );
}
