import type { FormEvent, ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import { composing } from "@/components/ui/form";
import { AttachButton, AttachmentTray, pasteAttachments, type AttachmentsControl } from "@/components/Attachments";
import { useFileDrop } from "@/hooks/use-file-drop";

const NO_DROP = () => {};

/** The landing's prompt: one card, a label, the text, and the action. ⌘/Ctrl+Enter submits. */
export function PromptCard({ id, label, placeholder, action, value, onChange, onSubmit, busy, blocked = false, error, notice, attachments }: {
  id: string;
  label: string;
  placeholder: string;
  action: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  /** The action cannot run yet, as without a model to run it. */
  blocked?: boolean;
  error: string | null;
  notice?: ReactNode;
  attachments?: AttachmentsControl;
}) {
  const { dragOver, handlers } = useFileDrop(attachments?.onAdd ?? NO_DROP);

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();

    if (!busy) onSubmit();
  };

  return (
    <form onSubmit={submit} {...(attachments && handlers)} data-drag-over={dragOver || undefined}
      onPaste={(e) => { if (attachments) pasteAttachments(e, attachments, (text) => onChange(value === "" ? text : `${value}\n${text}`)); }}
      className="p-focus min-w-0 overflow-hidden rounded-2xl border p-border bg-[var(--c-input-bg)] shadow-[0_18px_55px_-42px_rgba(0,0,0,.75)] transition-[border-color,box-shadow] data-[drag-over]:border-[var(--c-accent)]">
      <div className="px-6 pt-5">
        <label htmlFor={id} className="block p-t-status p-text-3">{label}</label>
        <textarea
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composing(event.nativeEvent)) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={4}
          autoFocus
          disabled={busy}
          className="block min-h-[128px] w-full resize-none bg-transparent pb-4 pt-3 p-t-composer p-text outline-none focus-visible:!outline-none placeholder:p-text-3 disabled:opacity-60"
        />
      </div>
      {attachments && <div className="px-3 pb-3 [&>[data-attachments]]:pt-0"><AttachmentTray attachments={attachments} /></div>}
      {notice && <div className="px-6 pb-4">{notice}</div>}
      {error && <div className="mx-6 mb-4 rounded-md px-3 py-2 text-xs p-notice-danger">{error}</div>}
      <div className="flex items-center justify-end gap-2 px-6 pb-5">
        {attachments && <div className="-ml-2 mr-auto"><AttachButton attachments={attachments} disabled={busy} /></div>}
        <FilledButton type="submit" disabled={busy || blocked} className="!h-10 !rounded-full px-5 p-t-control">
          {busy && <Loader size="sm" />}
          {action}
        </FilledButton>
      </div>
    </form>
  );
}
