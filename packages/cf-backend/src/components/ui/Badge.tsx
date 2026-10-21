/**
 * What a thing is, in a word (docs/DESIGN-SYSTEM.md §2): 20 tall at the control radius, in the micro role. `onPicture`
 * reads over any cover; `accent` marks the one featured thing.
 */
import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "onPicture";

export function Badge({ tone = "neutral", icon, children, className, ...data }: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  /** Placement only (`absolute left-2.5 top-2.5` on a cover). */
  className?: string;
} & Readonly<Record<`data-${string}`, string>>) {
  return <span className={`p-badge p-badge-${tone}${className === undefined ? "" : ` ${className}`}`} {...data}>{icon}{children}</span>;
}
