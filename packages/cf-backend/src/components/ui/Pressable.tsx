/**
 * The one unstyled clickable for a whole row or tile (docs/DESIGN-SYSTEM.md §2): a button with the system's hover wash
 * and focus ring and nothing else, so a feature never writes a raw `<button>` to make a block pressable. `selected`
 * gives it the selected ground, as a list's open row.
 */
import type { ComponentProps } from "react";
import { Link } from "react-router-dom";

const BASE = {
  row: "p-pressable",
  compact: "p-pressable p-pressable-compact",
  flush: "p-pressable p-pressable-flush",
  inline: "p-inline-action",
} satisfies Record<PressableLook, string>;

export type PressableLook = "row" | "compact" | "flush" | "inline";

/** `compact`: a strip inside a card or a bar (a fold's header, a menu's trigger), its own width at the control radius;
 *  `flush`: a row of a list in one box, edge to edge with no radius of its own; `inline`: an action inside running text
 *  (ui/InlineAction.tsx); `selected` is a row's; `open` a control whose panel is showing, on the fill. */
export function Pressable({ look = "row", className, type = "button", selected = false, open = false, ...rest }: ComponentProps<"button"> & {
  look?: PressableLook;
  selected?: boolean;
  open?: boolean;
}) {
  const base = BASE[look];

  return <button type={type} className={`${base}${className === undefined ? "" : ` ${className}`}`} data-selected={selected ? "" : undefined} data-open={open ? "" : undefined} {...rest} />;
}

/** The same, off the app (a page of its own, Sign out): a row that is a plain anchor. */
export function PressableAnchor({ className, ...rest }: ComponentProps<"a">) {
  return <a className={`p-pressable${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}

/** The same, to somewhere: a whole row or tile that is a link. */
export function PressableLink({ look = "row", className, selected = false, ...rest }: ComponentProps<typeof Link> & { look?: Exclude<PressableLook, "inline">; selected?: boolean }) {
  return <Link className={`${BASE[look]}${className === undefined ? "" : ` ${className}`}`} data-selected={selected ? "" : undefined} {...rest} />;
}
