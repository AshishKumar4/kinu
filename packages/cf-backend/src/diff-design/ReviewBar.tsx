import { useState } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { toggleMode, useTheme } from "@/hooks/use-theme";

interface DesignView {
  readonly id: string;
  readonly group: "Expanded" | "Notes to the agent" | "On a phone" | "The panel" | "Other machines" | "Large and odd files";
  readonly label: string;
  readonly query: string;
  readonly width?: "desktop" | "mobile";
}

const APPLY = "&file=packages/checkout/src/apply-coupon.ts";

const DESIGN_VIEWS: readonly DesignView[] = [
  { id: "sheet", group: "Expanded", label: "Every file, split", query: `&sheet=1${APPLY}`, width: "desktop" },
  { id: "sheet-unified", group: "Expanded", label: "Every file, unified", query: `&sheet=1&layout=unified${APPLY}`, width: "desktop" },
  { id: "sheet-edge", group: "Expanded", label: "Large files, expanded", query: "&set=edge&sheet=1", width: "desktop" },
  { id: "select", group: "Notes to the agent", label: "Selecting words", query: `&sheet=1${APPLY}&select=text`, width: "desktop" },
  { id: "select-lines", group: "Notes to the agent", label: "Selecting lines by number", query: `&sheet=1${APPLY}&select=lines`, width: "desktop" },
  { id: "comment", group: "Notes to the agent", label: "Writing a note", query: `&sheet=1${APPLY}&comment=1`, width: "desktop" },
  { id: "notes", group: "Notes to the agent", label: "Three notes", query: `&sheet=1${APPLY}&notes=1&annotations=1`, width: "desktop" },
  { id: "panel-notes", group: "Notes to the agent", label: "Notes, from the side panel", query: `&notes=1${APPLY}` },
  { id: "sent", group: "Notes to the agent", label: "Sent, in the thread", query: "&sent=1&pane=chat" },
  { id: "phone-sheet", group: "On a phone", label: "Every file, on a phone", query: `&sheet=1&notes=1${APPLY}`, width: "mobile" },
  { id: "phone-picker", group: "On a phone", label: "Picking a file", query: `&sheet=1&picker=1${APPLY}`, width: "mobile" },
  { id: "phone-notes", group: "On a phone", label: "The notes, on a phone", query: `&sheet=1&notes=1&annotations=1${APPLY}`, width: "mobile" },
  { id: "phone-comment", group: "On a phone", label: "Writing a note on a phone", query: `&sheet=1${APPLY}&comment=1`, width: "mobile" },
  { id: "changes", group: "The panel", label: "What changed", query: "" },
  { id: "file", group: "The panel", label: "A file, open", query: "&file=packages/checkout/src/apply-coupon.ts" },
  { id: "file-added", group: "The panel", label: "A new file", query: "&file=packages/checkout/tests/coupon-kind.test.ts" },
  { id: "file-deleted", group: "The panel", label: "A deleted file", query: "&file=packages/checkout/src/legacy-discount.ts" },
  { id: "file-last", group: "The panel", label: "The last file", query: "&file=packages/checkout/README.md" },
  { id: "reviewed", group: "The panel", label: "Just marked reviewed", query: "&reviewed=1" },
  { id: "device", group: "Other machines", label: "A laptop's uncommitted changes", query: "&source=laptop" },
  { id: "device-file", group: "Other machines", label: "A git diff, with gaps", query: "&source=laptop&file=src/app/checkout/page.tsx" },
  { id: "source-menu", group: "Other machines", label: "Choosing whose changes", query: "&menu=source" },
  { id: "offline", group: "Other machines", label: "A laptop gone offline", query: "&source=laptop&offline=1" },
  { id: "edge", group: "Large and odd files", label: "Large, binary and long files", query: "&set=edge" },
  { id: "edge-large", group: "Large and odd files", label: "Too large to show", query: "&set=edge&file=packages/checkout/src/generated/schema.ts" },
  { id: "edge-long", group: "Large and odd files", label: "A long new file", query: "&set=edge&file=docs/incident-runbook.md" },
  { id: "edge-capped", group: "Large and odd files", label: "A diff that stops part-way", query: "&set=edge&file=data/seed/coupons.csv" },
];

const GROUPS = ["Expanded", "Notes to the agent", "On a phone", "The panel", "Other machines", "Large and odd files"] as const;

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
