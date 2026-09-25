/** Every workspace, a page at a time; filter and search are the owner's object's queries. List or tiles, in localStorage. */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { ListIcon, PlusIcon, SquaresFourIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import { APP_ROUTES, type RosterBucket } from "@kinu.run/core";
import { useFilteredRoster, useWorkspaceRoster, type RosterFilter } from "@/hooks/use-workspace-roster";
import { inputCls } from "@/components/ui/form";
import { Segmented } from "@/components/ui/Segmented";
import { FilledButton } from "@/components/ui/FilledButton";
import { WorkspaceOverviewCard } from "@/components/workspaces/WorkspaceOverviewCard";

const VIEW_KEY = "kinu:workspaces-view";

const ViewSchema = v.picklist(["list", "tiled"]);

type View = v.InferOutput<typeof ViewSchema>;

/** Read once at mount: the page is the only writer, via `setView`. */
function storedView(): View {
  const parsed = v.safeParse(ViewSchema, localStorage.getItem(VIEW_KEY));

  return parsed.success ? parsed.output : "tiled";
}

const BUCKET_IDS = ["all", "needs", "working", "idle"] as const;

const SEARCH_PAUSE_MS = 250;

const BUCKETS: Record<"all" | RosterBucket, { label: string; empty: string }> = {
  all: { label: "All", empty: "No workspaces" },
  needs: { label: "Needs you", empty: "Nothing is waiting on you" },
  working: { label: "Working", empty: "No workspace is working right now" },
  idle: { label: "Idle", empty: "No idle workspaces" },
};

const SEGMENTS = BUCKET_IDS.map((id) => ({ id, label: BUCKETS[id].label }));

function usePaused(text: string): string {
  const [paused, setPaused] = useState(text);

  useEffect(() => {
    const timer = window.setTimeout(() => setPaused(text), SEARCH_PAUSE_MS);

    return () => window.clearTimeout(timer);
  }, [text]);

  return paused;
}

function NextPage({ onReached }: { readonly onReached: () => void }) {
  const marker = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = marker.current;

    if (element === null) return;
    const observer = new IntersectionObserver((seen) => { if (seen.some((entry) => entry.isIntersecting)) onReached(); });
    observer.observe(element);

    return () => observer.disconnect();
  }, [onReached]);

  return <div ref={marker} data-next-page aria-hidden="true" className="h-px" />;
}

export default function WorkspacesPage() {
  const roster = useWorkspaceRoster();
  const [query, setQuery] = useState("");
  const [view, setViewState] = useState<View>(storedView);
  const [filter, setFilter] = useState<"all" | RosterBucket>("all");
  const navigate = useNavigate();
  const q = usePaused(query.trim());
  const narrowed = filter !== "all" || q !== "";
  const narrowing: RosterFilter = { bucket: filter === "all" ? undefined : filter, q };
  const own = useFilteredRoster(narrowed ? narrowing : null);
  const { entries: shown, total: matching, hasMore, loadMore, loading } = own ?? roster;
  const { error, refresh } = roster;
  const entries = roster.entries;
  const total = roster.counts.all;

  const setView = (next: View): void => {
    localStorage.setItem(VIEW_KEY, next);
    setViewState(next);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <header className="flex items-center gap-3">
          <SquaresFourIcon size={22} className="shrink-0 p-text-3" />
          <h1 className="p-display text-2xl">Workspaces</h1>
        </header>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name"
            aria-label="Search workspaces"
            className={`${inputCls} w-full sm:w-auto sm:max-w-xs`}
          />
          <Segmented label="Workspace state" value={filter} onChange={setFilter} segments={SEGMENTS} />
          <div className="ml-auto flex items-center gap-3">
            {total > 0 && <span className="p-meta p-text-4 tabular-nums">{matching} of {total}</span>}
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" aria-label="List view" aria-pressed={view === "list"}
                icon={<ListIcon size={14} />} onClick={() => setView("list")} />
              <Button variant="ghost" size="sm" aria-label="Tiled view" aria-pressed={view === "tiled"}
                icon={<SquaresFourIcon size={14} />} onClick={() => setView("tiled")} />
            </div>
            <FilledButton className="h-8 px-3 text-sm" onClick={() => void navigate(APP_ROUTES.home)}>
              <PlusIcon size={13} weight="bold" /> New workspace
            </FilledButton>
          </div>
        </div>

        {error !== null && (
          <div className="p-notice-danger flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs">
            <span className="min-w-0 truncate">{error}</span>
            <button type="button" onClick={refresh} className="shrink-0 underline">Retry</button>
          </div>
        )}

        {!roster.loading && entries.length === 0 && error === null && (
          <div className="p-card px-5 py-8 text-center">
            <p className="p-row-text p-text-3">No workspaces yet.</p>
            <Link to={APP_ROUTES.home} className="mt-2 inline-block p-t-control p-accent">Create one on Home →</Link>
          </div>
        )}

        {!loading && entries.length > 0 && shown.length === 0 && (
          <p className="py-12 text-center p-text-3">
            {q === "" ? BUCKETS[filter].empty : `Nothing matches “${q}”`}
          </p>
        )}

        {shown.length > 0 && (
          <section aria-label="Workspaces" data-workspaces-view={view}>
            {view === "list" ? (
              <div className="overflow-hidden rounded-[14px] border p-border p-surface">
                {shown.map((workspace, index) => (
                  <WorkspaceOverviewCard key={workspace.name} workspace={workspace} variant="line" first={index === 0} />
                ))}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((workspace) => (
                  <WorkspaceOverviewCard key={workspace.name} workspace={workspace} variant="tile" />
                ))}
              </div>
            )}
            {hasMore && <NextPage onReached={loadMore} />}
          </section>
        )}
      </div>
    </div>
  );
}
