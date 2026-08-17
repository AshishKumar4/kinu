/**
 * A file attachment, as a chip. Shared by the composer (where it is removable)
 * and by message rendering (where it is not), which is why it lives here rather
 * than inside either one.
 */
import { FileIcon, XIcon } from "@phosphor-icons/react";
import type { FileUIPart } from "ai";

/** Raw bytes a data-URL file part encodes (base64 ≈ 4/3 × raw). */
export function dataUrlRawBytes(url: string): number {
  return Math.floor(((url.length - url.indexOf(",") - 1) * 3) / 4);
}

export function AttachmentChip({ part, onRemove }: { part: FileUIPart; onRemove?: () => void }) {
  const name = part.filename ?? "file";
  return (
    <span className="inline-flex max-w-56 items-center gap-1.5 rounded-md border p-border p-fill px-1.5 py-1 p-meta p-text-2">
      {part.mediaType.startsWith("image/")
        ? <img src={part.url} alt={name} className="size-5 shrink-0 rounded-sm object-cover" />
        : <FileIcon size={13} className="shrink-0 p-text-3" />}
      <span className="truncate font-mono">{name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`}
          className="p-btn-ghost cursor-pointer p-0.5">
          <XIcon size={11} />
        </button>
      )}
    </span>
  );
}
