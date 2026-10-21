/**
 * The person's own words in the thread (docs/DESIGN-SYSTEM.md §2): one warm plane whose clipped corner points at them.
 * `notes` is the narrower bubble a review's notes are sent in; `BubbleRule` splits its heading from the notes.
 */
import type { ReactNode } from "react";

export function Bubble({ notes = false, className, children }: { notes?: boolean; className?: string; children: ReactNode }) {
  return <div className={`p-user-bubble${notes ? " p-user-bubble-notes" : ""}${className === undefined ? "" : ` ${className}`}`}>{children}</div>;
}

export function BubbleRule({ className, children }: { className?: string; children: ReactNode }) {
  return <ul className={`p-user-bubble-rule${className === undefined ? "" : ` ${className}`}`}>{children}</ul>;
}
