/**
 * The one unstyled clickable for a whole row or tile (docs/DESIGN-SYSTEM.md §2): a button with the system's hover wash
 * and focus ring and nothing else, so a feature never writes a raw `<button>` to make a block pressable. `selected`
 * gives it the selected ground, as a list's open row.
 */
import type { ComponentProps } from "react";

export function Pressable({ className, type = "button", selected = false, ...rest }: ComponentProps<"button"> & { selected?: boolean }) {
  return <button type={type} className={`p-pressable${className === undefined ? "" : ` ${className}`}`} data-selected={selected ? "" : undefined} {...rest} />;
}
