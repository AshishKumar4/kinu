/**
 * The client half of the `Page`/`SeekCursor` contract: walk a cursored read
 * backwards, one page per request, accumulating what has been fetched.
 *
 * Headless on purpose. It owns the walk and the three states and renders
 * nothing, so each surface keeps its own visual language for the loading and
 * end-of-history affordances.
 *
 * ── The three states, on the client ──────────────────────────────────────────
 * `exhausted` is set ONLY by a page that said `status: 'end'`. A failed fetch
 * leaves it false and populates `error`, so a surface can never render "you
 * have reached the beginning" because a request failed. That is the same lie a
 * bare `LIMIT` tells, one layer up.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Page, SeekCursor } from "@kinu.run/core";
import { describeError } from "@/hooks/use-async-resource";

export interface PagedScroll<Item> {
  /** Everything fetched so far, in the read's presentation order. */
  fetched: readonly Item[];
  loading: boolean;
  /** Non-null after a failed fetch, until the next one succeeds. */
  error: string | null;
  /** A page said it was the last one. Never set by a failure. */
  exhausted: boolean;
  /** Idempotent while a fetch is in flight; safe to call on every scroll tick. */
  loadMore: () => void;
  /**
   * Abandon everything fetched and start the walk over.
   *
   * The generation is what makes this safe: a page already in flight belongs to
   * the walk that asked for it, and once this is called that walk is not the
   * current one, so its reply is discarded instead of re-seeding a list the
   * caller just emptied. Clearing a conversation's history while its first page
   * was in flight used to put that page straight back on screen.
   */
  reset: () => void;
}

export interface PagedScrollOptions<Item> {
  /**
   * Which end fetched pages land at, matching `useGrowingScroll`'s `grows`.
   *
   * A chat presents oldest-first and walks backwards, so each page is older
   * than everything held and belongs above it. A newest-first feed walks with
   * its presentation order and each page belongs below.
   */
  grows: "up" | "down";
  fetchPage: (cursor: SeekCursor | undefined) => Promise<Page<Item>>;
  /**
   * Where to resume when nothing has been fetched yet.
   *
   * A thunk, not a value, because the chat's first anchor is the oldest message
   * the LIVE list is currently showing — seeded by the SDK's own `get-messages`
   * route, which issues no cursor — and that is not known until the socket has
   * delivered it.
   *
   * Three answers, because there are three states and collapsing two of them
   * is a defect this codebase has already paid for: an anchor to walk back
   * from, `"newest"` for "no anchor, read the newest page" — a live list that
   * came up empty has no anchor, and the store may still hold the whole
   * conversation — and `null` for "not ready, ask again". Answering `null` for
   * both of the last two is how a chat draws an empty conversation over a full
   * one and never asks.
   */
  startFrom: () => SeekCursor | "newest" | null;
}

/**
 * Where a walk backwards over a live-seeded list begins.
 *
 * `anchor` is the oldest item the live list holds; `delivered` is whether the
 * server has stated that list's contents at all. Three inputs, three answers,
 * and the middle one is the whole point: a DELIVERED empty list is not a
 * finished conversation, it is a live view that came up with nothing, and the
 * store is the only thing that can say which.
 */
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

  // A ref, not the `loading` state: a fast scroll fires several handlers inside
  // one frame, and every one of them would read the same not-yet-committed
  // `false` and start its own duplicate request.
  const inFlight = useRef(false);
  // Every abandoned generation stays strongly owned until it settles. This
  // matters under React StrictMode: effect cleanup retires the first walk while
  // its request can still be pending, then the replay starts a new walk.
  const nextTaskId = useRef(0);
  const loadTasks = useRef(new Map<number, PageLoadOperation>());
  const cursor = useRef<SeekCursor | null>(null);
  // Which walk a reply belongs to. Only the current walk may publish, so a
  // page fetched before a reset can neither append to the new list nor move its
  // cursor nor declare it exhausted.
  const walk = useRef(0);
  const latest = useRef({ fetchPage, startFrom });
  latest.current = { fetchPage, startFrom };

  // A settled page after unmount must not publish into this hook. `reset` uses
  // the same generation invalidation for an explicitly abandoned walk.
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
      // The page's failure, decided after the handler: `reset` and unmount both
      // retire this walk's generation, and a walk with no list left to fill has
      // none left to fail into either.
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
      if (thrown !== null && generation === walk.current) setError(describeError(thrown.cause));
    })();
  }, [grows, exhausted]);

  const reset = useCallback(() => {
    walk.current += 1;
    // The abandoned walk's `finally` can no longer clear these, which is why
    // they are cleared here: the new walk starts idle, not mid-fetch.
    inFlight.current = false;
    cursor.current = null;
    setFetched([]);
    setLoading(false);
    setError(null);
    setExhausted(false);
  }, []);

  return { fetched, loading, error, exhausted, loadMore, reset };
}
