/**
 * A press in the app's settled chrome (docs/DESIGN-SYSTEM.md §2), on that chrome's own CSS. One per `part`:
 * - the inspector bar's: a `page` tab, the `picker` that stands for every page where the bar is narrow, the `more`
 *   count of pages that do not fit, and a `tool`, its name shown while it is open;
 * - the approved composer's: the one filled circle (`send`: Send, Steer, and Stop with nothing drafted), and a quiet
 *   `word` in its row (Auto, Plan, Recover, Branch), pressed where it is a mode.
 * `className` is a wrapper's own, a tooltip's that clones it: added to the part's, never in its place.
 */
import type { ComponentProps } from "react";

const PART = {
  page: "p-page-link",
  picker: "p-page p-page-picker",
  more: "p-bar-more",
  tool: "p-tool",
  send: "p-composer-send",
  word: "p-composer-quiet",
} satisfies Readonly<Record<string, string>>;

export function ChromeButton({ part, className, type = "button", ...rest }: ComponentProps<"button"> & { part: keyof typeof PART }) {
  return <button type={type} className={`${PART[part]}${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}
