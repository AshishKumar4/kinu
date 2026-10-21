/**
 * The one frame and header of a top-level page (docs/design review 2026-10-20, "one frame, filled"). Every page that is
 * not a tool or a chat sits in one centred frame, 1152 wide with a 32 px gutter (20 on a phone), and its body fills it:
 * every title on one line, every right edge (the header's action too) on one. A tool (Mail, Drive) keeps the full width
 * and the same header row; a chat has its own bar.
 *
 * The rhythm is held here, and no page writes its own: top inset 48 (24 on a phone), a header row of 36, a hairline 20
 * below it, the body 32 below that, 64 at the foot.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon } from "@phosphor-icons/react";

/** The frame every non-tool page shares; its content is 1088 wide on a desktop. */
const PAGE_FRAME = "mx-auto w-full max-w-[1152px] px-5 sm:px-8";

/** Top inset and foot, for a frame page and a tool alike. */
const PAGE_RHYTHM = "pt-6 pb-16 lg:pt-12";

/** The frame and rhythm for a page the document scrolls, outside the shell (a public blueprint): `PageHeader` first. */
export const FRAME_PAGE = `${PAGE_FRAME} ${PAGE_RHYTHM}`;

/** Where the header's hairline is drawn: always, or only from `lg` (`PageHeader`'s `rule`). */
export type PageRule = "always" | "wide";

/** Where a detail page goes back to, in the icon's slot: the page it was opened from (Explore, Workspaces). */
export interface PageBack { readonly to: string; readonly label: string }

/**
 * The header row: icon and title on the frame's left line, the page's actions on its right line, a hairline under. A
 * detail page puts its way back in the icon's slot; its breadcrumb is that link.
 */
export function PageHeader({ icon, back, title, rule = "always", children, className = "" }: {
  icon: ReactNode;
  back?: PageBack | undefined;
  title: string;
  /** `wide`: below `lg` a tab strip follows the header, and its border is the page's one rule (Settings). */
  rule?: PageRule;
  /** The page's own actions, at the row's right end, each 32 high whatever its size: at most one primary, and only when
   *  it creates something. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-2 ${rule === "always" ? "border-b pb-5" : "lg:border-b lg:pb-5"} p-border ${className}`}>
      {back === undefined
        ? <span className="flex shrink-0 p-text-3 [&>svg]:size-5" aria-hidden>{icon}</span>
        : (
          <Link to={back.to} aria-label={back.label} title={back.label} data-page-back
            className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-[var(--r-control)] p-text-3 transition-colors hover:bg-[var(--c-neutral-tint)] hover:p-text">
            <ArrowLeftIcon size={18} />
          </Link>
        )}
      <h1 className="p-page-title">{title}</h1>
      {children !== undefined && children !== null && children !== false && <div className="p-page-actions ml-auto flex items-center gap-2">{children}</div>}
    </header>
  );
}

/** A frame page: the frame, its header and its body at the rhythm's gaps. `fill` is a pane's column (a workspace's
 *  overview and settings) rather than the shell's whole page. */
export function Page({ icon, back, title, actions, fill = false, rule, children, ...attributes }: {
  icon: ReactNode; back?: PageBack; title: string; actions?: ReactNode; fill?: boolean; rule?: PageRule; children: ReactNode;
} & Readonly<Record<`data-${string}`, string | boolean>>) {
  return (
    <div className={`${fill ? "min-h-0 flex-1" : "h-full"} overflow-y-auto`} {...attributes}>
      <div className={FRAME_PAGE}>
        <PageHeader icon={icon} back={back} title={title} rule={rule}>{actions}</PageHeader>
        <div className="mt-8 space-y-8">{children}</div>
      </div>
    </div>
  );
}

/**
 * A tool's bar (Mail, Drive; design review 2026-10-20, A2): a tool is a working surface like a chat, so it gets the
 * chat bar's 46 px band, not a page's header. The tool's icon and name at its left, then its view; its search, filter and
 * primary at its right, every control 28 high. A hairline under it, since the tool's columns meet it.
 */
export function ToolBar({ icon, title, view, actions }: { icon: ReactNode; title: string; view?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="p-tool-bar" data-tool-bar>
      <span className="flex shrink-0 p-text-3 [&>svg]:size-[18px]" aria-hidden>{icon}</span>
      <h1 className="p-tool-title">{title}</h1>
      {view !== undefined && <div className="ml-4 flex min-w-0">{view}</div>}
      {actions !== undefined && <div className="ml-auto flex min-w-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * A tool page: its bar, then `below` (what moves out of the bar on a narrow screen, a scrolling row of its own), then
 * its columns filling the rest. No top inset and no gutter: each column pads itself.
 */
export function ToolPage({ icon, title, view, actions, below, children, ...attributes }: {
  icon: ReactNode; title: string; view?: ReactNode; actions?: ReactNode; below?: ReactNode; children: ReactNode;
} & Readonly<Record<`data-${string}`, string | boolean>>) {
  return (
    <div className="flex h-full min-h-0 flex-col" {...attributes}>
      <ToolBar icon={icon} title={title} view={view} actions={actions} />
      {below}
      <div className="flex min-h-0 flex-1">{children}</div>
    </div>
  );
}
