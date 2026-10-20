/**
 * The one header of a top-level page (Workspaces, Drive, Explore, Plugins, Devices, Mail, Settings): its icon and its
 * title on the content's first row, and the page's own actions at that row's right end. No subtitle, eyebrow or back
 * link (docs/APP-CONSISTENCY.md, approved 2026-10-19).
 */
import type { ReactNode } from "react";

/** Where every top-level page's content starts: 32 px from the sidebar on a desktop, the same top on every page. */
const PAGE_BODY = "px-5 pb-16 pt-6 sm:px-8 lg:pt-8";

/**
 * What a page is, for its margins: a tool keeps its own columns full width (Mail, Drive); a browse page lays out things to
 * open (Workspaces, Explore); a form page is read and filled in rows (Plugins, Devices); a railed form is a form with its
 * sections' rail beside it (Settings).
 */
export type PageKind = "browse" | "form" | "railed";

/**
 * The two margin systems under review (design/page-layout), named on the root as `data-layout` by the gallery's
 * `&layout=`: `a` centres each kind on its own measure, as the pages were before 2026-10-19; `b` centres one frame every
 * non-tool page shares, its title always on the frame's left line and a form stopping at a reading measure from it.
 * Unnamed, each page keeps its margins of today. One is kept once the owner picks; the switch goes with the other.
 */
type LayoutDirection = "today" | "a" | "b";

function layoutDirection(): LayoutDirection {
  const named = typeof document === "undefined" ? undefined : document.documentElement.dataset.layout;

  return named === "a" || named === "b" ? named : "today";
}

/** `b`'s one frame: four cards across, and the same left line for every title. */
const FRAME = "mx-auto w-full max-w-6xl";

/** A form's reading measure: a row of label, field and hint, never stretched across a wide window. */
const FORM_MEASURE = "max-w-[880px]";

const CENTRED: Record<PageKind, string> = {
  browse: "mx-auto w-full max-w-6xl",
  form: "mx-auto w-full max-w-4xl",
  railed: "mx-auto w-full max-w-5xl",
};

/** The body of a page of `kind`: its gutter, its measure and where that measure sits; `today` is the page's own of today. */
export function pageBody(kind: PageKind, today: string): string {
  const direction = layoutDirection();
  const measure = { today, a: CENTRED[kind], b: FRAME }[direction];

  return `${measure} ${PAGE_BODY}`;
}

/**
 * A tool's place in the same system (Mail, Drive), under review as `data-tools`, in any margin direction: `today` as it
 * ships; `i` full width, its title on the row every page's title is on; `ii` in a centred frame widened for tools,
 * 1440, with the pages' gutter; `iii` its left edge on the centred pages' frame line, open to the right edge.
 */
export type ToolVariant = "today" | "i" | "ii" | "iii";

export function toolVariant(): ToolVariant {
  const named = typeof document === "undefined" ? undefined : document.documentElement.dataset.tools;

  return named === "i" || named === "ii" || named === "iii" ? named : "today";
}

/** Where a tool's frame sits: the whole page beside the rail, a 1440 frame centred in it, or from the frame line on. */
const TOOL_FRAME: Record<ToolVariant, string> = {
  today: "w-full",
  i: "w-full",
  ii: "mx-auto w-full max-w-[90rem]",
  iii: "w-full sm:pl-[max(0px,calc((100%_-_72rem)/2))]",
};

export function toolFrame(): string {
  return TOOL_FRAME[toolVariant()];
}

/** A tool page's own body inside its frame: its gutter, as every page's. */
export function toolBody(): string {
  return `${toolFrame()} ${PAGE_BODY}`;
}

/** Under `b`, a form's rows keep the reading measure from the frame's left line while its title row spans the frame. */
export function formMeasure(): string {
  return layoutDirection() === "b" ? FORM_MEASURE : "";
}

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

/** A page of forms under the shared header, at its kind's margins. */
export function FormPage({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={`space-y-6 ${pageBody("form", "max-w-4xl")}`}>
        <PageHeader icon={icon} title={title} />
        <div className={formMeasure()}>{children}</div>
      </div>
    </div>
  );
}
