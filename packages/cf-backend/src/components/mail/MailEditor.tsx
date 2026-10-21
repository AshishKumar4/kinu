import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { ArrowBendUpLeftIcon, NotePencilIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { replySubject, type MailBox, type MailMessageView, type MailThreadView } from "@kinu.run/core";
import { useLabelledStep } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Choice, inputCls } from "@/components/ui/form";
import { saveMailDraft, sendMail, type MailWrite } from "@/lib/mail-api";

const recipients = (text: string): string[] => text.split(",").map((part) => part.trim()).filter(Boolean);

function saving(event: FormEvent<HTMLFormElement>): boolean {
  return event.nativeEvent instanceof SubmitEvent && event.nativeEvent.submitter?.getAttribute("value") === "draft";
}

function Failure({ message }: { message: string | null }) {
  return message === null ? null : <p role="alert" className="t-body p-danger">{message}</p>;
}

export function Compose({ boxes, initialPath, onClose, onSaved }: {
  boxes: readonly MailBox[]; initialPath: string; onClose: () => void; onSaved: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const form = useId();
  const { busy, error, run } = useLabelledStep(onClose);
  const disabled = busy !== null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const draft = saving(event);
    const message: MailWrite = { path, to: recipients(to), subject, text, ...(cc.trim() !== "" && { cc: recipients(cc) }) };

    run(draft ? "Saving" : "Sending", async () => {
      if (draft) await saveMailDraft(message);
      else await sendMail(message);
      onSaved();
    });
  };

  return (
    <Modal title="New message" icon={<NotePencilIcon size={18} />} onClose={onClose} busy={disabled} maxWidthClass="max-w-xl"
      footer={<>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onClose}>Discard</Button>
        <Button variant="secondary" size="sm" type="submit" form={form} name="intent" value="draft" disabled={disabled}>{busy === "Saving" ? "Saving…" : "Save draft"}</Button>
        <Button variant="primary" size="md" type="submit" form={form} name="intent" value="send" disabled={disabled}><PaperPlaneTiltIcon size={14} />{busy === "Sending" ? "Sending…" : "Send"}</Button>
      </>}>
      <form id={form} onSubmit={submit} data-mail-compose-form className="space-y-2">
        <div className="t-meta flex items-center gap-2 p-text-3" data-mail-from>From
          <div className="min-w-0 flex-1"><Choice label="From" value={path} onChange={setPath} disabled={disabled} options={boxes.map((box) => ({ value: box.path, label: box.address }))} /></div>
        </div>
        <input value={to} onChange={(event) => setTo(event.target.value)} type="email" multiple required placeholder="To" aria-label="To" disabled={disabled} className={inputCls} />
        <input value={cc} onChange={(event) => setCc(event.target.value)} type="email" multiple placeholder="Cc" aria-label="Cc" disabled={disabled} className={inputCls} />
        <input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Subject" aria-label="Subject" disabled={disabled} className={inputCls} />
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={8} required placeholder="Message" aria-label="Message" disabled={disabled} className={`${inputCls} font-[inherit] leading-6`} />
        <Failure message={error} />
      </form>
    </Modal>
  );
}

function replyRecipients(messages: readonly MailMessageView[]): readonly string[] {
  const received = [...messages].reverse().find((mail) => mail.direction === "in");

  return received === undefined ? messages.at(-1)?.to.map((party) => party.address) ?? [] : [received.from.address];
}

export function ReplyBox({ mail, box, drafts, onChanged, onSent }: {
  mail: MailThreadView; box: MailBox; drafts: boolean; onChanged: () => void; onSent: () => void;
}) {
  const draft = mail.messages.find((message) => message.sendState === "draft");
  const [editor, setEditor] = useState<{ text: string; draft: boolean } | null>(drafts ? { text: draft?.text ?? "", draft: true } : null);
  const text = editor?.text ?? null;
  const editing = editor?.draft === true ? draft : undefined;

  const { busy, error, run } = useLabelledStep(() => {
    setEditor(null);
    onChanged();
  });

  const to = editing?.to.map((party) => party.address) ?? replyRecipients(mail.messages);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (text === null) return;
    const keep = saving(event);

    const message: MailWrite = {
      path: box.path, to, subject: editing?.subject ?? replySubject(mail.thread.subject),
      text, threadId: mail.thread.id, ...(editing !== undefined && editing.cc.length > 0 && { cc: editing.cc.map((party) => party.address) }),
    };

    run(keep ? "Saving" : "Sending", async () => {
      if (keep) await saveMailDraft(message);
      else {
        await sendMail(message);
        onSent();
      }
    });
  };

  if (text === null) return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" data-mail-reply onClick={() => setEditor({ text: "", draft: false })}><ArrowBendUpLeftIcon size={14} />Reply</Button>
      {draft !== undefined && <Button variant="secondary" size="sm" data-mail-open-draft onClick={() => setEditor({ text: draft.text, draft: true })}><NotePencilIcon size={14} />{draft.writtenBy === null ? "Your draft" : "Kinu's draft"}</Button>}
    </div>
  );

  return (
    <form onSubmit={submit} data-mail-reply-box className="space-y-2">
      <p className="t-meta p-text-3 break-words">From {box.address}</p>
      <p className="t-meta p-text-3 break-words">To {to.join(", ")}</p>
      <textarea value={text} onChange={(event) => setEditor({ text: event.target.value, draft: editor?.draft === true })} rows={9} aria-label="Reply" required disabled={busy !== null} className={`${inputCls} font-[inherit] leading-6`} />
      <Failure message={error} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="md" data-mail-send type="submit" name="intent" value="send" disabled={busy !== null || text.trim() === ""}><PaperPlaneTiltIcon size={14} />{busy === "Sending" ? "Sending…" : "Send"}</Button>
        <Button variant="secondary" size="sm" type="submit" name="intent" value="draft" disabled={busy !== null || text.trim() === ""}>{busy === "Saving" ? "Saving…" : "Save draft"}</Button>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setEditor(null)}>Discard</Button>
      </div>
    </form>
  );
}
