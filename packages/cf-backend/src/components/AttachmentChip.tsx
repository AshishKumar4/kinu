import { FileIcon } from "@phosphor-icons/react";
import { Chip } from "@/components/ui/Chip";
import type { FileUIPart } from "ai";
import { Surface } from "@/components/ui/Surface";
import type { AttachmentState } from "@/hooks/use-pending-attachments";

/** How much of an upload has gone, 0 to 1; null for a file that is not going. */
function shareOf(state: AttachmentState | undefined): number | null {
  if (state?.kind === "uploading") return state.share;

  return state?.kind === "held" ? 0 : null;
}

/** A file as a chip; in a composer, `state` says how far its upload is (a share while it goes, the refusal if it failed). */
export function AttachmentChip({ part, onRemove, state }: { part: FileUIPart; onRemove?: () => void; state?: AttachmentState }) {
  const name = part.filename ?? "file";
  const going = shareOf(state);

  return (
    <span className="inline-flex max-w-56 min-w-0" title={state?.kind === "failed" ? state.error : undefined}>
      <Chip removeLabel={`Remove ${name}`} onRemove={onRemove} tone={state?.kind === "failed" ? "danger" : "neutral"}
        data-attachment={state?.kind ?? "sent"} {...(going !== null && { "data-attachment-share": String(Math.round(going * 100)) })}
        icon={part.mediaType.startsWith("image/") && part.url !== ""
          ? <Surface look="clip" as="img" className="size-5 shrink-0 object-cover" src={part.url} alt={name} />
          : <FileIcon size={14} className="shrink-0 p-text-3" />}>
        <span className="truncate t-mono">{name}</span>
        {going !== null && <span className="t-meta p-text-3 shrink-0 tabular-nums" data-attachment-progress>{Math.round(going * 100)}%</span>}
      </Chip>
    </span>
  );
}
