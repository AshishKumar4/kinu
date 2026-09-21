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

/**
 * How long ago, in the one wording the app uses.
 *
 * There were two of these — the jobs card counted seconds, the changelog said
 * "just now" and fell back to a date — and they render in the SAME feed,
 * where one row reading "8s ago" beside another reading "just now" is two
 * clocks, not one. Kept out of any surface file: `shared.tsx` pulls in the
 * markdown renderer, which a roster row has no business loading.
 */
export function timeAgo(at: number): string {
	const s = Math.max(0, Math.floor((Date.now() - at) / 1000));

	if (s < 60) return "just now";

	if (s < 3600) return `${Math.floor(s / 60)}m ago`;

	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;

	return new Date(at).toLocaleDateString();
}

/** The compact age a narrow column carries — "4h", not "Active 4h ago" —
 *  running on past the day into days, months and years, so a list never
 *  switches to a calendar date mid-column. Null for a moment never recorded. */
export function shortAge(at: number): string | null {
	if (!at) return null;
	const s = Math.max(0, Math.floor((Date.now() - at) / 1000));

	if (s < 60) return "now";

	if (s < 3600) return `${Math.floor(s / 60)}m`;

	if (s < 86400) return `${Math.floor(s / 3600)}h`;

	if (s < 2_592_000) return `${Math.floor(s / 86400)}d`;

	if (s < 31_536_000) return `${Math.floor(s / 2_592_000)}mo`;

	return `${Math.floor(s / 31_536_000)}y`;
}

/** Sizes at a glance, in the unit that keeps a column scannable. */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;

	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;

	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;

	return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
