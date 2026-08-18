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
import { useCallback, useRef, useState } from "react";
import type { Page, SeekCursor } from "@proteus/core";
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
  fetchPage: (cursor: SeekCursor) => Promise<Page<Item>>;
  /**
   * Where to resume when nothing has been fetched yet.
   *
   * A thunk, not a value, because the chat's first anchor is the oldest message
   * the LIVE list is currently showing — seeded by the SDK's own `get-messages`
   * route, which issues no cursor — and that is not known until the socket has
   * delivered it. Returning null means "nothing to page back from yet".
   */
  startFrom: () => SeekCursor | null;
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
  const cursor = useRef<SeekCursor | null>(null);
  const latest = useRef({ fetchPage, startFrom });
  latest.current = { fetchPage, startFrom };

  const loadMore = useCallback(() => {
    if (inFlight.current || exhausted) return;
    const from = cursor.current ?? latest.current.startFrom();
    if (!from) return;
    inFlight.current = true;
    setLoading(true);
    void latest.current.fetchPage(from).then((page) => {
      setFetched((prev) => grows === "up" ? [...page.items, ...prev] : [...prev, ...page.items]);
      setError(null);
      if (page.status === "end") setExhausted(true);
      else cursor.current = page.next;
    }, (err) => {
      setError(describeError(err));
    }).finally(() => {
      inFlight.current = false;
      setLoading(false);
    });
  }, [grows, exhausted]);

  return { fetched, loading, error, exhausted, loadMore };
}
