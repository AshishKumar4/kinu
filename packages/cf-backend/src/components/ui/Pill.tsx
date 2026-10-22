/**
 * The chat's pills (docs/DESIGN-SYSTEM.md §2, Notice in the chat): a line above the composer or in the thread that says
 * one thing, with at most an action and a close. Its CSS is the approved pills'. One press per `part`: the whole `pill`
 * that opens, a pill's one `action` (`quiet`, ink only), or the count of pills folded behind the newest (`more`).
 */
import type { ComponentProps } from "react";

export type PillPart = "pill" | "action" | "more";

const PART: Readonly<Record<PillPart, string>> = { pill: "p-pill", action: "p-pill-action", more: "p-pill-more" };

export function PillButton({ part = "pill", quiet = false, className, type = "button", ...rest }: ComponentProps<"button"> & { part?: PillPart; quiet?: boolean }) {
  return <button type={type} className={`${PART[part]}${className === undefined ? "" : ` ${className}`}`} data-quiet={quiet ? "" : undefined} {...rest} />;
}
