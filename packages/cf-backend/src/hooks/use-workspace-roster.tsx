/** The owner's roster: pages read from the owner's object, kept current by one socket per tab. */
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

import { rosterBucket, rosterMatches } from "@kinu.run/core";
import {
  listWorkspaces, RosterFrameSchema, ROSTER_SOCKET_ROUTE, UserApiError,
  type RosterCounts, type RosterEntry, type RosterFilterBucket, type RosterFrame, type RosterPage, type WorkspaceEntry,
} from "@/lib/user-api";
import { renderThrownChain, tolerate } from "@kinu.run/core/obs";

const ROSTER_PAGE = 50;

export const RECENT_WORKSPACES = 5;

const NO_COUNTS: RosterCounts = { all: 0, needs: 0, working: 0, idle: 0, unreported: 0, decisions: 0 };

type FrameListener = (frame: RosterFrame) => void;

export interface RosterFilter {
  readonly bucket?: RosterFilterBucket;
  readonly q?: string;
}

export interface RosterPages {
  readonly entries: readonly RosterEntry[];
  readonly total: number;
  readonly counts: RosterCounts;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
}

interface WorkspaceRosterValue extends RosterPages {
  readonly pending: boolean;
  readonly refresh: () => void;
  readonly upsert: (entry: WorkspaceEntry) => void;
  readonly rename: (name: string, displayName: string) => void;
  readonly remove: (name: string) => void;
  readonly subscribe: (listener: FrameListener) => () => void;
  /** Moves on each socket open, since frames missed while it was down are not replayed. */
  readonly epoch: number;
}

const WorkspaceRosterContext = createContext<WorkspaceRosterValue | null>(null);

const WorkspaceRenameSchema = v.object({
  name: v.string(),
  displayName: v.string(),
});

function matchesFilter(entry: RosterEntry, filter: RosterFilter): boolean {
  const bucket = rosterBucket(entry.overview?.activity ?? null, entry.decisions);

  return (filter.bucket === undefined || bucket === filter.bucket) && rosterMatches(entry, filter.q ?? "");
}

function comesBefore(entry: RosterEntry, other: RosterEntry): boolean {
  return entry.lastVisited > other.lastVisited || (entry.lastVisited === other.lastVisited && entry.name < other.name);
}

/** A change that falls past the loaded pages is left to the page that brings it. */
function applyFrame(entries: readonly RosterEntry[], frame: RosterFrame, filter: RosterFilter, complete: boolean): RosterEntry[] {
  const rest = entries.filter((entry) => entry.name !== frame.name);
  const changed = frame.entry;

  if (changed === null || !matchesFilter(changed, filter)) return rest;
  const at = rest.findIndex((other) => comesBefore(changed, other));

  if (at < 0) return complete ? [...rest, changed] : rest;

  return [...rest.slice(0, at), changed, ...rest.slice(at)];
}

/** A search's total moves only with what the loaded pages saw enter or leave. */
function totalAfter(before: Pick<PagesState, 'entries' | 'total'>, frame: RosterFrame, filter: RosterFilter, entries: readonly RosterEntry[]): number {
  if ((filter.q ?? "").trim() === "") return filter.bucket === undefined ? frame.counts.all : frame.counts[filter.bucket];
  const was = before.entries.some((entry) => entry.name === frame.name);
  const is = entries.some((entry) => entry.name === frame.name);

  return before.total + (is ? 1 : 0) - (was ? 1 : 0);
}

interface PagesState {
  readonly filter: RosterFilter | null;
  readonly entries: readonly RosterEntry[];
  readonly total: number;
  readonly counts: RosterCounts;
  readonly nextCursor: string | null;
}

const EMPTY_PAGES: PagesState = { filter: null, entries: [], total: 0, counts: NO_COUNTS, nextCursor: null };

/** A frame that lands during a read is applied again over its answer, which may predate it. */
function useRosterPages(filter: RosterFilter | null, subscribe: WorkspaceRosterValue["subscribe"], epoch: number) {
  const [state, setState] = useState<PagesState>(EMPTY_PAGES);
  const [error, setError] = useState<string | null>(null);
  /** A retired read counts until its reply is consumed. */
  const [reading, setReading] = useState(0);
  /** Bumped by every read and every local edit, so an older reply never publishes over either. */
  const generation = useRef(0);
  const framesDuringRead = useRef<RosterFrame[]>([]);
  const loaded = useRef(0);
  const active = filter !== null;
  const bucket = filter?.bucket;
  const q = filter?.q;
  const stable = useMemo<RosterFilter>(() => ({ bucket, q }), [bucket, q]);

  const publish = useCallback((current: number, answer: RosterPage, merge: (answer: RosterPage) => PagesState): void => {
    if (current !== generation.current) return;
    const merged = merge(answer);
    let { entries, total, counts } = merged;

    for (const frame of framesDuringRead.current) {
      const moved = applyFrame(entries, frame, stable, merged.nextCursor === null);
      total = totalAfter({ entries, total }, frame, stable, moved);
      entries = moved;
      counts = frame.counts;
    }

    loaded.current = entries.length;
    setState({ ...merged, entries, total, counts });
    setError(null);
  }, [stable]);

  const read = useCallback((cursor: string | null, limit: number, merge: (answer: RosterPage) => PagesState): void => {
    const current = ++generation.current;
    framesDuringRead.current = [];
    setReading((count) => count + 1);

    // Dropped in the publish's batch, so `pending` never falls before the answer shows.
    listWorkspaces({ cursor, limit, bucket: stable.bucket, q: stable.q }).then(
      (answer) => {
        publish(current, answer, merge);
        setReading((count) => count - 1);
      },
      (...failure: [unknown]) => {
        if (current === generation.current) setError(renderThrownChain({ cause: failure[0] }));
        setReading((count) => count - 1);
      },
    );
  }, [stable, publish]);

  // Everything loaded, in one read the object clamps, so a reconnect keeps the reader's place.
  const reload = useCallback((): void => {
    read(null, Math.max(ROSTER_PAGE, loaded.current), (answer) => ({
      filter: stable, entries: answer.entries, total: answer.total, counts: answer.counts, nextCursor: answer.nextCursor,
    }));
  }, [read, stable]);

  const loadMore = useCallback((): void => {
    if (state.nextCursor === null) return;
    const known = new Set(state.entries.map((entry) => entry.name));

    read(state.nextCursor, ROSTER_PAGE, (answer) => ({
      filter: stable, entries: [...state.entries, ...answer.entries.filter((entry) => !known.has(entry.name))],
      total: answer.total, counts: answer.counts, nextCursor: answer.nextCursor,
    }));
  }, [read, state, stable]);

  useEffect(() => {
    if (active && epoch > 0) reload();
  }, [active, epoch, reload]);

  useEffect(() => active ? subscribe((frame) => {
    framesDuringRead.current.push(frame);
    setState((current) => {
      const entries = applyFrame(current.entries, frame, stable, current.nextCursor === null);

      return { ...current, entries, total: totalAfter(current, frame, stable, entries), counts: frame.counts };
    });
  }) : undefined, [active, subscribe, stable]);

  /** A local edit retires any in-flight read; publishing it would undo the edit. */
  const edit = useCallback((change: (entries: readonly RosterEntry[]) => readonly RosterEntry[]): void => {
    generation.current += 1;
    setState((current) => ({ ...current, filter: stable, entries: change(current.filter === stable ? current.entries : []) }));
  }, [stable]);

  const pages = useMemo<RosterPages>(() => {
    const current = state.filter === stable;

    return {
      entries: current ? state.entries : [], total: current ? state.total : 0, counts: state.counts,
      hasMore: current && state.nextCursor !== null, loading: !current, error, loadMore,
    };
  }, [state, stable, error, loadMore]);

  return { pages, reload, edit, pending: reading > 0 };
}

export interface RosterSocket extends EventTarget {
  close(): void;
}

/** Null: reads only. */
export type RosterLive = (() => RosterSocket) | null;

function openRosterSocket(): RosterSocket {
  return new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${ROSTER_SOCKET_ROUTE}`);
}

/** A refused upgrade closes like any failure; only a read tells a refused session. */
async function sessionRefused(): Promise<boolean> {
  try {
    await listWorkspaces({ limit: 1 });

    return false;
  } catch (cause) {
    return cause instanceof UserApiError && cause.status === 401;
  }
}

const ALL: RosterFilter = {};

export function WorkspaceRosterProvider({ children, live = openRosterSocket }: { readonly children: ReactNode; readonly live?: RosterLive }) {
  const listeners = useRef(new Set<FrameListener>());
  const [epoch, setEpoch] = useState(0);

  const subscribe = useCallback((listener: FrameListener): () => void => {
    listeners.current.add(listener);

    return () => { listeners.current.delete(listener); };
  }, []);

  const { pages, reload: refresh, edit, pending } = useRosterPages(ALL, subscribe, epoch);

  // A socket that cannot open still owes the page its first read.
  useEffect(() => {
    if (live === null) {
      setEpoch(1);

      return undefined;
    }

    let stopped = false;
    let attempts = 0;
    let timer: number | undefined;
    let socket: RosterSocket | null = null;

    const reconnect = (): void => {
      timer = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempts));
      attempts += 1;
    };

    const connect = (): void => {
      const opened = live();
      let open = false;
      socket = opened;

      opened.addEventListener("open", () => {
        open = true;
        attempts = 0;
        setEpoch((current) => current + 1);
      });

      opened.addEventListener("message", (event: Event) => {
        const data: unknown = event instanceof MessageEvent ? event.data : null;
        const text = v.is(v.string(), data) ? data : "";
        const frame = v.safeParse(RosterFrameSchema, tolerate(() => JSON.parse(text), "malformed-input"));

        if (!frame.success) return;

        for (const listener of listeners.current) listener(frame.output);
      });

      opened.addEventListener("close", () => {
        if (stopped || socket !== opened) return;

        if (open) {
          reconnect();

          return;
        }

        setEpoch((current) => Math.max(current, 1));
        sessionRefused().then((refused) => { if (!refused && !stopped) reconnect(); }, reconnect);
      });
    };

    connect();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [live]);

  const upsert = useCallback((entry: WorkspaceEntry): void => {
    const added: RosterEntry = { ...entry, overview: null, decisions: 0 };

    edit((entries) => entries.some((each) => each.name === entry.name)
      ? entries.map((each) => each.name === entry.name ? { ...each, ...entry } : each)
      : [added, ...entries]);
  }, [edit]);

  const rename = useCallback((name: string, displayName: string): void => {
    edit((entries) => entries.map((entry) => entry.name === name ? { ...entry, displayName } : entry));
  }, [edit]);

  const remove = useCallback((name: string): void => {
    edit((entries) => entries.filter((entry) => entry.name !== name));
  }, [edit]);

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
    ...pages, total: pages.counts.all, pending, refresh, upsert, rename, remove, subscribe, epoch,
  }), [pages, pending, refresh, upsert, rename, remove, subscribe, epoch]);

  return <WorkspaceRosterContext.Provider value={value}>{children}</WorkspaceRosterContext.Provider>;
}

export function useWorkspaceRoster(): WorkspaceRosterValue {
  const roster = useContext(WorkspaceRosterContext);

  if (roster === null) throw new Error("useWorkspaceRoster requires WorkspaceRosterProvider");

  return roster;
}

export function useFilteredRoster(filter: RosterFilter | null): RosterPages | null {
  const { subscribe, epoch } = useWorkspaceRoster();
  const { pages } = useRosterPages(filter, subscribe, epoch);

  return filter === null ? null : pages;
}

export function useRosterActivity() {
  const { counts } = useWorkspaceRoster();

  return { working: counts.working > 0, decisions: counts.decisions };
}
