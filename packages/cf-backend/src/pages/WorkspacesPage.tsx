/**
 * Every workspace the account owns, with the same evidence the home page's
 * recent list shows — one card component, two shapes. The list is the home
 * page's ruled rows; the tiles are a grid for an account with too many rows
 * to scan. The choice is the owner's and it sticks, in localStorage, because
 * a view that resets on every visit is a view nobody chose.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { ListIcon, SquaresFourIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import { APP_ROUTES } from "@kinu.run/core";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { inputCls } from "@/components/ui/form";
import { WorkspaceOverviewCard } from "@/components/workspaces/WorkspaceOverviewCard";

const VIEW_KEY = "kinu:workspaces-view";

const ViewSchema = v.picklist(["list", "tiled"]);

type View = v.InferOutput<typeof ViewSchema>;

/** The stored choice, or the list when nothing valid was stored. Read once
 *  at mount: the page is the only writer, and it writes through `setView`. */
function storedView(): View {
  const parsed = v.safeParse(ViewSchema, localStorage.getItem(VIEW_KEY));

  return parsed.success ? parsed.output : "list";
}

export default function WorkspacesPage() {
  const { entries, total, error, refresh } = useWorkspaceRoster();
  const [query, setQuery] = useState("");
  const [view, setViewState] = useState<View>(storedView);

  const setView = (next: View): void => {
    localStorage.setItem(VIEW_KEY, next);
    setViewState(next);
  };

  const needle = query.trim().toLowerCase();

  const shown = needle === ""
    ? entries
    : entries.filter((workspace) => (workspace.displayName || workspace.name).toLowerCase().includes(needle));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <header className="flex items-start gap-3">
          <SquaresFourIcon size={22} className="mt-1 shrink-0 p-text-3" />
          <div>
            <h1 className="p-display text-2xl">Workspaces</h1>
            <p className="mt-1 text-xs p-text-3">Every workspace you own, most recent activity first.</p>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name"
            aria-label="Search workspaces"
            className={`${inputCls} sm:max-w-xs`}
          />
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" aria-label="List view" aria-pressed={view === "list"}
              icon={<ListIcon size={14} />} onClick={() => setView("list")} />
            <Button variant="ghost" size="sm" aria-label="Tiled view" aria-pressed={view === "tiled"}
              icon={<SquaresFourIcon size={14} />} onClick={() => setView("tiled")} />
          </div>
        </div>

        {error !== null && (
          <div className="p-notice-danger flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs">
            <span className="min-w-0 truncate">{error}</span>
            <button type="button" onClick={refresh} className="shrink-0 underline">retry</button>
          </div>
        )}

        {entries.length === 0 && error === null && (
          <div className="p-card px-5 py-8 text-center">
            <p className="p-row-text p-text-3">No workspaces yet.</p>
            <Link to={APP_ROUTES.home} className="mt-2 inline-block p-t-control p-accent">Create one →</Link>
          </div>
        )}

        {entries.length > 0 && shown.length === 0 && (
          <p className="px-1 p-row-text p-text-3">Nothing matches “{query.trim()}”.</p>
        )}

        {shown.length > 0 && (
          <section aria-label="All workspaces" data-workspaces-view={view}>
            {view === "list" ? (
              <div className="overflow-hidden rounded-[14px] border p-border p-surface">
                {shown.map((workspace, index) => (
                  <WorkspaceOverviewCard key={workspace.name} workspace={workspace} variant="row" first={index === 0} />
                ))}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((workspace) => (
                  <WorkspaceOverviewCard key={workspace.name} workspace={workspace} variant="tile" />
                ))}
              </div>
            )}
          </section>
        )}

        {total > entries.length && (
          <p className="px-1 p-meta p-text-3">Showing {entries.length} of {total}.</p>
        )}
      </div>
    </div>
  );
}
