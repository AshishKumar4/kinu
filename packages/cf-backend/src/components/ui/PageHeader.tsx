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

/** A tool's page at the full width, at the rhythm's top and foot, for a tool that draws its own header (Mail). */
export const TOOL_FRAME = "w-full px-5 pb-16 pt-6 sm:px-8 lg:pt-12";

/** A tool page: the same header row, spanning the tool at the full width; the tool's own columns start under it. */
export function ToolPage({ icon, title, actions, children, scrolls = true }: {
  icon: ReactNode; title: string; actions?: ReactNode; children: ReactNode;
  /** A tool whose columns scroll on their own (Drive) holds the page still and lets them. */
  scrolls?: boolean;
}) {
  return (
    <div className={`h-full ${scrolls ? "overflow-y-auto" : "flex min-h-0 flex-col"}`}>
      <div className="w-full px-5 pt-6 sm:px-8 lg:pt-12"><PageHeader icon={icon} title={title}>{actions}</PageHeader></div>
      <div className={scrolls ? "w-full px-5 pb-16 pt-8 sm:px-8" : "flex min-h-0 flex-1"}>{children}</div>
    </div>
  );
}
