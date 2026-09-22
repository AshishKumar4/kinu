/**
 * Client half of the `Page`/`SeekCursor` contract. `exhausted` is set only by a page with
 * `status: 'end'`; a failed fetch sets `error` instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Page, SeekCursor } from "@kinu.run/core";
import { describeError } from "@/hooks/use-async-resource";

export interface PagedScroll<Item> {
  fetched: readonly Item[];
  loading: boolean;
  error: string | null;
  /** A page said it was the last one. Never set by a failure. */
  exhausted: boolean;
  /** Idempotent while a fetch is in flight; safe to call on every scroll tick. */
  loadMore: () => void;
  /** Bumps the generation so an in-flight page from the old walk is discarded. */
  reset: () => void;
}

export interface PagedScrollOptions<Item> {
  /** Matches `useGrowingScroll`'s `grows`. */
  grows: "up" | "down";
  fetchPage: (cursor: SeekCursor | undefined) => Promise<Page<Item>>;
  /**
   * A thunk: the chat's first anchor is unknown until the socket delivers the live list.
   * `"newest"` means no anchor; `null` means not ready, ask again.
   */
  startFrom: () => SeekCursor | "newest" | null;
}

/** A delivered empty live list is not a finished conversation; only the store can say. */
export function walkStart(
  anchor: string | undefined, delivered: boolean,
): SeekCursor | "newest" | null {
  if (anchor !== undefined) return { after: anchor };

  return delivered ? "newest" : null;
}

interface PageLoadOperation {
  promise: Promise<void> | null;
}

export function usePagedScroll<Item>({
  grows, fetchPage, startFrom,
}: PagedScrollOptions<Item>): PagedScroll<Item> {
  const [fetched, setFetched] = useState<readonly Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  // A ref, not state: several scroll handlers in one frame would all read the uncommitted `false`.
  const inFlight = useRef(false);
  // Abandoned generations stay owned until settled; StrictMode retires the first walk while its request is pending.
  const nextTaskId = useRef(0);
  const loadTasks = useRef(new Map<number, PageLoadOperation>());
  const cursor = useRef<SeekCursor | null>(null);
  // Only the current walk may publish.
  const walk = useRef(0);
  const latest = useRef({ fetchPage, startFrom });
  latest.current = { fetchPage, startFrom };

  // Unmount retires the generation so a late page cannot publish.
  useEffect(() => () => {
    walk.current += 1;
    inFlight.current = false;
  }, []);

  const loadMore = useCallback(() => {
    if (inFlight.current || exhausted) return;
    const from = cursor.current ?? latest.current.startFrom();

    if (from === null) return;
    const generation = walk.current;
    inFlight.current = true;
    setLoading(true);
    const taskId = ++nextTaskId.current;
    const owner: PageLoadOperation = { promise: null };
    loadTasks.current.set(taskId, owner);
    owner.promise = (async () => {
      // Decided after the handler: `reset` or unmount may have retired this walk.
      let thrown: { cause: unknown } | null = null;

      try {
        const page = await latest.current.fetchPage(from === "newest" ? undefined : from);

        if (generation !== walk.current) return;
        setFetched((prev) => grows === "up" ? [...page.items, ...prev] : [...prev, ...page.items]);
        setError(null);

        if (page.status === "end") setExhausted(true);
        else cursor.current = page.next;
      } catch (err) {
        thrown = { cause: err };
      } finally {
        if (loadTasks.current.get(taskId) === owner) loadTasks.current.delete(taskId);

        if (generation === walk.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }

      if (thrown !== null && generation === walk.current) setError(describeError(thrown));
    })();
  }, [grows, exhausted]);

  // Start as soon as the start point is known; a scroller only re-asks on content change.
  useEffect(() => {
    if (cursor.current === null && startFrom() !== null) loadMore();
  }, [startFrom, loadMore]);

  const reset = useCallback(() => {
    walk.current += 1;
    // The abandoned walk's `finally` can no longer clear these.
    inFlight.current = false;
    cursor.current = null;
    setFetched([]);
    setLoading(false);
    setError(null);
    setExhausted(false);
  }, []);

  return { fetched, loading, error, exhausted, loadMore, reset };
}
