/** Rows in one box (docs/DESIGN-SYSTEM.md §2): the surface, a hairline and the card radius, rows split by a dashed rule. */
import type { ReactNode } from "react";

export function Group({ label, list = false, children, ...data }: {
  label?: string;
  /** Rows that are a list's items: the box is a `<ul>`, so a reader counts them. */
  list?: boolean;
  children: ReactNode;
} & Readonly<Record<`data-${string}`, string>>) {
  if (list) return <ul aria-label={label} className="p-group" {...data}>{children}</ul>;

  return <div role={label === undefined ? undefined : "group"} aria-label={label} className="p-group" {...data}>{children}</div>;
}
