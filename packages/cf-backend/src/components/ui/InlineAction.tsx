/**
 * An action inside running text, read as a link is (docs/DESIGN-SYSTEM.md §2): the sentence's own type in accent ink,
 * underlined on hover. A button, for a place in the app or an act; a link to a page stays an `<a>`.
 */
import type { ComponentProps } from "react";

export function InlineAction({ className, type = "button", ...rest }: ComponentProps<"button">) {
  return <button type={type} className={`p-inline-action${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}
