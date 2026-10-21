/** Every workspace, a page at a time; filter and search are the owner's object's queries. List or tiles, in localStorage. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ListIcon, SquaresFourIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import { APP_ROUTES } from "@kinu.run/core";
import { useFilteredRoster, useWorkspaceRoster, type RosterFilter } from "@/hooks/use-workspace-roster";
import type { RosterFilterBucket } from "@/lib/user-api";
import { inputCls } from "@/components/ui/form";
import { Segmented } from "@/components/ui/Segmented";
import { Page } from "@/components/ui/PageHeader";
import { TILE_GRID } from "@/components/ui/Tiles";
import { WorkspaceOverviewCard } from "@/components/workspaces/WorkspaceOverviewCard";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";

const VIEW_KEY = "kinu:workspaces-view";

const ViewSchema = v.picklist(["list", "tiled"]);

type View = v.InferOutput<typeof ViewSchema>;

/** Read once at mount: the page is the only writer, via `setView`. */
function storedView(): View {
  const parsed = v.safeParse(ViewSchema, localStorage.getItem(VIEW_KEY));

  return parsed.success ? parsed.output : "tiled";
}

const VIEWS = [
  { id: "list", label: "List view", icon: <ListIcon size={14} /> },
  { id: "tiled", label: "Tiled view", icon: <SquaresFourIcon size={14} /> },
] as const satisfies readonly { id: View; label: string; icon: ReactNode }[];

const BUCKET_IDS = ["all", "needs", "working", "idle"] as const;

const SEARCH_PAUSE_MS = 250;

const BUCKETS: Record<"all" | RosterFilterBucket, { label: string; empty: string }> = {
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
  const [filter, setFilter] = useState<"all" | RosterFilterBucket>("all");
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
    // One column on a phone either way, and the app bar has its own New: the header keeps no action there.
    <Page icon={<SquaresFourIcon size={22} />} title="Workspaces" actions={(
      <div className="max-md:hidden"><Segmented label="View" value={view} onChange={setView} segments={VIEWS} /></div>
    )}>

        {/* The filter on the left; what it left out, then the search, at the row's right end. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Segmented label="Workspace state" value={filter} onChange={setFilter} segments={SEGMENTS} />
          {/* The count says what a filter or search left out; with nothing left out it has nothing to say. */}
          {total > 0 && (matching < total || roster.counts.unreported > 0) && (
            <span className="t-meta p-text-3 tabular-nums">
              {matching < total ? `${String(matching)} of ${String(total)}` : ""}
              {matching < total && roster.counts.unreported > 0 ? " · " : ""}
              {roster.counts.unreported > 0 && `${String(roster.counts.unreported)} not yet reported`}
            </span>
          )}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name"
            aria-label="Search workspaces"
            className={`${inputCls} w-full sm:ml-auto sm:w-64`}
          />
        </div>

        {error !== null && (
          <Notice tone="danger" action={<Button variant="ghost" size="sm" onClick={refresh}>Retry</Button>}>{error}</Notice>
        )}

        {!roster.loading && entries.length === 0 && error === null && (
          <div className="p-card px-5 py-8 text-center">
            <p className="t-body p-text-3">No workspaces yet.</p>
            <Link to={APP_ROUTES.newWorkspace} className="t-control mt-2 inline-block p-accent-fg">Create one →</Link>
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
              <div className={TILE_GRID}>
                {shown.map((workspace) => (
                  <WorkspaceOverviewCard key={workspace.name} workspace={workspace} variant="tile" />
                ))}
              </div>
            )}
            {hasMore && <NextPage onReached={loadMore} />}
          </section>
        )}
    </Page>
  );
}
