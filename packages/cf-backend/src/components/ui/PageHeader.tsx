/**
 * The one frame and header of a top-level page (docs/design review 2026-10-20, "one frame, filled"). Every page but a
 * chat sits in one centred frame, 1152 wide with a 32 px gutter (20 on a phone), and its body fills it: every title on
 * one line, every right edge (the header's action too) on one. A tool (Mail, Drive) is drawn in the same frame under
 * the same header, its columns filling the height below; a chat has its own bar.
 *
 * The rhythm is held here, and no page writes its own: top inset 48 (24 on a phone), a header row of 36, a hairline 20
 * below it, the body 32 below that, 64 at the foot.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon } from "@phosphor-icons/react";

/** The frame every page but a chat shares; its content is 1088 wide on a desktop. */
const PAGE_FRAME = "mx-auto w-full max-w-[var(--layout-frame)] px-5 sm:px-8";

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
    <header className={`flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 ${rule === "always" ? "border-b pb-5" : "lg:border-b lg:pb-5"} p-border ${className}`}>
      {back === undefined
        ? <span className="flex shrink-0 p-text-3 [&>svg]:size-5" aria-hidden>{icon}</span>
        : (
          <Link to={back.to} aria-label={back.label} title={back.label} data-page-back
            className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-[var(--r-control)] p-text-3 transition-colors hover:bg-[var(--c-hover)] hover:p-text">
            <ArrowLeftIcon size={18} />
          </Link>
        )}
      <h1 className="t-page-title">{title}</h1>
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
 * A tool page (Mail, Drive): a frame page's header in the frame's own rhythm, then the tool's row (its views and search,
 * as Workspaces' filters sit under its header), then its columns, which fill the height left and scroll each on its
 * own. The owner, 2026-10-23: Mail and Drive under a bar of their own (A2's 46 px band) read as another app beside the
 * other views, which is how they were approved on 2026-10-19 too.
 */
export function ToolPage({ icon, title, actions, row, children, ...attributes }: {
  icon: ReactNode; title: string; actions?: ReactNode; row?: ReactNode; children: ReactNode;
} & Readonly<Record<`data-${string}`, string | boolean>>) {
  return (
    <div className="h-full min-h-0" {...attributes}>
      <div className={`${PAGE_FRAME} flex h-full min-h-0 flex-col pt-6 lg:pt-12`}>
        <PageHeader icon={icon} title={title}>{actions}</PageHeader>
        {row !== undefined && row !== null && <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3" data-tool-row>{row}</div>}
        <div className="mt-6 flex min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
