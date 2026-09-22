/** Activity rows from exact composed-content character counts. Provider tokens stay out: providers do
 * not attribute tokens to sections, and a heuristic conversion would pass estimates off as real. */
import type { ContextComposition, ContextPlane, ContextSegment } from '../context-meter';

export interface BreakdownRow {
	readonly label: string;
	readonly chars: number;
	/** Messages or definitions folded into this row. */
	readonly items: number;
}

export interface BreakdownPlane {
	readonly plane: ContextPlane;
	readonly chars: number;
	readonly rows: readonly BreakdownRow[];
}

export interface BreakdownView {
	readonly planes: readonly BreakdownPlane[];
	readonly measuredChars: number;
	/** Non-zero bar denominator for an empty measurement. */
	readonly span: number;
}

const PLANE_ORDER: readonly ContextPlane[] = ["system", "tools", "messages", "ephemeral"];

export function breakdownView(context: ContextComposition): BreakdownView {
	const planes = PLANE_ORDER.flatMap((plane): BreakdownPlane[] => {
		const segments = context.segments
			.filter((s: ContextSegment) => s.plane === plane)
			.sort((a, b) => b.chars - a.chars);

		if (segments.length === 0) return [];
		const chars = segments.reduce((sum, s) => sum + s.chars, 0);

		return [{
			plane,
			chars,
			rows: segments.map((s) => ({
				label: s.label,
				chars: s.chars,
				items: s.items,
			})),
		}];
	});

	return {
		planes,
		measuredChars: context.measuredChars,
		span: Math.max(context.measuredChars, 1),
	};
}

export function shareOfMeasured(chars: number, measuredChars: number): number | null {
	return measuredChars > 0 ? chars / measuredChars : null;
}
