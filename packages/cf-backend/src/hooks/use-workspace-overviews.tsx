/**
 * One overview read per watched workspace name, shared by every watcher; unwatched names are
 * never fetched. Each read is a `useAsyncResource` in its own headless element.
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

/** How many roster workspaces the shell shows first (home recent list, living background). */
export const RECENT_WORKSPACES = 5;

/** Module scope because `useAsyncResource` keys its timer effect on this identity. */
const overviewRevalidate = (): number => LIVE_DATA_REFRESH_MS;

/** The primitive's `set` stays with the owning watch; nothing publishes an overview it did not fetch. */
export type OverviewRead = Pick<AsyncResourceControl<WorkspaceOverview>, 'resource' | 'reload'>;

interface OverviewsValue {
  readonly reads: ReadonlyMap<string, OverviewRead>;
  readonly watch: (names: readonly string[]) => () => void;
}

const WorkspaceOverviewsContext = createContext<OverviewsValue | null>(null);

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

const LOADING: OverviewRead = { resource: { status: "loading" }, reload: () => undefined };

export function useWorkspaceOverview(name: string): OverviewRead {
  const { reads, watch } = useOverviews();

  useEffect(() => watch([name]), [name, watch]);

  return reads.get(name) ?? LOADING;
}

/** `names` must be memoised; the provider ref-counts each name. */
export function useOverviewReads(names: readonly string[]): ReadonlyMap<string, OverviewRead> {
  const { reads, watch } = useOverviews();

  useEffect(() => watch(names), [names, watch]);

  return reads;
}

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
