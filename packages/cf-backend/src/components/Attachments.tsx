/** The prompt boxes' attachments: chips, the paperclip, and paste. */
import { useRef, type ClipboardEvent } from "react";
import { PaperclipIcon } from "@phosphor-icons/react";
import { AttachmentChip } from "@/components/AttachmentChip";
import { FilePicker } from "@/components/ui/FilePicker";
import { IconControl } from "@/components/ui/IconControl";
import type { ShownAttachment } from "@/hooks/use-pending-attachments";

export interface AttachmentsControl {
  readonly items: readonly ShownAttachment[];
  readonly onAdd: (files: FileList | null | undefined) => void;
  readonly onRemove: (index: number) => void;
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

/** How many files a composer holds, and whether one is still on its way: the message waits for it, as it is sent by
 *  the path its upload answers. */
export function trayOf(attachments: AttachmentsControl | undefined) {
  const items = attachments?.items ?? [];

  return { held: items.length, uploading: items.some((item) => item.state.kind === "held" || item.state.kind === "uploading") };
}

export function AttachmentTray({ attachments }: { attachments: AttachmentsControl }) {
  if (attachments.items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3" data-attachments>
      {attachments.items.map((item, i) => (
        <AttachmentChip key={item.key} onRemove={() => attachments.onRemove(i)} state={item.state}
          part={{ type: "file", filename: item.name, mediaType: item.mediaType, url: item.preview ?? "" }} />
      ))}
    </div>
  );
}

export function AttachButton({ attachments, disabled }: { attachments: AttachmentsControl; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <FilePicker ref={input} multiple onChange={(e) => { attachments.onAdd(e.currentTarget.files); e.currentTarget.value = ""; }} />
      <IconControl place="composer" onClick={() => input.current?.click()} disabled={disabled} aria-label="Attach files" title="Attach files">
        <PaperclipIcon size={17} />
      </IconControl>
    </>
  );
}
