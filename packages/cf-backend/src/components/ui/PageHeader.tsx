/**
 * The one header of a top-level page (Workspaces, Drive, Explore, Plugins, Devices, Mail, Settings): its icon and its
 * title on the content's first row, and the page's own actions at that row's right end. No subtitle, eyebrow or back
 * link (docs/APP-CONSISTENCY.md, approved 2026-10-19).
 */
import type { ReactNode } from "react";

/** Where every top-level page's content starts: 32 px from the sidebar on a desktop, the same top on every page. */
export const PAGE_BODY = "px-5 pb-16 pt-6 sm:px-8 lg:pt-8";

export function PageHeader({ icon, title, children, className = "" }: {
  icon: ReactNode;
  title: string;
  /** The page's own actions, at the row's right end. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${className}`}>
      <span className="flex shrink-0 p-text-3" aria-hidden>{icon}</span>
      <h1 className="p-display text-2xl">{title}</h1>
      {children !== undefined && <div className="ml-auto flex items-center gap-1">{children}</div>}
    </header>
  );
}
