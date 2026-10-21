/**
 * The one unstyled clickable for a whole row or tile (docs/DESIGN-SYSTEM.md §2): a button with the system's hover wash
 * and focus ring and nothing else, so a feature never writes a raw `<button>` to make a block pressable. `selected`
 * gives it the selected ground, as a list's open row.
 */
import type { ComponentProps } from "react";
import { Link } from "react-router-dom";

/** `inline`: an action inside running text (ui/InlineAction.tsx); `selected` is a row's. */
export function Pressable({ look = "row", className, type = "button", selected = false, ...rest }: ComponentProps<"button"> & {
  look?: "row" | "inline";
  selected?: boolean;
}) {
  const base = look === "row" ? "p-pressable" : "p-inline-action";

  return <button type={type} className={`${base}${className === undefined ? "" : ` ${className}`}`} data-selected={selected ? "" : undefined} {...rest} />;
}

/** The same, to somewhere: a whole row or tile that is a link. */
export function PressableLink({ className, selected = false, ...rest }: ComponentProps<typeof Link> & { selected?: boolean }) {
  return <Link className={`p-pressable${className === undefined ? "" : ` ${className}`}`} data-selected={selected ? "" : undefined} {...rest} />;
}
