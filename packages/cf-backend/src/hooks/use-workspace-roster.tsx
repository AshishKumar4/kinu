import * as v from "valibot";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  listWorkspaces,
  type WorkspaceEntry,
} from "@/lib/user-api";
import { renderThrownChain } from "@kinu.run/core/obs";

interface WorkspaceRosterValue {
  readonly entries: readonly WorkspaceEntry[];
  readonly total: number;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly upsert: (entry: WorkspaceEntry) => void;
  readonly rename: (name: string, displayName: string) => void;
  readonly remove: (name: string) => void;
}

const WorkspaceRenameSchema = v.object({
  name: v.string(),
  displayName: v.string(),
});

const WorkspaceRosterContext = createContext<WorkspaceRosterValue | null>(null);

export function WorkspaceRosterProvider({ children }: { readonly children: ReactNode }) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const knownNames = useRef(new Set<string>());
  /**
   * Which roster read may publish.
   *
   * Bumped by every read AND by every local edit, because both make an older
   * reply wrong. Four things trigger a refresh — mount, a 30s interval, window
   * focus, a visibility change — so two are routinely in flight at once and the
   * slower one used to land last and win. It also undid the optimistic edits:
   * a workspace created or deleted while a list was in flight reappeared, or
   * vanished, when that list arrived.
   */
  const generation = useRef(0);

  const refresh = useCallback((): void => {
    const current = ++generation.current;
    listWorkspaces().then(
      (roster) => {
        if (current !== generation.current) return;
        knownNames.current = new Set(roster.entries.map((entry) => entry.name));
        setEntries(roster.entries);
        setTotal(roster.total);
        setError(null);
      },
      (cause) => {
        if (current !== generation.current) return;
        setError(renderThrownChain({ cause }));
      },
    );
  }, []);

  // Every local edit retires whatever read is in flight. A list fetched before
  // the edit does not know about it, so publishing it would undo the edit —
  // which is how a just-deleted workspace came back and a just-created one
  // disappeared. The next refresh brings the server's own account.
  const retireReads = useCallback((): void => { generation.current += 1; }, []);

  const upsert = useCallback((entry: WorkspaceEntry): void => {
    retireReads();
    const added = !knownNames.current.has(entry.name);
    knownNames.current.add(entry.name);
    setEntries((current) => {
      const existing = current.findIndex((item) => item.name === entry.name);
      if (existing < 0) return [entry, ...current];
      return current.map((item, index) => index === existing ? entry : item);
    });
    if (added) setTotal((current) => current + 1);
  }, [retireReads]);

  const rename = useCallback((name: string, displayName: string): void => {
    retireReads();
    setEntries((current) => current.map((entry) => (
      entry.name === name ? { ...entry, displayName } : entry
    )));
  }, [retireReads]);

  const remove = useCallback((name: string): void => {
    retireReads();
    const removed = knownNames.current.delete(name);
    setEntries((current) => current.filter((entry) => entry.name !== name));
    if (removed) setTotal((current) => Math.max(0, current - 1));
  }, [retireReads]);

  useEffect(() => {
    const sync = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const interval = window.setInterval(sync, 30_000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [refresh]);
  useEffect(() => {
    const handleRename = (event: Event): void => {
      const parsed = v.safeParse(
        WorkspaceRenameSchema,
        event instanceof CustomEvent ? event.detail : null,
      );
      if (parsed.success && parsed.output.name && parsed.output.displayName) {
        rename(parsed.output.name, parsed.output.displayName);
      } else {
        refresh();
      }
    };
    window.addEventListener("kinu:workspace-renamed", handleRename);
    return () => window.removeEventListener("kinu:workspace-renamed", handleRename);
  }, [refresh, rename]);

  const value = useMemo<WorkspaceRosterValue>(() => ({
    entries,
    total,
    error,
    refresh,
    upsert,
    rename,
    remove,
  }), [entries, total, error, refresh, upsert, rename, remove]);

  return <WorkspaceRosterContext.Provider value={value}>{children}</WorkspaceRosterContext.Provider>;
}

export function useWorkspaceRoster(): WorkspaceRosterValue {
  const roster = useContext(WorkspaceRosterContext);
  if (roster === null) throw new Error("useWorkspaceRoster requires WorkspaceRosterProvider");
  return roster;
}
