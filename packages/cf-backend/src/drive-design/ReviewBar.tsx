import { useState } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { toggleMode, useTheme } from "@/hooks/use-theme";

interface DesignView {
  readonly id: string;
  readonly group: "Places" | "Sharing" | "First run";
  readonly label: string;
  readonly query: string;
}

const DESIGN_VIEWS: readonly DesignView[] = [
  { id: "slates", group: "Places", label: "Slates", query: "&path=/drive/slates" },
  { id: "files", group: "Places", label: "Files", query: "&path=/drive/files" },
  { id: "folder", group: "Places", label: "A folder, one upload running", query: "&path=/drive/files/projects/ops" },
  { id: "dropping", group: "Places", label: "Dropping files into a folder", query: "&path=/drive/files/projects/ops&drop=1" },
  { id: "folder-empty", group: "Places", label: "An empty folder", query: "&path=/drive/files/notes" },
  { id: "skills", group: "Places", label: "Skills", query: "&path=/drive/files/skills" },
  { id: "shared", group: "Places", label: "Shared", query: "&path=/drive/shared" },
  { id: "tile-menu", group: "Places", label: "A share's menu", query: "&path=/drive/shared&menu=given:coupon-board" },
  { id: "share-live", group: "Sharing", label: "Share a slate", query: "&path=/drive/slates&dialog=share" },
  { id: "share-new", group: "Sharing", label: "A first share, no bindings (#25)", query: "&path=/drive/slates&dialog=share-new" },
  { id: "share-access", group: "Sharing", label: "Who can open it", query: "&path=/drive/slates&dialog=share-access" },
  { id: "share-reach", group: "Sharing", label: "What people can reach", query: "&path=/drive/slates&dialog=share-reach" },
  { id: "share-limits", group: "Sharing", label: "Limits", query: "&path=/drive/slates&dialog=share-limits" },
  { id: "share-activity", group: "Sharing", label: "Activity", query: "&path=/drive/slates&dialog=share-activity" },
  { id: "share-blueprint", group: "Sharing", label: "Publish a blueprint", query: "&path=/drive/slates&dialog=share-blueprint" },
  { id: "share-workspace", group: "Sharing", label: "Share a workspace", query: "&path=/drive/shared&dialog=share-workspace" },
  { id: "stop-sharing", group: "Sharing", label: "Stop sharing", query: "&path=/drive/shared&dialog=stop" },
  { id: "shared-workspace", group: "Sharing", label: "A workspace shared with you", query: "&path=/shared/workspace/q3-launch" },
  { id: "empty", group: "First run", label: "Nothing yet", query: "&data=empty" },
  { id: "recipient", group: "First run", label: "Someone shared with you", query: "&data=recipient" },
  { id: "files-empty", group: "First run", label: "Files, still empty", query: "&data=recipient&path=/drive/files" },
  { id: "files-only", group: "First run", label: "Only files so far", query: "&data=files-only" },
];

const GROUPS = ["Places", "Sharing", "First run"] as const;

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
                <a key={view.id} href={`${location.pathname}?frame=drive-design${view.query}&theme=${mode}`}
                  data-design-view={view.id} data-design-query={view.query}
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
          Drive design · {DESIGN_VIEWS.length} states
        </button>
        <button type="button" onClick={toggleMode} aria-label="Switch theme"
          className="flex size-7 items-center justify-center rounded-full p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
          {mode === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
        </button>
      </div>
    </div>
  );
}
