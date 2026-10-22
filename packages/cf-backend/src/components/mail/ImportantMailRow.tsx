/**
 * One of the personal assistant's Important picks, as a row of a `p-group`: who wrote, the subject, and the assistant's
 * reason as plain secondary text. The Mail page's Important view and Home's Today strip draw the same row (docs/MAIL.md §7).
 */
import type { ImportantMail } from "@/lib/mail-api";
import { Avatar } from "@/components/ui/Avatar";
import { Dot } from "@/components/ui/Dot";
import { Pressable } from "@/components/ui/Pressable";

const MINUTE = 60_000;

/** A mail's time as a list shows it: minutes within the hour, the clock today, the date before that. */
export function mailTime(at: number, now = Date.now()): string {
  if (now - at < 60 * MINUTE) return `${String(Math.max(1, Math.round((now - at) / MINUTE)))} min`;

  if (new Date(at).toDateString() === new Date(now).toDateString()) {
    return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** A mail's row: the avatar, then who and what; its ground is the flush row's, the open one on the fill. */
export const MAIL_ROW = "flex items-start gap-3 px-4 py-3";

export function ImportantMailRow({ mail, open = false, onOpen }: { mail: ImportantMail; open?: boolean; onOpen: () => void }) {
  return (
    <Pressable look="flush" onClick={onOpen} data-important-mail={mail.thread} aria-current={open ? "true" : undefined} className={MAIL_ROW}>
      <Avatar name={mail.from.name} size={26} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`t-body min-w-0 truncate ${mail.unread ? "t-label p-text" : "p-text-2"}`}>{mail.from.name}</span>
          {mail.unread && <Dot tone="accent" label="Unread" className="-translate-y-px self-center" />}
          <span className="t-meta ml-auto shrink-0 tabular-nums p-text-3">{mailTime(mail.at)}</span>
        </span>
        <span className={`t-body block truncate ${mail.unread ? "p-text" : "p-text-2"}`}>{mail.subject}</span>
        <span className="t-meta mt-px line-clamp-2 p-text-3">{mail.reason}</span>
      </span>
    </Pressable>
  );
}
