/** Rows in one box (docs/DESIGN-SYSTEM.md §2): the surface, a hairline and the card radius, rows split by a dashed rule. */
import type { ReactNode } from "react";

export function Group({ label, children }: { label?: string; children: ReactNode }) {
  return <div role={label === undefined ? undefined : "group"} aria-label={label} className="p-group">{children}</div>;
}
