/**
 * Turning one step's measurement into the rows the Activity surface draws.
 *
 * Kept out of the component because this is where the panel could quietly
 * start lying: the segments are an estimate and the provider's total is not,
 * so the residual between them is derived here, once, signed, and never
 * clamped. Normalising the rows to sum to the reported total would make a
 * tidier chart out of a worse measurement.
 */
import type { ContextComposition, ContextPlane, ContextSegment } from "@proteus/core";

export interface BreakdownRow {
	readonly label: string;
	readonly tokens: number;
	/** Messages or definitions folded into this row. */
	readonly items: number;
}

export interface BreakdownPlane {
	readonly plane: ContextPlane;
	readonly tokens: number;
	readonly rows: readonly BreakdownRow[];
}

export interface BreakdownView {
	readonly planes: readonly BreakdownPlane[];
	/** The local estimate: what the segments add up to. */
	readonly estimated: number;
	/**
	 * `reported - estimated`. Positive means the breakdown does not explain
	 * everything the provider billed; NEGATIVE means it attributed more than
	 * was billed, which happens on schema- and JSON-heavy prompts that tokenize
	 * denser than the divisor assumes. Both are shown as themselves.
	 */
	readonly residual: number;
	/** Bar width: whichever of the two is larger, so an overshooting estimate
	 *  runs visibly past the provider's mark instead of being clipped to it. */
	readonly span: number;
}

/** Wire order — system, then tools, then the conversation, then live state. */
const PLANE_ORDER: readonly ContextPlane[] = ["system", "tools", "messages", "ephemeral"];

const toTokens = (chars: number, charsPerToken: number): number =>
	Math.round(chars / charsPerToken);

export function breakdownView(context: ContextComposition, reported: number): BreakdownView {
	const { charsPerToken } = context;
	const planes = PLANE_ORDER.flatMap((plane): BreakdownPlane[] => {
		const segments = context.segments
			.filter((s: ContextSegment) => s.plane === plane)
			.sort((a, b) => b.chars - a.chars);
		if (segments.length === 0) return [];
		const chars = segments.reduce((sum, s) => sum + s.chars, 0);
		return [{
			plane,
			tokens: toTokens(chars, charsPerToken),
			rows: segments.map((s) => ({
				label: s.label,
				tokens: toTokens(s.chars, charsPerToken),
				items: s.items,
			})),
		}];
	});
	const estimated = context.estimatedTokens;
	return {
		planes,
		estimated,
		residual: reported - estimated,
		span: Math.max(reported, estimated, 1),
	};
}

/** A row's share of what the provider actually billed. The denominator is the
 *  authoritative total, never the local sum — which is exactly why the shares
 *  do not add to 100% and the residual has to be shown. */
export function shareOfReported(tokens: number, reported: number): number | null {
	return reported > 0 ? tokens / reported : null;
}
