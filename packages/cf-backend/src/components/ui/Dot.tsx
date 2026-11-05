/**
 * A state shown by its 6 dot alone (docs/DESIGN-SYSTEM.md §2, Status without its words): unread, new, failed, live.
 * `label` is read out in its place; without one the dot is decoration beside words that already say it.
 */
import type { StatusTone } from "./Status";

export function Dot({ tone, pulse = false, label, className, ...data }: {
  tone: StatusTone;
  pulse?: boolean;
  label?: string;
  /** Placement only. */
  className?: string;
} & Readonly<Record<`data-${string}`, string>>) {
  return (
    <span className={`p-dot ${tone === "live" ? "p-dot-accent" : `p-dot-${tone}`}${pulse || tone === "live" ? " p-dot-pulse" : ""}${className === undefined ? "" : ` ${className}`}`}
      role={label === undefined ? undefined : "img"} aria-label={label} title={label} aria-hidden={label === undefined ? true : undefined} {...data} />
  );
}
