/** Notes once sent: the card the thread draws. What the agent reads is a sample in DESIGN.md; the build writes it in core. */
import { ChatCircleTextIcon, ListBulletsIcon, MinusCircleIcon } from "@phosphor-icons/react";
import { AnnotationType } from "@plannotator/ui/types";
import type { ChangeSet } from "@kinu.run/core";
import { sinceLabel } from "@/components/surfaces/changes/diff";
import { orderNotes, placeLabel, type ChangeNote } from "@/components/surfaces/changes/notes";

const TYPE_ICON: Record<AnnotationType, typeof ChatCircleTextIcon> = {
  [AnnotationType.COMMENT]: ChatCircleTextIcon,
  [AnnotationType.DELETION]: MinusCircleIcon,
  [AnnotationType.GLOBAL_COMMENT]: ListBulletsIcon,
};

const TYPE_TONE: Record<AnnotationType, string> = {
  [AnnotationType.COMMENT]: "p-info",
  [AnnotationType.DELETION]: "p-danger",
  [AnnotationType.GLOBAL_COMMENT]: "p-text-3",
};

export function FeedbackCard({ notes, set, sentAt, now, onOpen }: {
  notes: readonly ChangeNote[];
  set: ChangeSet;
  sentAt: number;
  now: number;
  onOpen: (note: ChangeNote) => void;
}) {
  const files = new Set(notes.flatMap((note) => (note.anchor === undefined ? [] : [note.anchor.path]))).size;
  const ordered = orderNotes(notes, set.files.map((file) => file.path));

  return (
    <div className="flex justify-end" data-feedback-card>
      <div className="w-full max-w-[min(85%,34rem)] rounded-t-2xl rounded-bl-2xl rounded-br-[4px] p-user-bubble px-4 pb-2 pt-3">
        <p className="flex items-baseline gap-2 p-row-text">
          <span className="font-medium p-text">{notes.length} {notes.length === 1 ? "note" : "notes"} on the changes</span>
          <span className="p-meta p-text-3">{files} {files === 1 ? "file" : "files"} · {sinceLabel(sentAt, now)}</span>
        </p>
        <ul className="mt-2 border-t border-[var(--c-user-border)] pt-1">
          {ordered.map((note) => {
            const Icon = TYPE_ICON[note.type];

            return (
              <li key={note.id}>
                <button type="button" onClick={() => onOpen(note)} data-feedback-note={note.id}
                  className="group flex w-full items-start gap-2.5 py-2 text-left">
                  <Icon size={14} weight="bold" className={`mt-[3px] shrink-0 ${TYPE_TONE[note.type]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[11.5px] p-text-3 group-hover:p-text-2">{placeLabel(note.anchor)}</span>
                    <span className="line-clamp-2 p-row-text p-text group-hover:underline">
                      {note.type === AnnotationType.DELETION && note.text === undefined ? "Remove this." : note.text}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
