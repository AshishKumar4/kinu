/**
 * A tool pane's items, the file browser's kind (docs/DESIGN-SYSTEM.md §2, Row at its densest): each a row, a tile or a
 * tree row that washes under the pointer, keeps what is open marked, shows the keys' cursor only while the list has the
 * keyboard, and dims what is hidden. The open one's name takes the item weight. A row's columns are its own.
 */
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";

export interface EntryState {
  /** Open in the viewer beside the list. */
  readonly open?: boolean;
  /** Where the keys' cursor is: marked while the list (`group/list`) has the keyboard's focus. */
  readonly cursor?: boolean;
  readonly hidden?: boolean;
  readonly tile?: boolean;
  /** Nothing to open: a machine that is not there. */
  readonly inert?: boolean;
}

/** An item's class and state attributes; an attribute the item is not in is left off. */
export interface EntryLook {
  readonly className: string;
  readonly "data-open": "" | undefined;
  readonly "data-cursor": "" | undefined;
  readonly "data-hidden": "" | undefined;
}

/** An item's look and state, for the row or tile element the pane lays out itself with `layout`. */
export function entryProps({ open = false, cursor = false, hidden = false, tile = false, inert = false }: EntryState, layout = ""): EntryLook {
  return {
    className: `p-entry${tile ? " p-entry-tile" : ""}${inert ? " p-entry-inert" : ""}${layout === "" ? "" : ` ${layout}`}`,
    "data-open": open ? "" : undefined,
    "data-cursor": cursor ? "" : undefined,
    "data-hidden": hidden ? "" : undefined,
  };
}

/** A row of the list that is a press, not an item: Load more, the way up. */
export function EntryButton({ className, type = "button", ...rest }: ComponentProps<"button">) {
  return <button type={type} className={`p-entry w-full text-left${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}

/** The list's column names, held at its top as it scrolls, on the pane's own ground. */
export function EntriesHead({ className, ...rest }: ComponentProps<"div">) {
  return <div aria-hidden="true" className={`p-entries-head${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}

/**
 * A row of a tree, `depth` steps in. A folder's caret is its own press: open or close it, where the row's press goes
 * into it. A file stands where a folder's caret would, so names line up.
 */
export function TreeRow({ depth, open, cursor, hidden, inert, fold, onOpen, title, className, children, ...data }: {
  depth: number;
  open?: boolean;
  cursor?: boolean;
  hidden?: boolean;
  inert?: boolean;
  /** Placement only: a row whose controls show on hover is a `group`. */
  className?: string;
  fold?: { readonly open: boolean; readonly label: string; readonly onToggle: () => void };
  onOpen?: () => void;
  title?: string;
  children: ReactNode;
} & Readonly<Record<`data-${string}`, string>>) {
  const indent: CSSProperties & { readonly "--tree-depth": string } = { "--tree-depth": String(depth) };

  return (
    <div {...entryProps({ open, cursor, hidden, inert }, className)} {...data} title={title} style={indent} onClick={onOpen} data-tree-row="">
      {fold === undefined ? <span className="p-tree-gap" aria-hidden="true" /> : (
        <button type="button" className="p-tree-fold" aria-label={fold.label} aria-expanded={fold.open}
          onClick={(event) => { event.stopPropagation(); fold.onToggle(); }}>
          {fold.open ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
        </button>
      )}
      {children}
    </div>
  );
}
