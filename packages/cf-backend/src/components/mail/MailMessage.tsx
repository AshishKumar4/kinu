import { useState } from "react";
import { Link } from "react-router-dom";
import { SealCheckIcon, ShieldWarningIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import { sandboxedHtml, splitQuotedReply, type MailBox, type MailMessageView } from "@kinu.run/core";
import { Avatar } from "@/components/ui/Avatar";
import { AttachmentChip } from "@/components/AttachmentChip";
import { mailTime } from "./ImportantMailRow";
import { Pressable } from "@/components/ui/Pressable";

export function mailExcerpt(text: string): string {
  const lines = splitQuotedReply(text).own.split("\n").map((line) => line.trim()).filter(Boolean);
  const greeting = /^(hi|hello|hey)\b[^.!?]{0,24},$/iu.test(lines[0] ?? "");

  return (greeting ? lines.slice(1) : lines).join(" ");
}

export function MailBody({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  const { own, quote } = splitQuotedReply(text);

  return (
    <div className="space-y-2">
      <div className="t-body space-y-3 p-text">
        {own.split(/\n{2,}/u).map((paragraph, index) => <p key={index} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{paragraph}</p>)}
      </div>
      {quote !== null && (shown
        ? <p data-mail-quote className="t-body whitespace-pre-wrap break-words border-l-2 p-border pl-3 p-text-3 [overflow-wrap:anywhere]">{quote}</p>
        : <button type="button" onClick={() => setShown(true)} data-mail-show-quote aria-label="Show the quoted mail" title="Show the quoted mail"
          className="t-meta rounded-full bg-[var(--c-hover)] px-2 p-text-3 hover:p-text">•••</button>)}
    </div>
  );
}

export function SealedMailHtml({ html }: { html: string }) {
  const height = Math.min(520, Math.max(220, Math.round(html.replace(/<[^>]+>/gu, "").length * 0.85)));

  return (
    <div className="resize-y overflow-hidden rounded-lg border p-border bg-white" style={{ height }}>
      <iframe title="Message" sandbox="" referrerPolicy="no-referrer" srcDoc={sandboxedHtml(html)} data-mail-sealed className="block h-full w-full" />
    </div>
  );
}

function MessageHeader({ mail, name, onToggle }: { mail: MailMessageView; name: string; onToggle: () => void }) {
  return (
      <Pressable className="flex items-start gap-3" onClick={onToggle} aria-expanded="true">
        <Avatar name={name} size={30} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="t-item p-text">{name}</span>
            <span className="t-meta min-w-0 truncate p-text-3">{mail.from.address}</span>
            {mail.verified
              ? <span data-mail-verified title={mail.auth ?? undefined} className="t-meta inline-flex shrink-0 items-center gap-1 p-text-3"><SealCheckIcon size={13} weight="fill" className="p-accent-fg" />Verified</span>
              : <span data-mail-unverified title={mail.auth ?? undefined} className="t-meta inline-flex shrink-0 items-center gap-1 p-warning"><ShieldWarningIcon size={13} weight="fill" />Not verified</span>}
          </span>
          <span className="t-meta block truncate p-text-3">to {mail.to.map((party) => party.address).join(", ")}</span>
          {mail.cc.length > 0 && <span className="t-meta block truncate p-text-3">cc {mail.cc.map((party) => party.address).join(", ")}</span>}
        </span>
        <span className="t-meta shrink-0 tabular-nums p-text-3">{mailTime(mail.at)}</span>
      </Pressable>
  );
}

export function MailMessage({ mail, box, owner, open, onToggle }: {
  mail: MailMessageView; box: MailBox | undefined; owner: string; open: boolean; onToggle: () => void;
}) {
  const name = mail.direction === "out" && mail.writtenBy === null || mail.verified && mail.from.address.toLowerCase() === owner.toLowerCase()
    ? "You" : mail.from.name ?? mail.from.address;

  const reader = box?.kind === "person" ? "Kinu" : box?.path.split(".")[0] ?? "";
  const chat = box?.workspace === null || box?.workspace === undefined ? null : `/workspace/${encodeURIComponent(box.workspace)}${box.kind === "agent" ? `/agents/${encodeURIComponent(reader)}` : ""}`;

  if (!open) return (
    <Pressable className="flex items-center gap-3 px-4 py-2" onClick={onToggle} data-mail-message={mail.id} data-folded="">
      <Avatar name={name} size={22} />
      <span className="t-item shrink-0 p-text-2">{name}</span>
      <span className="t-body min-w-0 flex-1 truncate p-text-3">{mailExcerpt(mail.text)}</span>
      <span className="t-meta shrink-0 tabular-nums p-text-3">{mailTime(mail.at)}</span>
    </Pressable>
  );

  return (
    <article data-mail-message={mail.id} className="space-y-3 px-4 py-4">
      <MessageHeader mail={mail} name={name} onToggle={onToggle} />
      {mail.woke !== null && <p data-mail-woke={mail.woke} className="t-meta p-text-3">Woke {reader}{chat !== null && <> · <Link to={chat} className="inline-flex items-center gap-px p-accent-fg hover:underline">Open chat<ArrowUpRightIcon size={11} /></Link></>}</p>}
      {mail.direction === "out" && mail.writtenBy !== null && <p className="t-meta p-text-3">Written by {mail.writtenBy} · approved by you</p>}
      {mail.sendState !== null && ["queued", "failed"].includes(mail.sendState) && <p className="t-meta p-text-3">{mail.sendState}</p>}
      {mail.html === null ? <MailBody text={mail.text} /> : <SealedMailHtml html={mail.html} />}
      {mail.attachments.length > 0 && <div className="flex flex-wrap gap-2" data-mail-attachments>
        {mail.attachments.map((file) => <AttachmentChip key={file.id} part={{ type: "file", filename: file.filename, mediaType: "application/octet-stream", url: "about:blank" }} />)}
      </div>}
    </article>
  );
}
