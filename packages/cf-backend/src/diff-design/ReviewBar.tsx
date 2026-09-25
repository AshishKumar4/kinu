import { useState } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { toggleMode, useTheme } from "@/hooks/use-theme";

interface DesignView {
  readonly id: string;
  readonly group: (typeof GROUPS)[number];
  readonly label: string;
  readonly query: string;
  readonly width?: "desktop" | "mobile" | "wide";
}

const GROUPS = ["Wide pane", "Notes to the agent", "Narrow pane", "Other machines", "Large and odd files"] as const;

const APPLY = "&file=packages/checkout/src/apply-coupon.ts";

const WIDE = "&inspector=760";

const WIDEST = "&inspector=1270";

const DESIGN_VIEWS: readonly DesignView[] = [
  { id: "wide", group: "Wide pane", label: "Every file, one column", query: `${WIDE}${APPLY}`, width: "desktop" },
  { id: "wide-split", group: "Wide pane", label: "Every file, side by side", query: `${WIDEST}${APPLY}`, width: "wide" },
  { id: "wide-unified", group: "Wide pane", label: "Side by side, switched to unified", query: `${WIDEST}&layout=unified${APPLY}`, width: "wide" },
  { id: "wide-edge", group: "Wide pane", label: "Large files, expanded", query: `&set=edge${WIDE}`, width: "desktop" },
  { id: "select", group: "Notes to the agent", label: "Selecting words", query: `${WIDEST}${APPLY}&select=text`, width: "wide" },
  { id: "select-lines", group: "Notes to the agent", label: "Selecting lines by number", query: `${WIDEST}${APPLY}&select=lines`, width: "wide" },
  { id: "comment", group: "Notes to the agent", label: "Writing a note", query: `${WIDEST}${APPLY}&comment=1`, width: "wide" },
  { id: "notes", group: "Notes to the agent", label: "Three notes, beside the code", query: `${WIDEST}${APPLY}&notes=1&annotations=1`, width: "wide" },
  { id: "notes-wide", group: "Notes to the agent", label: "The notes, in place of the tree", query: `${WIDE}${APPLY}&notes=1&annotations=1`, width: "desktop" },
  { id: "comment-narrow", group: "Notes to the agent", label: "Writing a note, one file open", query: `${APPLY}&comment=1` },
  { id: "panel-notes", group: "Notes to the agent", label: "Notes waiting to be sent", query: `&notes=1${APPLY}` },
  { id: "panel-notes-open", group: "Notes to the agent", label: "The notes, opened in a narrow pane", query: `&notes=1&annotations=1${APPLY}` },
  { id: "sent", group: "Notes to the agent", label: "Sent, in the thread", query: "&sent=1&pane=chat" },
  { id: "changes", group: "Narrow pane", label: "What changed", query: "" },
  { id: "file", group: "Narrow pane", label: "A file, open", query: APPLY },
  { id: "file-added", group: "Narrow pane", label: "A new file", query: "&file=packages/checkout/tests/coupon-kind.test.ts" },
  { id: "file-deleted", group: "Narrow pane", label: "A deleted file", query: "&file=packages/checkout/src/legacy-discount.ts" },
  { id: "file-last", group: "Narrow pane", label: "The last file", query: "&file=packages/checkout/README.md" },
  { id: "reviewed", group: "Narrow pane", label: "Just marked reviewed", query: "&reviewed=1" },
  { id: "device", group: "Other machines", label: "A laptop's uncommitted changes", query: "&source=laptop" },
  { id: "device-file", group: "Other machines", label: "A git diff, with gaps", query: "&source=laptop&file=src/app/checkout/page.tsx" },
  { id: "source-menu", group: "Other machines", label: "Choosing whose changes", query: "&menu=source" },
  { id: "offline", group: "Other machines", label: "A laptop gone offline", query: "&source=laptop&offline=1" },
  { id: "edge", group: "Large and odd files", label: "Large, binary and long files", query: "&set=edge" },
  { id: "edge-large", group: "Large and odd files", label: "Too large to show", query: "&set=edge&file=packages/checkout/src/generated/schema.ts" },
  { id: "edge-long", group: "Large and odd files", label: "A long new file", query: "&set=edge&file=docs/incident-runbook.md" },
  { id: "edge-capped", group: "Large and odd files", label: "A diff that stops part-way", query: "&set=edge&file=data/seed/coupons.csv" },
];

/** Review chrome, not product. `scripts/diff-design-shots.ts` photographs the states it links. */
export function ReviewBar() {
  const [open, setOpen] = useState(false);
  const { mode } = useTheme();

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col items-end">
      {open && (
        <nav aria-label="Design states" className="mb-2 max-h-[70vh] w-72 overflow-y-auto p-card border p-border p-2 p-shadow-overlay animate-fade-in">
          {GROUPS.map((group) => (
            <div key={group}>
              <p className="px-2 pb-1 pt-2 p-eyebrow">{group}</p>
              {DESIGN_VIEWS.filter((view) => view.group === group).map((view) => (
                <a key={view.id} href={`${location.pathname}?frame=diff-design${view.query}&theme=${mode}`}
                  data-design-view={view.id} data-design-query={view.query} data-design-width={view.width ?? "both"}
                  className="block rounded-md px-2 py-1.5 text-sm p-text-2 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
                  {view.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      )}
      <div className="flex items-center gap-0.5 rounded-full border p-border p-overlay p-1 p-shadow-menu">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} data-design-review
          className="rounded-full px-3 py-1.5 text-xs font-medium p-text-2 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
          Diff design · {DESIGN_VIEWS.length} states
        </button>
        <button type="button" onClick={toggleMode} aria-label="Switch theme"
          className="flex size-7 items-center justify-center rounded-full p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
          {mode === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
        </button>
      </div>
    </div>
  );
}
