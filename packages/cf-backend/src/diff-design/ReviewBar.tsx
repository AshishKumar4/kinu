import { useState } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { toggleMode, useTheme } from "@/hooks/use-theme";

interface DesignView {
  readonly id: string;
  readonly group: "The panel" | "Other machines" | "Large and odd files" | "Expanded" | "Today";
  readonly label: string;
  readonly query: string;
  
  readonly wide?: boolean;
}

const DESIGN_VIEWS: readonly DesignView[] = [
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
  { id: "sheet", group: "Expanded", label: "Every file, unified", query: "&sheet=1", wide: true },
  { id: "sheet-split", group: "Expanded", label: "Every file, split", query: "&sheet=1&layout=split&file=packages/checkout/src/apply-coupon.ts", wide: true },
  { id: "sheet-edge", group: "Expanded", label: "Large files, expanded", query: "&set=edge&sheet=1", wide: true },
  { id: "today", group: "Today", label: "Today's Diffs tab", query: "&today=1" },
  { id: "today-open", group: "Today", label: "Today, one file open", query: "&today=1&open=1" },
];

const GROUPS = ["The panel", "Other machines", "Large and odd files", "Expanded", "Today"] as const;

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
                  data-design-view={view.id} data-design-query={view.query} data-design-wide={view.wide === true ? "1" : "0"}
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
