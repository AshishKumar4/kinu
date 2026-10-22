/**
 * A list of sections to move between (docs/DESIGN-SYSTEM.md §2, the nav role): a strip of tabs that scrolls below its
 * breakpoint, a column of rows from it up, the open one on the selected ground. Settings' sections, a catalog's roles.
 * An item is a link where it has an address, a button where choosing it is the page's own state.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Link, type To } from "react-router-dom";

export interface RailItem {
  readonly id: string;
  readonly label: string;
  /** A 16 icon before the label. */
  readonly icon?: ReactNode;
  /** Under the label, in the column only. */
  readonly detail?: string;
  /** Beside the label: a mark of the item's state (a customized role's dot). */
  readonly mark?: ReactNode;
  readonly to?: To;
  readonly data?: Readonly<Record<`data-${string}`, string>>;
}

export function Rail({ label, items, current, onSelect, at = "lg", trailing, className }: {
  label: string;
  items: readonly RailItem[];
  current: string;
  /** For items with no address. */
  onSelect?: (id: string) => void;
  /** The width the strip becomes a column at. */
  at?: "md" | "lg";
  /** After the items: an item's add form, a "New" action. */
  trailing?: ReactNode;
  /** Placement only: a strip that runs to its card's or page's edge. */
  className?: string;
}) {
  const rail = useRef<HTMLElement>(null);

  // A deep link to the last item would otherwise open with the open tab off-screen.
  useEffect(() => {
    rail.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [current]);

  return (
    <nav ref={rail} aria-label={label} data-at={at} className={`p-rail p-tabstrip${className === undefined ? "" : ` ${className}`}`}>
      {items.map((item) => {
        const here = item.id === current ? "true" : undefined;

        const inner = (
          <>
            {item.icon}
            <span className="min-w-0 flex-1 text-left">
              <span className="flex items-center gap-2"><span className="truncate">{item.label}</span>{item.mark}</span>
              {item.detail !== undefined && <span className="p-rail-detail t-meta truncate">{item.detail}</span>}
            </span>
          </>
        );

        return item.to === undefined
          ? <button key={item.id} type="button" aria-current={here} className="p-rail-item t-control" onClick={() => onSelect?.(item.id)} {...item.data}>{inner}</button>
          : <Link key={item.id} to={item.to} aria-current={here} className="p-rail-item t-control" {...item.data}>{inner}</Link>;
      })}
      {trailing}
    </nav>
  );
}
