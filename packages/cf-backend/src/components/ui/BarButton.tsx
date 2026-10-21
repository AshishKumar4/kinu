/**
 * The inspector bar's own controls (docs/DESIGN-SYSTEM.md §2, Tabs in the workspace's chrome), their CSS the settled
 * bar's. One press per `part`: a `page` tab, the `picker` that stands for every page where the bar is narrow, the
 * `more` count of pages that do not fit, and a `tool`, its name shown while it is open.
 */
import type { ComponentProps } from "react";

const PART = { page: "p-page-link", picker: "p-page p-page-picker", more: "p-bar-more", tool: "p-tool" } satisfies Readonly<Record<string, string>>;

/** `className` is a wrapper's own, a tooltip's that clones it: added to the part's, never in its place. */
export function BarButton({ part, className, type = "button", ...rest }: ComponentProps<"button"> & { part: keyof typeof PART }) {
  return <button type={type} className={`${PART[part]}${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}
