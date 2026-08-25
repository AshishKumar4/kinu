/**
 * A set of open/expanded keys with one toggle — the tree-expansion state two
 * surfaces (Files' folder tree, Output's changed-file list) each held as an
 * inline `useState<Set> + toggle` pair until the duplication gate flagged the
 * second copy.
 */

import { useCallback, useState } from "react";

/** What a consumer gets: the live set, one toggle, and a reset to empty. */
export interface ToggledSet {
	readonly set: ReadonlySet<string>;
	readonly toggle: (member: string) => void;
	readonly clear: () => void;
}

export function useToggledSet(initial?: () => Set<string>): ToggledSet {
	const [set, setSet] = useState<ReadonlySet<string>>(initial ?? new Set());
	const toggle = useCallback((member: string) => {
		setSet((prev) => {
			const next = new Set(prev);
			if (next.has(member)) next.delete(member);
			else next.add(member);
			return next;
		});
	}, []);
	const clear = useCallback(() => {
		setSet(new Set());
	}, []);
	return { set, toggle, clear };
}
