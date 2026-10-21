import { useState } from "react";
import { Link } from "react-router-dom";
import { SealCheckIcon, ShieldWarningIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import { sandboxedHtml, splitQuotedReply, type MailBox, type MailMessageView } from "@kinu.run/core";
import { Avatar } from "@/components/ui/Avatar";
import { AttachmentChip } from "@/components/AttachmentChip";
import { mailTime } from "./ImportantMailRow";

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
      <div className="space-y-3 text-[14px] leading-6 p-text">
        {own.split(/\n{2,}/u).map((paragraph, index) => <p key={index} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{paragraph}</p>)}
      </div>
      {quote !== null && (shown
        ? <p data-mail-quote className="whitespace-pre-wrap break-words border-l-2 p-border pl-3 p-row-text p-text-3 [overflow-wrap:anywhere]">{quote}</p>
        : <button type="button" onClick={() => setShown(true)} data-mail-show-quote aria-label="Show the quoted mail" title="Show the quoted mail"
          className="rounded-full bg-[var(--c-neutral-tint)] px-2 leading-4 p-meta p-text-3 hover:p-text">•••</button>)}
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
      <button type="button" onClick={onToggle} aria-expanded="true" className="flex w-full items-start gap-3 text-left">
        <Avatar name={name} size={30} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="p-row-text font-medium p-text">{name}</span>
            <span className="min-w-0 truncate p-meta p-text-3">{mail.from.address}</span>
            {mail.verified
              ? <span data-mail-verified title={mail.auth ?? undefined} className="inline-flex shrink-0 items-center gap-1 p-meta p-text-3"><SealCheckIcon size={13} weight="fill" className="p-accent" />Verified</span>
              : <span data-mail-unverified title={mail.auth ?? undefined} className="inline-flex shrink-0 items-center gap-1 p-meta p-warning"><ShieldWarningIcon size={13} weight="fill" />Not verified</span>}
          </span>
          <span className="block truncate p-meta p-text-3">to {mail.to.map((party) => party.address).join(", ")}</span>
          {mail.cc.length > 0 && <span className="block truncate p-meta p-text-3">cc {mail.cc.map((party) => party.address).join(", ")}</span>}
        </span>
        <span className="shrink-0 p-meta tabular-nums p-text-3">{mailTime(mail.at)}</span>
      </button>
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
    <button type="button" onClick={onToggle} data-mail-message={mail.id} data-folded="" className="flex w-full items-center gap-3 px-4 py-2.5 text-left p-row-hover">
      <Avatar name={name} size={22} />
      <span className="shrink-0 p-row-text font-medium p-text-2">{name}</span>
      <span className="min-w-0 flex-1 truncate p-row-text p-text-3">{mailExcerpt(mail.text)}</span>
      <span className="shrink-0 p-meta tabular-nums p-text-3">{mailTime(mail.at)}</span>
    </button>
  );

  return (
    <article data-mail-message={mail.id} className="space-y-3 px-4 py-4">
      <MessageHeader mail={mail} name={name} onToggle={onToggle} />
      {mail.woke !== null && <p data-mail-woke={mail.woke} className="p-meta p-text-3">Woke {reader}{chat !== null && <> · <Link to={chat} className="inline-flex items-center gap-0.5 p-accent-fg hover:underline">Open chat<ArrowUpRightIcon size={11} /></Link></>}</p>}
      {mail.direction === "out" && mail.writtenBy !== null && <p className="p-meta p-text-3">Written by {mail.writtenBy} · approved by you</p>}
      {mail.sendState !== null && ["queued", "failed"].includes(mail.sendState) && <p className="p-meta p-text-3">{mail.sendState}</p>}
      {mail.html === null ? <MailBody text={mail.text} /> : <SealedMailHtml html={mail.html} />}
      {mail.attachments.length > 0 && <div className="flex flex-wrap gap-1.5" data-mail-attachments>
        {mail.attachments.map((file) => <AttachmentChip key={file.id} part={{ type: "file", filename: file.filename, mediaType: "application/octet-stream", url: "about:blank" }} />)}
      </div>}
    </article>
  );
}
