/**
 * Pin-to-bottom scrolling for a growing scroll container (chat).
 *
 * While the user is at/near the bottom, every content growth keeps the view
 * glued to the bottom with an instant pre-paint scroll. Scrolling up unpins
 * (no yanking the reader down mid-stream); returning to the bottom re-pins.
 */
import { useCallback, useLayoutEffect, useRef } from "react";

/** Distance (px) from the bottom within which the view counts as pinned. */
const PIN_THRESHOLD = 40;

/**
 * @param content value whose identity changes when the container's content
 *   grows (e.g. the messages array)
 * @returns callback ref to attach to the scroll container
 */
export function usePinToBottom<T extends HTMLElement>(content: unknown) {
  const el = useRef<T | null>(null);
  const pinned = useRef(true);

  const onScroll = useCallback(() => {
    const node = el.current;
    if (node) pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD;
  }, []);

  // Callback ref so the listener survives conditional (re)mounts of the
  // container; a freshly mounted view starts pinned at the bottom.
  const containerRef = useCallback((node: T | null) => {
    el.current?.removeEventListener("scroll", onScroll);
    el.current = node;
    if (node) {
      pinned.current = true;
      node.scrollTop = node.scrollHeight;
      node.addEventListener("scroll", onScroll, { passive: true });
    }
  }, [onScroll]);

  useLayoutEffect(() => {
    const node = el.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [content]);

  return containerRef;
}
