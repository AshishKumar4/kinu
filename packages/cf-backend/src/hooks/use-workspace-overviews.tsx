/**
 * One answer per workspace for everyone on screen who asks.
 *
 * The overview read model (`GET /api/workspaces/:name/overview`) is what a
 * home card summarises a workspace from, and what the shell's living
 * background reads its activity from. Both used to be — or would have been —
 * separate polls of the same question. Here a surface WATCHES a name for as
 * long as it is mounted, the provider keeps one tri-state read per watched
 * name alive at the shared cadence, and every watcher of that name reads the
 * same `AsyncResource`. A name nobody watches is not asked: the sixth
 * workspace the home page does not show is never fetched, and a page with no
 * card and no background asks for nothing.
 *
 * Each read is a `useAsyncResource` in a headless element of its own, so the
 * retry, the stale-after-failure carry and the revalidation timer are the
 * primitive's, not a second copy.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { rosterActivity, type RosterActivity, type WorkspaceOverview } from "@kinu.run/core";
import { getWorkspaceOverview } from "@/lib/user-api";
import { LIVE_DATA_REFRESH_MS } from "@/hooks/use-kinu";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { lastValue, useAsyncResource, type AsyncResourceControl } from "@/hooks/use-async-resource";

/** How many of the roster's workspaces the shell shows first — the home
 *  page's recent list, and the set the living background listens to. */
export const RECENT_WORKSPACES = 5;

/** The shared cadence the workspace surfaces already poll at — the card asks
 *  the same question they do and inherits their rhythm rather than growing a
 *  second timer policy. Module scope because `useAsyncResource` keys its timer
 *  effect on this identity. */
const overviewRevalidate = (): number => LIVE_DATA_REFRESH_MS;

/** The read and its retry — the two halves a watcher can use. The primitive's
 *  `set` stays with the watch that owns the read; nothing publishes an
 *  overview it did not fetch. */
type OverviewRead = Pick<AsyncResourceControl<WorkspaceOverview>, 'resource' | 'reload'>;

interface OverviewsValue {
  readonly reads: ReadonlyMap<string, OverviewRead>;
  /** Watch `names` until the returned function is called. */
  readonly watch: (names: readonly string[]) => () => void;
}

const WorkspaceOverviewsContext = createContext<OverviewsValue | null>(null);

/** One watched name's read, published into the provider's map on every change. */
function OverviewWatch({ name, publish, retire }: {
  readonly name: string;
  readonly publish: (name: string, read: OverviewRead) => void;
  readonly retire: (name: string) => void;
}) {
  const load = useCallback(() => getWorkspaceOverview(name), [name]);
  const { resource, reload } = useAsyncResource(load, overviewRevalidate, name);

  useEffect(() => { publish(name, { resource, reload }); }, [name, publish, resource, reload]);
  useEffect(() => () => retire(name), [name, retire]);

  return null;
}

export function WorkspaceOverviewsProvider({ children }: { readonly children: ReactNode }) {
  const [watchers, setWatchers] = useState<ReadonlyMap<string, number>>(new Map());
  const [reads, setReads] = useState<ReadonlyMap<string, OverviewRead>>(new Map());

  const watch = useCallback((names: readonly string[]): () => void => {
    const shift = (by: number): void => setWatchers((previous) => {
      const next = new Map(previous);

      for (const name of names) {
        const count = (next.get(name) ?? 0) + by;

        if (count > 0) next.set(name, count);
        else next.delete(name);
      }

      return next;
    });

    shift(1);

    return () => shift(-1);
  }, []);

  const publish = useCallback((name: string, read: OverviewRead): void => {
    setReads((previous) => new Map(previous).set(name, read));
  }, []);

  const retire = useCallback((name: string): void => {
    setReads((previous) => {
      const next = new Map(previous);
      next.delete(name);

      return next;
    });
  }, []);

  const value = useMemo<OverviewsValue>(() => ({ reads, watch }), [reads, watch]);

  return (
    <WorkspaceOverviewsContext.Provider value={value}>
      {[...watchers.keys()].map((name) => <OverviewWatch key={name} name={name} publish={publish} retire={retire} />)}
      {children}
    </WorkspaceOverviewsContext.Provider>
  );
}

function useOverviews(): OverviewsValue {
  const value = useContext(WorkspaceOverviewsContext);

  if (value === null) throw new Error("useWorkspaceOverview requires a WorkspaceOverviewsProvider above it");

  return value;
}

/** Before the watch's first render has published: loading, with nothing to retry. */
const LOADING: OverviewRead = { resource: { status: "loading" }, reload: () => undefined };

/** One workspace's overview, watched while the caller is mounted. */
export function useWorkspaceOverview(name: string): OverviewRead {
  const { reads, watch } = useOverviews();

  useEffect(() => watch([name]), [name, watch]);

  return reads.get(name) ?? LOADING;
}

/** What the recent workspaces add up to, watched while the caller is mounted:
 *  the living background's whole input. */
export function useRosterActivity(): RosterActivity {
  const { entries } = useWorkspaceRoster();
  const { reads, watch } = useOverviews();
  const names = useMemo(() => entries.slice(0, RECENT_WORKSPACES).map((entry) => entry.name), [entries]);

  useEffect(() => watch(names), [names, watch]);

  return useMemo(() => {
    const known: WorkspaceOverview[] = [];

    for (const name of names) {
      const read = reads.get(name);
      const overview = read === undefined ? null : lastValue(read.resource);

      if (overview !== null) known.push(overview);
    }

    return rosterActivity(known);
  }, [names, reads]);
}
