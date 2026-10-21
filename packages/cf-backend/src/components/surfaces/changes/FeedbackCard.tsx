import { ChatCircleTextIcon, ListBulletsIcon, MinusCircleIcon } from "@phosphor-icons/react";
import type { ChangeNotesCard, DiffAnchor } from "@kinu.run/core";
import { sinceLabel } from "./diff";
import { placeLabel } from "./notes";
import { Bubble, BubbleRule } from "@/components/ui/Bubble";
import { Pressable } from "@/components/ui/Pressable";

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
      <span className={`flex h-5 shrink-0 items-center ${TYPE_TONE[note.type]}`}><Icon size={14} weight="bold" /></span>
      <span className="min-w-0 flex-1">
        <span className="t-meta t-mono block truncate p-text-3 group-hover:p-text-2">{placeLabel(note.anchor)}</span>
        <span className="t-body line-clamp-2 p-text group-hover:underline">
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
      <Bubble notes>
        <p className="t-body flex items-baseline gap-2">
          <strong className="p-text">{card.notes.length} {card.notes.length === 1 ? "note" : "notes"} on the changes</strong>
          <span className="t-meta p-text-3">{files} {files === 1 ? "file" : "files"} · {sinceLabel(sentAt, now)}</span>
        </p>
        <BubbleRule className="mt-2 pt-1">
          {card.notes.map((note) => (
            <li key={note.id}>
              {onOpen === undefined
                ? <div className="flex items-start gap-3 py-2"><NoteRow note={note} /></div>
                : (
                  <Pressable className="group flex items-start gap-3 py-2" onClick={() => onOpen(note.anchor)} data-feedback-note={note.id}>
                    <NoteRow note={note} />
                  </Pressable>
                )}
            </li>
          ))}
        </BubbleRule>
      </Bubble>
    </div>
  );
}
