import { useCallback, useEffect, useRef, useState } from "react";

/** Callback ref so the observer follows the mounted element. Callers must treat 0 as "not measured yet" and still render. */
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
