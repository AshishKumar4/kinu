
import { useEffect, type RefObject } from "react";

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
