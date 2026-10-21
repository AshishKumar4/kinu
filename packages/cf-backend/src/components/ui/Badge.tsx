/**
 * What a thing is, in a word (docs/DESIGN-SYSTEM.md §2): 20 tall at the control radius, in the micro role. `onPicture`
 * reads over any cover; `accent` marks the one featured thing.
 */
import type { ReactNode } from "react";

export function Badge({ tone = "neutral", icon, children }: { tone?: "neutral" | "accent" | "onPicture"; icon?: ReactNode; children: ReactNode }) {
  return <span className={`p-badge p-badge-${tone}`}>{icon}{children}</span>;
}
