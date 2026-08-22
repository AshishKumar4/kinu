/**
 * A scroll container fed by a cursored read.
 *
 * One hook rather than several, because every behaviour here writes the same
 * element's `scrollTop` and they have to agree about who moved it last: a
 * bottom-pin that ran after a prepend would throw the reader to the newest
 * message the instant older history arrived.
 *
 * `grows` is which end the fetched pages land at, which is the only thing that
 * differs between the two shapes of infinite scroll we actually have:
 *
 *   "up"   — a chat. Presents oldest-first, walks backwards, so a page lands
 *            ABOVE the viewport and the view must be held on the content the
 *            reader is looking at. Also pins to the bottom, because new turns
 *            arrive at the end while they read.
 *   "down" — a newest-first feed. A page lands BELOW the viewport, which
 *            shifts nothing, so there is no anchoring to do and no bottom to
 *            pin to — pinning would fight the load-more trigger for the same
 *            edge.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** Distance (px) from the bottom within which the view counts as pinned. */
const PIN_THRESHOLD = 40;

/** Distance (px) from the growing edge at which the next page is requested.
 *  Deliberately larger than PIN_THRESHOLD: the page has to arrive and render
 *  before the reader gets there, or "infinite" scroll is a series of stalls. */
const PREFETCH_THRESHOLD = 400;

export interface GrowingScrollOptions {
  /** Which end fetched pages land at. */
  grows: "up" | "down";
  /** Identity changes when the container's content changed at all. */
  content: unknown;
  /** Identity changes when a fetched page was added. Distinct from `content`
   *  because only this kind of growth needs the viewport held in place. */
  fetched: unknown;
  /** The page request that produced `fetched` is still settling. Used only to
   *  stop its loading-state commit from bottom-pinning over the prepend. */
  loading?: boolean | undefined;
  /** Called while the reader is near the growing edge. Must be safe to call
   *  again before a previous call has settled — this fires on every scroll
   *  tick and again after each page lands. */
  onReachEdge?: (() => void) | undefined;
}

export function useGrowingScroll<T extends HTMLElement>({
  grows, content, fetched, loading = false, onReachEdge,
}: GrowingScrollOptions) {
  const el = useRef<T | null>(null);
  const pinned = useRef(grows === "up");
  // Last committed scrollHeight. The "before" measurement for a prepend has to
  // come from the previous commit: a layout effect runs after the DOM has
  // already grown, so by then there is nothing left to measure against.
  const lastHeight = useRef(0);
  const lastFetched = useRef(fetched);
  const settlingPrepend = useRef(false);
  const lastLoading = useRef(loading);
  const reachEdge = useRef(onReachEdge);
  reachEdge.current = onReachEdge;

  const maybeLoadMore = useCallback((node: T) => {
    const distance = grows === "up"
      ? node.scrollTop
      : node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distance <= PREFETCH_THRESHOLD) reachEdge.current?.();
  }, [grows]);

  const onScroll = useCallback(() => {
    const node = el.current;
    if (!node) return;
    pinned.current = grows === "up"
      && node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD;
    maybeLoadMore(node);
  }, [grows, maybeLoadMore]);

  // Callback ref so the listener survives conditional (re)mounts of the
  // container; an up-growing view starts at the bottom, a down-growing one at
  // the top, which is where each one's newest content already is.
  const containerRef = useCallback((node: T | null) => {
    el.current?.removeEventListener("scroll", onScroll);
    el.current = node;
    if (!node) return;
    // Chrome and Firefox anchor a scroller against content inserted above the
    // viewport all by themselves, and they do it BEFORE this hook's layout
    // effect runs — measured: a prepend moved scrollTop 250 -> 1440 before the
    // effect saw the node, and the effect's own correction on top of that
    // double-counted and clamped the reader to the bottom of the transcript.
    //
    // Turned off rather than relied on. The browser's version is a heuristic
    // that picks its own anchor node and gives up in cases it cannot resolve,
    // Safari does not implement it at all, and the correction here is exact
    // because the hook knows precisely how much was inserted. One mechanism,
    // the same on every engine.
    node.style.overflowAnchor = "none";
    pinned.current = grows === "up";
    node.scrollTop = grows === "up" ? node.scrollHeight : 0;
    lastHeight.current = node.scrollHeight;
    node.addEventListener("scroll", onScroll, { passive: true });
    maybeLoadMore(node);
  }, [grows, onScroll, maybeLoadMore]);

  // Font loading changes scrollHeight without a React commit. If the first
  // history page is already in flight, a baseline captured in the fallback
  // face over-corrects by the exact font reflow when that page lands.
  useEffect(() => {
    const syncHeight = () => {
      if (settlingPrepend.current) return;
      const node = el.current;
      if (node) lastHeight.current = node.scrollHeight;
    };
    syncHeight();
    document.fonts.addEventListener("loadingdone", syncHeight);
    return () => document.fonts.removeEventListener("loadingdone", syncHeight);
  }, []);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const grew = node.scrollHeight - lastHeight.current;
    const fetchedChanged = lastFetched.current !== fetched;
    const loadingChanged = lastLoading.current !== loading;
    lastLoading.current = loading;
    if (fetchedChanged) {
      lastFetched.current = fetched;
      // Push the viewport down by exactly what was inserted above it, so the
      // message the reader was looking at does not move a pixel. Growth at the
      // other end moves nothing and needs no correction.
      if (grows === "up" && grew > 0) node.scrollTop += grew;
      // React can commit other content derived from the page separately. Keep
      // the prepend authoritative through the next paint; the passive effect
      // below then restores live-message pinning from the actual position.
      settlingPrepend.current = true;
    } else if (!loadingChanged && !settlingPrepend.current && pinned.current) {
      node.scrollTop = node.scrollHeight;
    }
    lastHeight.current = node.scrollHeight;
    // A reader who kept scrolling while the page was in flight can already be
    // back at the edge with the request they triggered now settled. Without
    // this re-check the next page only starts on their next scroll EVENT, and
    // a flick that ends at the edge produces no more events at all.
    if (fetchedChanged || !loadingChanged) maybeLoadMore(node);
  }, [grows, content, fetched, loading, maybeLoadMore]);

  useEffect(() => {
    if (loading || !settlingPrepend.current) return;
    const frame = requestAnimationFrame(() => {
      settlingPrepend.current = false;
      const node = el.current;
      if (!node) return;
      pinned.current = grows === "up"
        && node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD;
    });
    return () => cancelAnimationFrame(frame);
  }, [fetched, grows, loading]);

  return containerRef;
}
