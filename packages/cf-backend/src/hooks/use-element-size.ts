import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Measure the element that is ACTUALLY mounted.
 *
 * This was a `useRef` in the page plus a `ResizeObserver` in a `[]` effect — but
 * the ref is attached inside a body that mounts only once the data has LOADED. So
 * on mount the observer bound the loading placeholder, that div unmounted moments
 * later, and no callback ever fired again: the size froze at whatever the
 * placeholder measured mid-layout. Measured as height 0, the canvas rendered at
 * zero height — blank, under a header and a footer that both showed correct data,
 * which is exactly how the Expand view failed in production.
 *
 * A callback ref cannot go stale that way: it fires with the real node on every
 * mount and with `null` on unmount, so the observer follows the element instead
 * of a snapshot of it taken before the element existed.
 *
 * Callers MUST treat a zero measurement as "not measured yet" and render
 * something, never nothing — a blank canvas reads as "there is no data".
 */
export function useElementSize() {
	const [size, setSize] = useState({ w: 0, h: 0 });
	const observer = useRef<ResizeObserver | null>(null);
	const attach = useCallback((el: HTMLDivElement | null): void => {
		observer.current?.disconnect();
		observer.current = null;
		if (el === null) return;
		const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		observer.current = ro;
		measure();
	}, []);
	useEffect(() => () => {
		observer.current?.disconnect();
		observer.current = null;
	}, []);
	return { attach, size };
}
