/**
 * A tool's sessions as tabs (docs/DESIGN-SYSTEM.md §2, Tabs): the Environment's shells and desktop, underlined where
 * chosen, each closeable on hover and renamed in place. Their CSS is the approved session strip's. One press per `part`:
 * the `tab` itself, or its `close`.
 */
import type { ComponentProps } from "react";

const PART = { tab: "p-session-tab", close: "p-session-close" } satisfies Readonly<Record<string, string>>;

export function SessionButton({ part, type = "button", ...rest }: Omit<ComponentProps<"button">, "className"> & { part: keyof typeof PART }) {
  return <button type={type} role={part === "tab" ? "tab" : undefined} className={PART[part]} {...rest} />;
}

/** A tab's name while it is renamed, in the tab's own place. */
export function SessionRename(props: Omit<ComponentProps<"input">, "className">) {
  return <input className="p-session-rename" {...props} />;
}
