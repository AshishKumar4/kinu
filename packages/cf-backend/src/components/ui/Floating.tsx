/**
 * A panel at a point on the page rather than beside a trigger (docs/DESIGN-SYSTEM.md §2, Popover): a selection's
 * toolbar, a comment's box. The overlay's ground, edge and lift at the card radius, above the page and its drawers.
 */
import type { ComponentProps, CSSProperties } from "react";
import { createPortal } from "react-dom";

export function Floating({ at, className, ...rest }: Omit<ComponentProps<"div">, "style"> & { at: CSSProperties }) {
  return createPortal(<div className={`p-floating${className === undefined ? "" : ` ${className}`}`} style={at} {...rest} />, document.body);
}
