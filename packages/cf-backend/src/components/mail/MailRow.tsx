import { PaperclipIcon, ShieldWarningIcon } from "@phosphor-icons/react";
import type { MailBox, MailThreadSummary } from "@kinu.run/core";
import { Avatar } from "@/components/ui/Avatar";
import { mailRowCls, mailTime } from "./ImportantMailRow";
import { mailExcerpt } from "./MailMessage";

export function mailBoxLabel(box: MailBox): string {
  if (box.kind === "person") return box.address;

  if (box.kind === "agent") return `${box.path.split(".")[0]} · ${box.workspace ?? box.path.split(".").slice(1).join(".")}`;

  return box.workspace ?? box.path;
}

export function MailRow({ thread, open, box, drafts, owner, onOpen }: {
  thread: MailThreadSummary; open: boolean; box: MailBox | undefined; drafts: boolean; owner: string; onOpen: () => void;
}) {
  const who = thread.from.map((party) => party.address.toLowerCase() === owner.toLowerCase() && thread.verified ? "You" : party.name ?? party.address).join(", ");
  const name = thread.from[0]?.name ?? thread.from[0]?.address ?? "";

  return (
    <button type="button" onClick={onOpen} data-mail-thread={thread.id} aria-current={open ? "true" : undefined} className={mailRowCls(open)}>
      <Avatar name={name} size={26} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`min-w-0 truncate p-row-text ${thread.unread ? "font-semibold p-text" : "p-text-2"}`}>{who}</span>
          {thread.unread && <span className="size-1.5 shrink-0 -translate-y-px self-center rounded-full p-dot-accent" aria-label="Unread" />}
          {!thread.verified && <ShieldWarningIcon size={13} weight="fill" className="shrink-0 self-center p-warning" aria-label="Not verified" />}
          <span className="ml-auto shrink-0 p-meta tabular-nums p-text-3">{mailTime(thread.at)}</span>
        </span>
        <span className={`block truncate p-row-text ${thread.unread ? "p-text" : "p-text-2"}`}>
          {thread.subject || "(No subject)"}{thread.count > 1 && <span className="p-text-3"> · {thread.count}</span>}
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 p-meta p-text-3">
          {box !== undefined && <span className="max-w-36 shrink-0 truncate rounded-sm bg-[var(--c-neutral-tint)] px-1 p-text-2">{mailBoxLabel(box)}</span>}
          {thread.attachments && <PaperclipIcon size={11} className="shrink-0 self-center" aria-label="Attachment" />}
          <span className={`truncate ${drafts ? "p-warning" : ""}`}>{mailExcerpt(thread.snippet)}</span>
        </span>
      </span>
    </button>
  );
}
