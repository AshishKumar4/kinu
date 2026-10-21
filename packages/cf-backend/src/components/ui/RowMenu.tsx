/** A row's ⋯ menu: what the row offers past its status and its one switch, each item named for what it does. */
import { useCallback, useRef, useState, type ComponentType } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";

export interface RowMenuItem {
  readonly label: string;
  /** Its tooltip and accessible name where the label alone is ambiguous ("Revoke device"). */
  readonly title?: string;
  readonly icon: ComponentType<{ size?: number }>;
  readonly run: () => void;
  readonly danger?: boolean;
}

const ITEM = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm p-card-hover";

export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsideClick(open, menu, close);

  return (
    <div ref={menu} className="relative shrink-0">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} data-row-menu
        onClick={() => setOpen((value) => !value)}
        className="flex size-7 items-center justify-center rounded-[var(--r-control)] p-text-3 transition-colors hover:bg-[var(--c-hover)] hover:p-text">
        <DotsThreeIcon size={16} weight="bold" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-1 w-44 border p-border p-card p-1.5 p-shadow-menu">
          {items.map(({ label: itemLabel, title, icon: Icon, run, danger = false }) => (
            <button key={itemLabel} type="button" role="menuitem" title={title} aria-label={title}
              className={`${ITEM} ${danger ? "hover:p-danger" : ""}`}
              onClick={() => { setOpen(false); run(); }}>
              <Icon size={14} /> {itemLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
