/**
 * One hook because every behaviour writes the same `scrollTop`. `grows: "up"` (chat) holds the reader's row in place
 * and pins to the bottom; `"down"` (newest-first feed) needs neither.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ConversationScroll } from "./use-conversation-ui-state";

const PIN_THRESHOLD = 40;

const AHEAD_SCREENS = 2;

const AHEAD_MARGIN = 1.5;

const FIRST_FETCH_MS = 400;

export const SCROLL_EDGE_ATTRIBUTE = "data-scroll-edge";

interface ScrollRow {
  getBoundingClientRect(): { readonly top: number; readonly bottom: number };
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  readonly isConnected: boolean;
}

interface GrowingScrollHost {
  readonly style: { overflowAnchor: string };
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTop: number;
  readonly children: ArrayLike<ScrollRow>;
  getBoundingClientRect(): { readonly top: number };
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
  onReachEdge?: ((urgent: boolean) => void) | undefined;
  /** Replaces `onReachEdge` near a reserve. */
  onReserve?: ((ask: ReserveAsk) => void) | undefined;
  /** The first content has arrived; a saved position waits for it. */
  settled?: boolean | undefined;
  /** A pixel offset applies only inside the loaded content, else the newest edge: never a fetch (2026-09-26). */
  initialScroll?: ConversationScroll | undefined;
  onScrollPosition?: ((position: ConversationScroll) => void) | undefined;
}

type Anchor =
  | {
    readonly row: ScrollRow;
    readonly offset: number;
  }
  /** Inside the reserve: the reader keeps their share of it. */
  | { readonly row: null; readonly share: number };

export const HISTORY_RESERVE_ATTRIBUTE = "data-history-reserve";

export const RESERVE_START_ATTRIBUTE = "data-reserve-start";

export const RESERVE_END_ATTRIBUTE = "data-reserve-end";

/** Read up to `end` when `from` is null (the rows below are in view), else from `from`. */
export interface ReserveAsk {
  readonly start: number;
  readonly end: number;
  readonly from: number | null;
  readonly urgent: boolean;
}

/** In view: read where the reader looks. Else the nearest within `ahead`. */
function reserveAsk(node: GrowingScrollHost, ahead: number): ReserveAsk | null {
  const top = node.getBoundingClientRect().top;
  const bottom = top + node.clientHeight;
  let near: ReserveAsk | null = null;

  for (let index = 0; index < node.children.length; index++) {
    const row = node.children[index];

    if (row === undefined || !row.hasAttribute(HISTORY_RESERVE_ATTRIBUTE)) continue;
    const start = Number(row.getAttribute(RESERVE_START_ATTRIBUTE));
    const end = Number(row.getAttribute(RESERVE_END_ATTRIBUTE));

    if (!(end > start)) continue;
    const box = row.getBoundingClientRect();

    if (box.bottom > top && box.top < bottom) {
      if (box.bottom < bottom) return { start, end, from: null, urgent: true };

      if (box.top > top) return { start, end, from: start, urgent: true };
      const pitch = (box.bottom - box.top) / (end - start);

      return { start, end, from: Math.min(end - 1, start + Math.floor((top - box.top) / pitch)), urgent: true };
    }

    if (near !== null) continue;

    if (box.bottom <= top && box.bottom > top - ahead) near = { start, end, from: null, urgent: top - box.bottom < node.clientHeight };
    else if (box.top >= bottom && box.top < bottom + ahead) near = { start, end, from: start, urgent: box.top - bottom < node.clientHeight };
  }

  return near;
}

function reservedAbove(node: GrowingScrollHost): number {
  let reserved = 0;

  for (let index = 0; index < node.children.length; index++) {
    const row = node.children[index];

    if (row === undefined || !row.hasAttribute(SCROLL_EDGE_ATTRIBUTE)) break;

    if (row.hasAttribute(HISTORY_RESERVE_ATTRIBUTE)) {
      const box = row.getBoundingClientRect();

      reserved += box.bottom - box.top;
    }
  }

  return reserved;
}

function findAnchor(node: GrowingScrollHost): Anchor | null {
  const rows = node.children;
  const top = node.getBoundingClientRect().top;
  let low = 0;
  let high = rows.length;

  while (low < high) {
    const middle = (low + high) >> 1;

    if ((rows[middle]?.getBoundingClientRect().bottom ?? top) <= top) low = middle + 1;
    else high = middle;
  }

  for (let index = low; index < rows.length; index++) {
    const row = rows[index];

    if (row === undefined || row.hasAttribute(SCROLL_EDGE_ATTRIBUTE)) continue;
    const offset = row.getBoundingClientRect().top - top;
    const reserved = reservedAbove(node);

    if (reserved > 0 && node.scrollTop < reserved && offset >= node.clientHeight) return { row: null, share: node.scrollTop / reserved };

    return { row, offset };
  }

  return null;
}

export function useGrowingScroll({
  grows, content, fetched, loading = false, settled = true,
  onReachEdge, onReserve, initialScroll, onScrollPosition,
}: GrowingScrollOptions) {
  const el = useRef<GrowingScrollHost | null>(null);
  const pinned = useRef(grows === "up");
  const anchor = useRef<Anchor | null>(null);
  const reachEdge = useRef(onReachEdge);
  reachEdge.current = onReachEdge;
  const reserve = useRef(onReserve);
  reserve.current = onReserve;
  const reportPosition = useRef(onScrollPosition);
  reportPosition.current = onScrollPosition;
  const latestInitialScroll = useRef(initialScroll);
  latestInitialScroll.current = initialScroll;
  const latestSettled = useRef(settled);
  latestSettled.current = settled;
  // Restoring into an empty scroller clamps to 0, so wait for content. Re-armed on every attach.
  const pendingRestore = useRef<number | null>(null);
  const motion = useRef({ top: 0, at: 0, speed: 0 });
  const fetchStarted = useRef<number | null>(null);
  const fetchMs = useRef(FIRST_FETCH_MS);
  // The hook's own write: re-anchoring on its scroll event locked in growth that landed meanwhile (a 344 px jump).
  const written = useRef<number | null>(null);
  const lastLoading = useRef(loading);
  const lastFetched = useRef(fetched);

  const hold = useCallback((node: GrowingScrollHost) => {
    if (pendingRestore.current !== null) return;

    if (grows === "up" && pinned.current) {
      node.scrollTop = node.scrollHeight;
      motion.current.top = node.scrollTop;
      written.current = node.scrollTop;

      return;
    }

    const held = anchor.current;

    if (held !== null && held.row === null) {
      const landed = findAnchor(node);

      // Rows landed in view; the reserve above kept its height.
      if (landed !== null && landed.row !== null) {
        anchor.current = landed;

        return;
      }

      const top = Math.round(held.share * reservedAbove(node));

      if (top === Math.round(node.scrollTop)) return;
      node.scrollTop = top;
      motion.current.top = node.scrollTop;
      written.current = node.scrollTop;

      return;
    }

    if (held === null || !held.row.isConnected) {
      anchor.current = findAnchor(node);

      return;
    }

    const drift = held.row.getBoundingClientRect().top - node.getBoundingClientRect().top - held.offset;

    if (drift === 0) return;
    node.scrollTop += drift;
    motion.current.top = node.scrollTop;
    written.current = node.scrollTop;
  }, [grows]);

  const tryRestore = useCallback((node: GrowingScrollHost) => {
    const target = pendingRestore.current;

    if (target === null || !latestSettled.current) return;

    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);

    pendingRestore.current = null;
    node.scrollTop = target <= maxScrollTop ? target : node.scrollHeight;
    pinned.current = grows === "up"
      && node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD;
    anchor.current = findAnchor(node);
    reportPosition.current?.(pinned.current ? "pinned" : node.scrollTop);
  }, [grows]);

  const maybeLoadMore = useCallback((node: GrowingScrollHost) => {
    const ahead = node.clientHeight * AHEAD_SCREENS + motion.current.speed * fetchMs.current * AHEAD_MARGIN;
    const ask = grows === "up" && reserve.current !== undefined ? reserveAsk(node, ahead) : null;

    if (ask !== null) {
      reserve.current?.(ask);

      return;
    }

    const distance = grows === "up"
      ? node.scrollTop - reservedAbove(node)
      : node.scrollHeight - node.scrollTop - node.clientHeight;

    if (distance <= ahead) reachEdge.current?.(distance < node.clientHeight);
  }, [grows]);

  const onScroll = useCallback(() => {
    const node = el.current;

    if (!node) return;

    if (written.current !== null && Math.abs(node.scrollTop - written.current) < 1) {
      written.current = null;
      maybeLoadMore(node);

      return;
    }

    written.current = null;
    const now = performance.now();
    const moved = grows === "up" ? motion.current.top - node.scrollTop : node.scrollTop - motion.current.top;
    const elapsed = now - motion.current.at;

    if (elapsed > 0 && elapsed < 250) {
      motion.current.speed = 0.7 * motion.current.speed + 0.3 * Math.max(0, moved) / elapsed;
    } else {
      motion.current.speed = 0;
    }

    motion.current.top = node.scrollTop;
    motion.current.at = now;
    pinned.current = grows === "up"
      && node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD;
    anchor.current = findAnchor(node);

    // A pending restore must not be overwritten by the mount's own bottom-jump.
    if (pendingRestore.current === null) {
      reportPosition.current?.(pinned.current ? "pinned" : node.scrollTop);
    }

    maybeLoadMore(node);
  }, [grows, maybeLoadMore]);

  const observers = useRef<{ resize: ResizeObserver; rows: MutationObserver } | null>(null);

  // Callback ref so the listener survives conditional remounts.
  const containerRef = useCallback((node: GrowingScrollHost | null) => {
    el.current?.removeEventListener("scroll", onScroll);
    observers.current?.resize.disconnect();
    observers.current?.rows.disconnect();
    observers.current = null;
    el.current = node;
    anchor.current = null;

    if (!node) return;
    // Safari has no native anchoring, and the others' would correct the same growth twice.
    node.style.overflowAnchor = "none";
    pinned.current = grows === "up";
    node.scrollTop = grows === "up" ? node.scrollHeight : 0;
    const saved = latestInitialScroll.current;
    pendingRestore.current = grows === "up" && saved !== undefined && saved !== "pinned" ? saved : null;
    tryRestore(node);
    motion.current = { top: node.scrollTop, at: 0, speed: 0 };
    node.addEventListener("scroll", onScroll, { passive: true });

    // A test's host is no DOM element and has no rows to observe.
    if (grows === "up" && "Element" in globalThis && node instanceof Element) {
      const resize = new ResizeObserver(() => { hold(node); });

      const rows = new MutationObserver((changes) => {
        for (const change of changes) {
          for (const added of change.addedNodes) if (added instanceof Element) resize.observe(added);

          for (const removed of change.removedNodes) if (removed instanceof Element) resize.unobserve(removed);
        }
      });

      for (const row of node.children) resize.observe(row);
      rows.observe(node, { childList: true });
      observers.current = { resize, rows };
    }

    maybeLoadMore(node);
  }, [grows, onScroll, maybeLoadMore, tryRestore, hold]);

  useEffect(() => () => {
    observers.current?.resize.disconnect();
    observers.current?.rows.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (loading) fetchStarted.current ??= performance.now();
    else if (fetchStarted.current !== null) {
      fetchMs.current = performance.now() - fetchStarted.current;
      fetchStarted.current = null;
    }
  }, [loading]);

  useLayoutEffect(() => {
    const node = el.current;

    if (!node) return;

    if (pendingRestore.current !== null) tryRestore(node);
    else hold(node);

    const failedLoad = lastLoading.current && !loading && lastFetched.current === fetched;

    lastLoading.current = loading;
    lastFetched.current = fetched;

    // A load that ended with no rows failed; it waits for the reader's retry.
    if (!failedLoad) maybeLoadMore(node);
  }, [grows, content, settled, fetched, loading, maybeLoadMore, tryRestore, hold]);

  // A walk that could not start asks again once it can.
  useEffect(() => {
    const node = el.current;

    if (node && pendingRestore.current === null) maybeLoadMore(node);
  }, [onReachEdge, onReserve, maybeLoadMore]);

  return containerRef;
}
