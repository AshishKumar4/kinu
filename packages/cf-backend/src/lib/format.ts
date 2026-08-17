/** Number formatting shared by the surfaces that report token spend. */

/** Compact token counts: 1.2M / 200k / 4.5k / 812. A round figure drops its
 *  trailing zero — "200k" is the window, "200.0k" is false precision.
 *
 *  Undefined in, dash out, on the same rule as {@link fmtPct}: a `Usage` field
 *  the provider never reported is a silence, and printing "0" for it would
 *  claim a measurement nobody made. */
export function fmtTokens(n: number | undefined): string {
	if (n === undefined) return "—";
	const scaled = (value: number, suffix: string): string =>
		`${Number(value.toFixed(1))}${suffix}`;
	if (n >= 1_000_000) return scaled(n / 1_000_000, "M");
	if (n >= 1_000) return scaled(n / 1_000, "k");
	return String(n);
}

/**
 * USD at a precision that does not round a real cost to "$0.00". Sub-cent
 * spend is the normal case for a single step, and showing it as zero would
 * read as free.
 */
export function fmtUsd(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

/** A 0–1 rate as a percentage. Null in, dash out — an absent rate is not 0%. */
export function fmtPct(rate: number | null, digits = 0): string {
	return rate === null ? "—" : `${(rate * 100).toFixed(digits)}%`;
}
