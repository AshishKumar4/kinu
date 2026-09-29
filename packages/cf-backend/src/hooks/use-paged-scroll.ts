/** `exhausted` is set only by a `status: 'end'` page; a failure sets `error`. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatHistoryEntry, Page, PositionCursor, PositionPageRequest, SeekCursor } from "@kinu.run/core";
import { describeError } from "@/hooks/use-async-resource";

export interface PagedScroll<Item> {
  fetched: readonly Item[];
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  /** Idempotent while a fetch is in flight. */
  loadMore: (urgent?: boolean) => void;
}

export interface PagedScrollOptions<Item> {
  fetchPage: (cursor: SeekCursor, limit: number) => Promise<Page<Item>>;
  pageSize?: number;
  /** `null`: not ready, ask again. */
  startFrom: () => SeekCursor | null;
}

interface PageLoadOperation {
  promise: Promise<void> | null;
}

export const MAX_PAGE = 200;

const CHAINED_MS = 100;

/** One page in flight; a page from a retired generation never publishes. */
function usePageLoads(pageSize: number) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A ref, not state: several scroll handlers in one frame would all read the uncommitted `false`.
  const inFlight = useRef(false);
  // Abandoned walks stay owned until settled: StrictMode retires the first mid-request.
  const nextTaskId = useRef(0);
  const loadTasks = useRef(new Map<number, PageLoadOperation>());
  const walk = useRef(0);
  const size = useRef({ limit: pageSize, landedAt: -Infinity });

  // Unmount retires the generation so a late page cannot publish.
  useEffect(() => () => {
    walk.current += 1;
    inFlight.current = false;
  }, []);

  const busy = useCallback(() => inFlight.current, []);

  const sizeFor = useCallback((urgent: boolean) => {
    if (urgent) return MAX_PAGE;

    return performance.now() - size.current.landedAt < CHAINED_MS ? Math.min(MAX_PAGE, size.current.limit * 2) : pageSize;
  }, [pageSize]);

  const run = useCallback((limit: number, read: () => Promise<() => void>) => {
    const generation = walk.current;

    size.current.limit = limit;
    inFlight.current = true;
    setLoading(true);
    const taskId = ++nextTaskId.current;
    const owner: PageLoadOperation = { promise: null };
    loadTasks.current.set(taskId, owner);
    owner.promise = (async () => {
      // Decided after the handler: `reset` or unmount may have retired this walk.
      let thrown: { cause: unknown } | null = null;

      try {
        const publish = await read();

        if (generation !== walk.current) return;
        publish();
        setError(null);
      } catch (err) {
        thrown = { cause: err };
      } finally {
        if (loadTasks.current.get(taskId) === owner) loadTasks.current.delete(taskId);

        if (generation === walk.current) {
          inFlight.current = false;
          size.current.landedAt = performance.now();
          setLoading(false);
        }
      }

      if (thrown !== null && generation === walk.current) setError(describeError(thrown));
    })();
  }, []);

  const retire = useCallback(() => {
    walk.current += 1;
    // The abandoned walk's `finally` can no longer clear these.
    inFlight.current = false;
    setLoading(false);
    setError(null);
  }, []);

  return { loading, error, busy, sizeFor, run, retire };
}

export function usePagedScroll<Item>({
  fetchPage, startFrom, pageSize = 40,
}: PagedScrollOptions<Item>): PagedScroll<Item> {
  const [fetched, setFetched] = useState<readonly Item[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const cursor = useRef<SeekCursor | null>(null);
  const latest = useRef({ fetchPage, startFrom });
  latest.current = { fetchPage, startFrom };
  const { loading, error, busy, sizeFor, run } = usePageLoads(pageSize);

  const ready = cursor.current !== null || startFrom() !== null;

  const loadMore = useCallback((urgent = false) => {
    if (busy() || exhausted) return;
    const from = cursor.current ?? latest.current.startFrom();

    if (from === null) return;
    const limit = sizeFor(urgent);

    run(limit, async () => {
      const page = await latest.current.fetchPage(from, limit);

      return () => {
        setFetched((prev) => [...prev, ...page.items]);

        if (page.status === "end") setExhausted(true);
        else cursor.current = page.next;
      };
    });
    // A new identity once startable, so the scroller re-asks.
  }, [busy, exhausted, ready, run, sizeFor]);

  return { fetched, loading, error, exhausted, loadMore };
}

/** Positions [start, end) read; the newest page's `end` is Infinity. */
export interface HistorySegment {
  readonly start: number;
  readonly end: number;
  readonly entries: readonly ChatHistoryEntry[];
}

export interface HistoryPages {
  readonly segments: readonly HistorySegment[];
  readonly loading: boolean;
  readonly error: string | null;
  /** The first row is loaded; there may still be gaps between loaded segments. */
  readonly exhausted: boolean;
  readonly busy: () => boolean;
  /** More rows when the reader is close or pages land back to back. */
  readonly sizeFor: (urgent: boolean) => number;
  /** No cursor reads the newest page. */
  readonly load: (size: number, request: PositionPageRequest) => void;
  readonly retry: () => void;
  /** Bumps the generation so an in-flight page from the old walk is discarded. */
  readonly reset: () => void;
}

const NO_SEGMENTS: readonly HistorySegment[] = [];

/** Touching stretches join; a held row keeps its object, so its rendered row is kept. */
function withSegment(segments: readonly HistorySegment[], read: HistorySegment): HistorySegment[] {
  const apart = segments.filter((segment) => segment.end < read.start || segment.start > read.end);
  const joined = segments.filter((segment) => !apart.includes(segment));
  const byPosition = new Map(read.entries.map((entry) => [entry.position, entry]));

  for (const segment of joined) for (const entry of segment.entries) byPosition.set(entry.position, entry);

  const merged: HistorySegment = {
    start: Math.min(read.start, ...joined.map((segment) => segment.start)),
    end: Math.max(read.end, ...joined.map((segment) => segment.end)),
    entries: [...byPosition.values()].sort((a, b) => a.position - b.position),
  };

  return [...apart, merged].sort((a, b) => a.start - b.start);
}

export function useHistoryPages(
  fetchPage: (request: PositionPageRequest) => Promise<Page<ChatHistoryEntry, PositionCursor>>,
  pageSize: number,
): HistoryPages {
  const [segments, setSegments] = useState(NO_SEGMENTS);
  const latest = useRef(fetchPage);
  latest.current = fetchPage;
  const asked = useRef<{ readonly size: number; readonly request: PositionPageRequest } | null>(null);
  const { loading, error, busy, sizeFor, run, retire } = usePageLoads(pageSize);

  const load = useCallback((size: number, request: PositionPageRequest) => {
    asked.current = { size, request };
    run(size, async () => {
      const page = await latest.current(request);

      const read: HistorySegment = {
        start: page.status === "end" ? 0 : page.next.before, end: request.cursor?.before ?? Infinity, entries: page.items,
      };

      return () => { setSegments((prev) => withSegment(prev, read)); };
    });
  }, [run]);

  const retry = useCallback(() => {
    if (asked.current !== null && !busy()) load(asked.current.size, asked.current.request);
  }, [busy, load]);

  const reset = useCallback(() => {
    retire();
    asked.current = null;
    setSegments(NO_SEGMENTS);
  }, [retire]);

  return { segments, loading, error, exhausted: segments[0]?.start === 0, busy, sizeFor, load, retry, reset };
}
