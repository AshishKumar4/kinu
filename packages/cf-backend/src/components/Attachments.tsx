/** The prompt boxes' attachments: chips, the paperclip, and paste. */
import { useRef, type ClipboardEvent } from "react";
import type { FileUIPart } from "ai";
import { FileIcon, PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { AttachmentChip } from "@/components/AttachmentChip";

export interface AttachmentsControl {
  readonly parts: readonly FileUIPart[];
  readonly onAdd: (files: FileList | null | undefined) => void;
  readonly onRemove: (index: number) => void;
  /** Send stays disabled until each failed upload is removed. */
  readonly failed?: readonly string[];
  readonly onRemoveFailed?: (index: number) => void;
}

/** Dedupe by File identity only: files with the same metadata can differ in bytes. */
function pastedFiles(data: DataTransfer): FileList {
  const { files, items } = data;

  if (files.length < 2) return files;
  const seenItems = new Set<DataTransferItem>();
  const seenFiles = new Set<File>();
  const unique = new DataTransfer();

  for (const item of items) {
    if (item.kind !== "file" || seenItems.has(item)) continue;
    seenItems.add(item);
    const file = item.getAsFile();

    if (file === null || seenFiles.has(file)) continue;
    seenFiles.add(file);
    unique.items.add(file);
  }

  return unique.files.length === 0 || unique.files.length === files.length ? files : unique.files;
}

/** Presence comes from string flavors, never content; HTML-only reads as its rendered text. */
function pastedText(data: DataTransfer): string {
  const plain = data.getData("text/plain");

  if (plain !== "") return plain;
  const html = data.getData("text/html");

  if (html === "") return "";
  const rendered = new DOMParser().parseFromString(html, "text/html").body.textContent;

  return rendered === null || rendered === "" ? html : rendered;
}

export function pasteAttachments(e: ClipboardEvent, attachments: AttachmentsControl, insert: (text: string) => void): void {
  const files = pastedFiles(e.clipboardData);

  if (files.length === 0) return;
  attachments.onAdd(files);
  const text = pastedText(e.clipboardData);

  // Never infer file-only from string content: a filename can be the intended text.
  if (text === "") {
    e.preventDefault();

    return;
  }

  // A plain flavor inserts natively (caret, undo); a textarea cannot take HTML, so that inserts as text.
  if (e.clipboardData.getData("text/plain") !== "") return;
  e.preventDefault();

  if (e.target instanceof HTMLTextAreaElement && document.execCommand("insertText", false, text)) return;
  insert(text);
}

export function AttachmentTray({ attachments }: { attachments: AttachmentsControl }) {
  const failed = attachments.failed ?? [];

  if (attachments.parts.length === 0 && failed.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-3" data-attachments>
      {attachments.parts.map((part, i) => (
        <AttachmentChip key={`${part.filename ?? "file"}-${i}`} part={part} onRemove={() => attachments.onRemove(i)} />
      ))}
      {failed.map((name, i) => (
        <span key={`failed-${name}-${i}`}
          className="inline-flex max-w-56 items-center gap-1.5 rounded-md border p-border p-fill px-1.5 py-1 p-meta p-text-2"
          title={`Could not attach ${name}`}>
          <FileIcon size={13} className="shrink-0 p-text-3" />
          <span className="truncate font-mono">{name}</span>
          <span className="shrink-0 font-medium p-warning">failed</span>
          {attachments.onRemoveFailed && (
            <button type="button" onClick={() => attachments.onRemoveFailed?.(i)} aria-label={`Remove ${name}`}
              className="p-btn-ghost cursor-pointer p-0.5">
              <XIcon size={11} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

export function AttachButton({ attachments, disabled }: { attachments: AttachmentsControl; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <input ref={input} type="file" multiple className="hidden"
        onChange={(e) => { attachments.onAdd(e.currentTarget.files); e.currentTarget.value = ""; }} />
      <button type="button" onClick={() => input.current?.click()} disabled={disabled}
        className="p-composer-round" aria-label="Attach files" title="Attach files">
        <PaperclipIcon size={17} />
      </button>
    </>
  );
}
