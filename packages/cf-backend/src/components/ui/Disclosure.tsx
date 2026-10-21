/**
 * A part the page opens on closed (docs/DESIGN-SYSTEM.md §2): one row naming it and, folded, saying what is inside; its
 * caret turns on `--dur-fold`. The body is drawn only while open, so what it holds is not read before it is asked for.
 */
import { useId, useState, type ReactNode } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";

export function Disclosure({ label, summary, defaultOpen = false, children, ...data }: {
  label: ReactNode;
  /** What is inside, on the row, while it is folded and open alike. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
} & Readonly<Record<`data-${string}`, string>>) {
  const [open, setOpen] = useState(defaultOpen);
  const body = useId();

  return (
    <div {...data}>
      <button type="button" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)} className="p-disclosure">
        <CaretRightIcon size={14} className={`shrink-0 p-fold-turn p-text-3${open ? " rotate-90" : ""}`} />
        <span className="t-item shrink-0">{label}</span>
        {summary !== undefined && <span className="t-meta min-w-0 flex-1 truncate">{summary}</span>}
      </button>
      {open && <div id={body} className="mt-3">{children}</div>}
    </div>
  );
}
