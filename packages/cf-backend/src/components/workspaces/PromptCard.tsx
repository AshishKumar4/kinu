import { Button } from "@/components/ui/Button";
import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { Loader } from "@/components/ui/Loader";
import { composing } from "@/components/ui/form";
import { AttachButton, AttachmentTray, pasteAttachments, type AttachmentsControl } from "@/components/Attachments";
import { useFileDrop } from "@/hooks/use-file-drop";
import { Notice } from "@/components/ui/Notice";
import { TextArea } from "@/components/ui/Field";

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
  const field = useRef<HTMLTextAreaElement>(null);

  // Ready to type into as the page opens, unless the reader is already typing elsewhere, in a modal opened before the
  // page arrived: `autoFocus` would take the focus from it mid-word.
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) field.current?.focus();
  }, []);

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();

    if (!busy) onSubmit();
  };

  return (
    <form onSubmit={submit} {...(attachments && handlers)} data-drag-over={dragOver || undefined}
      onPaste={(e) => { if (attachments) pasteAttachments(e, attachments, (text) => onChange(value === "" ? text : `${value}\n${text}`)); }}
      className="p-prompt-card p-focus min-w-0 border p-border">
      <div className="px-6 pt-5">
        <label htmlFor={id} className="t-status block p-text-3">{label}</label>
        <TextArea bare
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
          ref={field}
          disabled={busy}
          className="block min-h-32 pb-4 pt-3 t-composer p-text disabled:opacity-60"
        />
      </div>
      {attachments && <div className="px-3 pb-3 [&>[data-attachments]]:pt-0"><AttachmentTray attachments={attachments} /></div>}
      {notice && <div className="px-6 pb-4">{notice}</div>}
      {error && <Notice tone="danger" className="mx-6 mb-4">{error}</Notice>}
      <div className="flex items-center justify-end gap-2 px-6 pb-5">
        {attachments && <div className="-ml-2 mr-auto"><AttachButton attachments={attachments} disabled={busy} /></div>}
        <Button variant="primary" size="md" type="submit" disabled={busy || blocked} >
          {busy && <Loader size="sm" />}
          {action}
        </Button>
      </div>
    </form>
  );
}
