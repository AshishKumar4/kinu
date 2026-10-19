/**
 * One of the personal assistant's Important picks: who wrote, the subject, and the assistant's one line on why it
 * matters. The Mail page's Important view and Home's Today strip draw the same row (docs/MAIL.md §7).
 */
import { SparkleIcon } from "@phosphor-icons/react";

export interface ImportantMail {
  /** Opens `/mail?thread=<id>`. */
  readonly thread: string;
  readonly from: { readonly name: string; readonly address: string };
  /** The address it reached. */
  readonly to: string;
  readonly subject: string;
  /** The assistant's one line on why it is here. */
  readonly reason: string;
  readonly at: number;
  readonly unread: boolean;
}

const MINUTE = 60_000;

/** A mail's time as a list shows it: minutes within the hour, the clock today, the date before that. */
export function mailTime(at: number, now = Date.now()): string {
  if (now - at < 60 * MINUTE) return `${String(Math.max(1, Math.round((now - at) / MINUTE)))} min`;

  if (new Date(at).toDateString() === new Date(now).toDateString()) {
    return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function ImportantMailRow({ mail, open = false, onOpen }: { mail: ImportantMail; open?: boolean; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} data-important-mail={mail.thread} aria-current={open ? "true" : undefined}
      className={`flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors ${open
        ? "bg-[color-mix(in_srgb,var(--c-text)_8%,transparent)]"
        : "hover:bg-[color-mix(in_srgb,var(--c-text)_5%,transparent)]"}`}>
      <span className="flex min-w-0 items-baseline gap-2">
        {mail.unread && <span className="size-1.5 shrink-0 -translate-y-px self-center rounded-full p-dot-accent" aria-label="Unread" />}
        <span className={`min-w-0 truncate p-row-text ${mail.unread ? "font-semibold p-text" : "p-text-2"}`}>{mail.from.name}</span>
        <span className="ml-auto shrink-0 p-meta tabular-nums p-text-3">{mailTime(mail.at)}</span>
      </span>
      <span className={`truncate p-row-text ${mail.unread ? "p-text" : "p-text-2"}`}>{mail.subject}</span>
      <span className="flex min-w-0 items-start gap-1.5 p-meta p-text-2">
        <SparkleIcon size={12} weight="fill" className="mt-[3px] shrink-0 p-accent" aria-hidden />
        <span className="line-clamp-2">{mail.reason}</span>
      </span>
    </button>
  );
}
