/** Compact token counts: 1.2M / 200k / 4.5k / 812. Undefined renders a dash, never "0". */
export function fmtTokens(n: number | undefined): string {
	if (n === undefined) return "—";

	const scaled = (value: number, suffix: string): string =>
		`${Number(value.toFixed(1))}${suffix}`;

	if (n >= 1_000_000) return scaled(n / 1_000_000, "M");

	if (n >= 1_000) return scaled(n / 1_000, "k");

	return String(n);
}

/** USD without rounding sub-cent spend to "$0.00". */
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

/** The one relative-time wording the app uses. Kept out of `shared.tsx` to avoid loading the markdown renderer. */
export function timeAgo(at: number): string {
	const s = Math.max(0, Math.floor((Date.now() - at) / 1000));

	if (s < 60) return "just now";

	if (s < 3600) return `${Math.floor(s / 60)}m ago`;

	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;

	return new Date(at).toLocaleDateString();
}

/** Compact column age ("4h"); never switches to a calendar date. Null for an unrecorded moment. */
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

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;

	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;

	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;

	return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const SPAN_UNITS: ReadonlyArray<readonly [string, number]> = [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]];

export function fmtSpan(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1_000));
	const index = SPAN_UNITS.findIndex(([, size]) => seconds >= size);
	const major = SPAN_UNITS[index];

	if (major === undefined) return "0s";
	const minor = SPAN_UNITS[index + 1];
	const minorCount = minor === undefined ? 0 : Math.floor((seconds % major[1]) / minor[1]);
	const head = `${String(Math.floor(seconds / major[1]))}${major[0]}`;

	return minor === undefined || minorCount === 0 ? head : `${head} ${String(minorCount)}${minor[0]}`;
}
