import { ChatCircleTextIcon, ListBulletsIcon, MinusCircleIcon } from "@phosphor-icons/react";
import type { ChangeNotesCard, DiffAnchor } from "@kinu.run/core";
import { sinceLabel } from "./diff";
import { placeLabel } from "./notes";

type CardNote = ChangeNotesCard["notes"][number];

const TYPE_ICON: Record<CardNote["type"], typeof ChatCircleTextIcon> = {
  COMMENT: ChatCircleTextIcon,
  DELETION: MinusCircleIcon,
  GLOBAL_COMMENT: ListBulletsIcon,
};

const TYPE_TONE: Record<CardNote["type"], string> = {
  COMMENT: "p-info",
  DELETION: "p-danger",
  GLOBAL_COMMENT: "p-text-3",
};

function NoteRow({ note }: { note: CardNote }) {
  const Icon = TYPE_ICON[note.type];

  return (
    <>
      <Icon size={14} weight="bold" className={`mt-[3px] shrink-0 ${TYPE_TONE[note.type]}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11.5px] p-text-3 group-hover:p-text-2">{placeLabel(note.anchor)}</span>
        <span className="line-clamp-2 p-row-text p-text group-hover:underline">
          {note.type === "DELETION" && note.text === undefined ? "Remove this." : note.text}
        </span>
      </span>
    </>
  );
}

export function FeedbackCard({ card, sentAt, now, onOpen }: {
  card: ChangeNotesCard;
  sentAt: number;
  now: number;
  onOpen?: (anchor: DiffAnchor | undefined) => void;
}) {
  const files = new Set(card.notes.flatMap((note) => (note.anchor === undefined ? [] : [note.anchor.path]))).size;

  return (
    <div className="flex justify-end" data-feedback-card>
      <div className="w-full max-w-[min(85%,34rem)] rounded-t-2xl rounded-bl-2xl rounded-br-[4px] p-user-bubble px-4 pb-2 pt-3">
        <p className="flex items-baseline gap-2 p-row-text">
          <span className="font-medium p-text">{card.notes.length} {card.notes.length === 1 ? "note" : "notes"} on the changes</span>
          <span className="p-meta p-text-3">{files} {files === 1 ? "file" : "files"} · {sinceLabel(sentAt, now)}</span>
        </p>
        <ul className="mt-2 border-t border-[var(--c-user-border)] pt-1">
          {card.notes.map((note) => (
            <li key={note.id}>
              {onOpen === undefined
                ? <div className="flex items-start gap-2.5 py-2"><NoteRow note={note} /></div>
                : (
                  <button type="button" onClick={() => onOpen(note.anchor)} data-feedback-note={note.id}
                    className="group flex w-full items-start gap-2.5 py-2 text-left">
                    <NoteRow note={note} />
                  </button>
                )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
