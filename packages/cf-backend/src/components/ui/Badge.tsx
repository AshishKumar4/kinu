/**
 * What a thing is, in a word (docs/DESIGN-SYSTEM.md §2): 20 tall at the control radius, in the micro role. `onPicture`
 * reads over any cover; `accent` marks the one featured thing; `info` says where a figure comes from.
 */
import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "info" | "onPicture";

export function Badge({ tone = "neutral", icon, title, children, className, ...data }: {
  tone?: BadgeTone;
  icon?: ReactNode;
  /** What it means, on hover. */
  title?: string;
  children: ReactNode;
  /** Placement only (`absolute left-3 top-3` on a cover). */
  className?: string;
} & Readonly<Record<`data-${string}`, string>>) {
  return <span className={`p-badge p-badge-${tone}${className === undefined ? "" : ` ${className}`}`} title={title} {...data}>{icon}{children}</span>;
}

/** A count over a mark (an avatar's unread, a bar icon's open runs): `accent` filled and ringed in the ground it sits on,
 *  `quiet` on the fill, `bar` the accent at the quiet one's size, ringed in the workspace bar's ground; 9 and more say 9+. */
export function Count({ count, tone = "accent", label, ...data }: { count: number; tone?: "accent" | "quiet" | "bar"; label?: string } & Readonly<Record<`data-${string}`, string | number>>) {
  return <span className={`p-count p-count-${tone} t-micro tabular-nums`} aria-label={label} {...data}>{count > 9 ? "9+" : count}</span>;
}
