/**
 * A row of the sidebar, and of the places beside a page (docs/DESIGN-SYSTEM.md §2, the nav role): the open one on the
 * selected ground in the accent's ink, any other neutral under the pointer, so a row under it never reads as open.
 * `NavRow` is a link to somewhere; `NavRowButton` a press that is the page's own act. `sm` is a nested row (a
 * workspace's chats, a folder's folders); `quiet` is a row of the list's own (New agent, All agents) in the third ink.
 */
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";

interface Look {
  current?: boolean;
  size?: "md" | "sm";
  quiet?: boolean;
  /** How deep a row sits in a tree (a folder's folders): each step indents it by 14. */
  depth?: number;
  /** Placement only: the room a row leaves for controls laid over it. */
  className?: string;
  children: ReactNode;
}

function lookOf({ current = false, size = "md", quiet = false, depth, className }: Look): {
  className: string;
  style?: CSSProperties & { readonly "--nav-depth": string };
  "data-current"?: "";
} {
  const look = `p-nav-row p-nav-row-${size}${quiet ? " p-nav-row-quiet" : ""}${className === undefined ? "" : ` ${className}`}`;
  const indented = depth === undefined ? {} : { style: { "--nav-depth": String(depth) } };

  return current ? { className: look, ...indented, "data-current": "" } : { className: look, ...indented };
}

export function NavRow({ current, size, quiet, depth, className, children, ...link }: Look & Omit<ComponentProps<typeof Link>, "className" | "children">) {
  return <Link {...link} aria-current={current === true ? "page" : undefined} {...lookOf({ current, size, quiet, depth, className, children })}>{children}</Link>;
}

export function NavRowButton({ current, size, quiet, depth, className, children, type = "button", ...button }: Look & Omit<ComponentProps<"button">, "className" | "children">) {
  return <button {...button} type={type} {...lookOf({ current, size, quiet, depth, className, children })}>{children}</button>;
}
