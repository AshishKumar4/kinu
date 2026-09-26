/**
 * One hook because every behaviour writes the same `scrollTop`. `grows: "up"` (chat) anchors
 * prepends and pins to the bottom; `"down"` (newest-first feed) needs neither.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ConversationScroll } from "./use-conversation-ui-state";

const PIN_THRESHOLD = 40;

/** Larger than PIN_THRESHOLD so the page renders before the reader reaches the edge. */
const PREFETCH_THRESHOLD = 400;

interface GrowingScrollHost {
  readonly style: { overflowAnchor: string };
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTop: number;
  addEventListener(
    type: 'scroll', listener: () => void, options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: 'scroll', listener: () => void): void;
}

export interface GrowingScrollOptions {
  grows: "up" | "down";
  content: unknown;
  /** Only fetched growth needs the viewport held in place. */
  fetched: unknown;
  /** Stops the loading-state commit from bottom-pinning over the prepend. */
  loading?: boolean | undefined;
  /** Must tolerate repeat calls before the previous one settles. */
  onReachEdge?: (() => void) | undefined;
  /** The first content has arrived; a saved position waits for it. */
  settled?: boolean | undefined;
  /** A pixel offset applies only inside the loaded content, else the newest edge: never a fetch (2026-09-26). */
  initialScroll?: ConversationScroll | undefined;
  onScrollPosition?: ((position: ConversationScroll) => void) | undefined;
}

export function useGrowingScroll({
  grows, content, fetched, loading = false, settled = true,
  onReachEdge, initialScroll, onScrollPosition,
}: GrowingScrollOptions) {
  const el = useRef<GrowingScrollHost | null>(null);
  const pinned = useRef(grows === "up");
  // Measured at the previous commit: a layout effect runs after the DOM has grown.
  const lastHeight = useRef(0);
  const lastFetched = useRef(fetched);
  const settlingPrepend = useRef(false);
  const lastLoading = useRef(loading);
  const reachEdge = useRef(onReachEdge);
  reachEdge.current = onReachEdge;
  const reportPosition = useRef(onScrollPosition);
  reportPosition.current = onScrollPosition;
  const latestInitialScroll = useRef(initialScroll);
  latestInitialScroll.current = initialScroll;
  const latestSettled = useRef(settled);
  latestSettled.current = settled;
  // Restoring into an empty scroller clamps to 0, so wait for content. Re-armed on every attach.
  const pendingRestore = useRef<number | null>(null);

  const tryRestore = useCallback((node: GrowingScrollHost) => {
    const target = pendingRestore.current;

    if (target === null || !latestSettled.current) return;

    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);

    pendingRestore.current = null;
    node.scrollTop = target <= maxScrollTop ? target : node.scrollHeight;
    pinned.current = grows === "up"
      && node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD;
    reportPosition.current?.(pinned.current ? "pinned" : node.scrollTop);
  }, [grows]);

  const maybeLoadMore = useCallback((node: GrowingScrollHost) => {
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

    // A pending restore must not be overwritten by the mount's own bottom-jump.
    if (pendingRestore.current === null) {
      reportPosition.current?.(pinned.current ? "pinned" : node.scrollTop);
    }

    maybeLoadMore(node);
  }, [grows, maybeLoadMore]);

  // Callback ref so the listener survives conditional remounts.
  const containerRef = useCallback((node: GrowingScrollHost | null) => {
    el.current?.removeEventListener("scroll", onScroll);
    el.current = node;

    if (!node) return;
    // Chrome and Firefox anchor before this layout effect runs, Safari not at all;
    // native anchoring would double-count the exact correction applied here.
    node.style.overflowAnchor = "none";
    pinned.current = grows === "up";
    node.scrollTop = grows === "up" ? node.scrollHeight : 0;
    const saved = latestInitialScroll.current;
    pendingRestore.current = grows === "up" && saved !== undefined && saved !== "pinned" ? saved : null;
    tryRestore(node);
    lastHeight.current = node.scrollHeight;
    node.addEventListener("scroll", onScroll, { passive: true });
    maybeLoadMore(node);
  }, [grows, onScroll, maybeLoadMore, tryRestore]);

  // Font loading changes scrollHeight without a React commit; rebaseline so a
  // prepend landing after the font swap does not over-correct.
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

      // Hold the reader's message in place; a pending restore owns the position instead.
      if (grows === "up" && grew > 0 && pendingRestore.current === null) node.scrollTop += grew;
      // Keep the prepend authoritative through the next paint; React may commit derived content separately.
      settlingPrepend.current = true;
    }

    if (pendingRestore.current !== null) {
      tryRestore(node);
    } else if (!fetchedChanged && !loadingChanged && !settlingPrepend.current && pinned.current) {
      node.scrollTop = node.scrollHeight;
    }

    lastHeight.current = node.scrollHeight;

    // A flick ending at the edge fires no more scroll events, so re-check after each page settles.
    if (fetchedChanged || !loadingChanged) maybeLoadMore(node);
  }, [grows, content, settled, fetched, loading, maybeLoadMore, tryRestore]);

  // A walk that could not start asks again once it can.
  useEffect(() => {
    const node = el.current;

    if (node && pendingRestore.current === null) maybeLoadMore(node);
  }, [onReachEdge, maybeLoadMore]);

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
