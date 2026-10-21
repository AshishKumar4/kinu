import { FileIcon } from "@phosphor-icons/react";
import { Chip } from "@/components/ui/Chip";
import type { FileUIPart } from "ai";

export function AttachmentChip({ part, onRemove }: { part: FileUIPart; onRemove?: () => void }) {
  const name = part.filename ?? "file";

  return (
    <span className="inline-flex max-w-56 min-w-0">
      <Chip removeLabel={`Remove ${name}`} onRemove={onRemove}
        icon={part.mediaType.startsWith("image/")
          ? <img src={part.url} alt={name} className="size-5 shrink-0 rounded-[var(--r-check)] object-cover" />
          : <FileIcon size={14} className="shrink-0 p-text-3" />}>
        <span className="truncate t-mono">{name}</span>
      </Chip>
    </span>
  );
}
