/**
 * A group of settings (docs/DESIGN-SYSTEM.md §2): its name as the one section label above it, its small actions on the
 * label's row, and its fields in one box at 20 inside and 20 apart. A card never holds a card, a group or a tinted box.
 */
import type { ReactNode } from "react";

export function Card({ title, actions, children }: {
  /** Absent where the page's own section header already names it: the box alone. */
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  if (title === undefined) return <section className="p-card-body">{children}</section>;

  return (
    <section className="space-y-2">
      <header className="flex min-h-7 items-end gap-3">
        <h2 className="min-w-0 flex-1 t-label">{title}</h2>
        {actions !== undefined && actions !== null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="p-card-body">{children}</div>
    </section>
  );
}
