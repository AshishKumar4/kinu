import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

const run = (update: () => void): void => update();

function useObserved<T>(read: (el: HTMLDivElement) => T, initial: T, apply: (update: () => void) => void) {
	const [value, setValue] = useState(initial);
	const observer = useRef<ResizeObserver | null>(null);

	const attach = useCallback((el: HTMLDivElement | null): void => {
		observer.current?.disconnect();
		observer.current = null;

		if (el === null) return;
		const measure = (): void => setValue(read(el));
		const ro = new ResizeObserver(() => apply(measure));
		ro.observe(el);
		observer.current = ro;
		measure();
	}, [read, apply]);

	useEffect(() => () => {
		observer.current?.disconnect();
		observer.current = null;
	}, []);

	return { attach, value };
}

const sizeOf = (el: HTMLDivElement) => ({ w: el.clientWidth, h: el.clientHeight });

/** Callers must treat 0 as "not measured yet" and still render. */
export function useElementSize() {
	const { attach, value } = useObserved(sizeOf, { w: 0, h: 0 }, run);

	return { attach, size: value };
}

/** The named widths the element spans, committed before paint; only a change renders. `widths` keeps its identity. */
export function useWidthsReached<K extends string>(widths: Readonly<Record<K, number>>) {
	const read = useCallback((el: HTMLDivElement) => Object.entries<number>(widths)
		.filter(([, width]) => el.clientWidth >= width).map(([name]) => name).join(" "), [widths]);

	const { attach, value } = useObserved(read, "", flushSync);
	const reached = useMemo(() => new Set(value.split(" ")), [value]);

	return { attach, fits: (name: K): boolean => reached.has(name) };
}
