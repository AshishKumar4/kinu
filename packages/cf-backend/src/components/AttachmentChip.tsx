import { FileIcon, XIcon } from "@phosphor-icons/react";
import type { FileUIPart } from "ai";

export function AttachmentChip({ part, onRemove }: { part: FileUIPart; onRemove?: () => void }) {
  const name = part.filename ?? "file";

  return (
    <span className="t-meta inline-flex max-w-56 items-center gap-2 rounded-md border p-border p-fill px-1 py-1 p-text-2">
      {part.mediaType.startsWith("image/")
        ? <img src={part.url} alt={name} className="size-5 shrink-0 rounded-sm object-cover" />
        : <FileIcon size={13} className="shrink-0 p-text-3" />}
      <span className="truncate font-mono">{name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`}
          className="p-button-ghost cursor-pointer rounded-sm p-px">
          <XIcon size={11} />
        </button>
      )}
    </span>
  );
}
