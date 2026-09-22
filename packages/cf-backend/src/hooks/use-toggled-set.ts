
import { useCallback, useState } from "react";

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
