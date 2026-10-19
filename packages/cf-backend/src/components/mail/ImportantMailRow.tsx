/**
 * One of the personal assistant's Important picks, as a row of a `p-group`: who wrote, the subject, and the assistant's
 * one line on why it matters. The Mail page's Important view and Home's Today strip draw the same row (docs/MAIL.md §7).
 */
import { SparkleIcon } from "@phosphor-icons/react";
import type { ImportantMail } from "@/lib/mail-api";
import { Avatar } from "@/components/ui/Avatar";

const MINUTE = 60_000;

/** A mail's time as a list shows it: minutes within the hour, the clock today, the date before that. */
export function mailTime(at: number, now = Date.now()): string {
  if (now - at < 60 * MINUTE) return `${String(Math.max(1, Math.round((now - at) / MINUTE)))} min`;

  if (new Date(at).toDateString() === new Date(now).toDateString()) {
    return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** A row's ground: the open one raised a step, the rest lit only under the pointer. */
export const mailRowCls = (open: boolean): string =>
  `flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors ${open ? "bg-[var(--c-elevated)]" : "p-row-hover"}`;

export function ImportantMailRow({ mail, assistant, open = false, onOpen }: {
  mail: ImportantMail;
  /** The assistant's own name, as the owner called it: it is the one giving the reason. */
  assistant: string;
  open?: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} data-important-mail={mail.thread} aria-current={open ? "true" : undefined} className={mailRowCls(open)}>
      <Avatar name={mail.from.name} size={26} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`min-w-0 truncate p-row-text ${mail.unread ? "font-semibold p-text" : "p-text-2"}`}>{mail.from.name}</span>
          {mail.unread && <span className="size-1.5 shrink-0 -translate-y-px self-center rounded-full p-dot-accent" aria-label="Unread" />}
          <span className="ml-auto shrink-0 p-meta tabular-nums p-text-3">{mailTime(mail.at)}</span>
        </span>
        <span className={`block truncate p-row-text ${mail.unread ? "p-text" : "p-text-2"}`}>{mail.subject}</span>
        <span className="mt-1 flex min-w-0 items-start gap-1.5 p-meta p-text-2" title={`${assistant}: ${mail.reason}`}>
          <SparkleIcon size={12} weight="fill" className="mt-[3px] shrink-0 p-accent" aria-label={assistant} />
          <span className="line-clamp-2">{mail.reason}</span>
        </span>
      </span>
    </button>
  );
}
