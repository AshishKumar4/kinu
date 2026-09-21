/**
 * Close a menu when a click lands outside it — the one listener every
 * hand-rolled menu needs (the sidebar's user menu, the Drive upload menu, a
 * plugin row's options), held here so the third copy does not drift from the
 * first two.
 */

import { useEffect, type RefObject } from "react";

/** While `open`, a document click outside `menu` calls `close`. */
export function useCloseOnOutsideClick(open: boolean, menu: RefObject<HTMLElement | null>, close: () => void): void {
	useEffect(() => {
		if (!open) return;

		const onClick = (event: MouseEvent) => {
			if (menu.current && event.target instanceof Node && !menu.current.contains(event.target)) close();
		};

		document.addEventListener("click", onClick);

		return () => document.removeEventListener("click", onClick);
	}, [open, menu, close]);
}
