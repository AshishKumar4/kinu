/**
 * An agent's outgoing mail as its approval card shows it in Needs-you (`AttentionStack`): the exact message, read as a
 * letter. Approving sends exactly these bytes, once (docs/MAIL.md §3); to change them, the owner writes in Mail.
 */
import type { MailSend } from "@kinu.run/core";
import { inputCls } from "@/components/ui/form";

/** The message's envelope, as the approval holds it: `by` is the agent that wrote it. */
type MailEnvelope = Pick<MailSend, "by" | "from" | "to" | "cc" | "subject">;

/** `onText`: the body as an editor, where the owner writes the mail (the Mail wireframe); absent, it is read. */
export function MailSendBody({ send, text, onText }: { send: MailEnvelope; text: string; onText?: (text: string) => void }) {
  return (
    <>
      <div className="t-body p-text">{send.by} wants to send this mail</div>
      <dl className="t-meta mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <dt className="p-text-3">From</dt><dd className="truncate p-text-2">{send.from}</dd>
        <dt className="p-text-3">To</dt><dd className="truncate p-text-2">{send.to.join(", ")}</dd>
        {send.cc.length > 0 && <><dt className="p-text-3">Cc</dt><dd className="truncate p-text-2" data-mail-send-cc>{send.cc.join(", ")}</dd></>}
        <dt className="p-text-3">Subject</dt><dd className="truncate p-text-2">{send.subject}</dd>
      </dl>
      {onText !== undefined
        ? <textarea value={text} onChange={(event) => onText(event.target.value)} rows={8} aria-label="The mail" className={`${inputCls} mt-1.5 font-[inherit]`} />
        : <p className="t-body mt-1.5 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-sm px-2 py-1.5 p-text-2 p-fill" data-mail-send-body>{text}</p>}
    </>
  );
}
