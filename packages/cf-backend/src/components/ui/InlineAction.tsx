/**
 * An action inside running text, read as a link is (docs/DESIGN-SYSTEM.md §2): the sentence's own type in accent ink,
 * underlined on hover. A button, for a place in the app or an act; a link to a page stays an `<a>`.
 */
import type { ComponentProps } from "react";

/** `quiet`: the third ink, a dotted underline at rest, as a turn's Details and Retry are. */
export function InlineAction({ quiet = false, className, type = "button", ...rest }: ComponentProps<"button"> & { quiet?: boolean }) {
  return <button type={type} className={`p-inline-action${className === undefined ? "" : ` ${className}`}`} data-quiet={quiet ? "" : undefined} {...rest} />;
}
