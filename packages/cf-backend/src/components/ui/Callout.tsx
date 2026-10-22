/**
 * What the page waits on the person for, inline where it applies (docs/DESIGN-SYSTEM.md §2): a step to take on
 * Cloudflare, a window to finish, a domain still to point. The selected ground at the row radius; no icon, since what
 * leads it (a spinner, a sentence) says what it is. A danger, warning or done is a Notice.
 */
import type { ReactNode } from "react";

export function Callout({ children, className, ...data }: { children: ReactNode; className?: string } & Readonly<Record<`data-${string}`, string>>) {
  return <div className={`p-callout${className === undefined ? "" : ` ${className}`}`} {...data}>{children}</div>;
}
