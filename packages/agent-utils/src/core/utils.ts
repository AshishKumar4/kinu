import type { VFS } from "../vfs/types";

export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
	const live = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (live.length === 1) return live[0];
	const controller = new AbortController();
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) controller.abort(signal.reason);
	};
	for (const signal of live) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		signal.addEventListener("abort", () => abort(signal), { once: true });
	}
	return controller.signal;
}

export function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/**
 * Run `work` but stop waiting when `signal` aborts, rejecting with an
 * AbortError carrying `message`. A pre-aborted signal rejects without
 * starting the work at all. This cancels only the WAIT — callers whose
 * underlying work cannot be killed remotely must say so in `message`.
 */
export function raceAbort<T>(
	work: () => Promise<T>,
	signal: AbortSignal | undefined,
	message: string,
): Promise<T> {
	if (!signal) return work();
	if (signal.aborted) return Promise.reject(new DOMException(message, "AbortError"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new DOMException(message, "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		work().then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(err) => { signal.removeEventListener("abort", onAbort); reject(err); },
		);
	});
}

export function extractError(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

export function safeJson<T>(raw: string): T | undefined {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

/** Resolves `.`/`..` segments and prevents directory traversal above root. */
export function normalizePath(path: string): string {
	const stripped = path.replace(/^\/+/, "");
	if (stripped === "." || stripped === "./" || stripped === "") return "";

	const segments = stripped.split("/");
	const resolved: string[] = [];
	for (const seg of segments) {
		if (seg === "." || seg === "") continue;
		if (seg === "..") {
			resolved.pop();
		} else {
			resolved.push(seg);
		}
	}
	return resolved.join("/");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}

		const timeout = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timeout);
					reject(signal.reason);
				},
				{ once: true },
			);
		}
	});
}

export function truncate(str: string, max: number): string {
	return str.length > max ? str.slice(0, max) + "..." : str;
}

export function preview(value: unknown, maxChars: number): string {
	try {
		return truncate(typeof value === "string" ? value : JSON.stringify(value), maxChars);
	} catch {
		return truncate(String(value), maxChars);
	}
}

// ---------------------------------------------------------------------------
// VFS helpers
// ---------------------------------------------------------------------------

export async function readVfsText(vfs: VFS, path: string): Promise<string> {
	const result = await vfs.readFile(path, { encoding: "utf8" });
	if (typeof result !== "string") {
		throw new Error(`Expected text content for ${path}, got ${typeof result}`);
	}
	return result;
}

export function joinVfsPath(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------

export function truncateByLines(text: string, limit: number, suffix = ""): string {
	if (text.length <= limit) return text;
	const budget = limit - suffix.length;
	const lines = text.split("\n");
	let acc = 0;
	let end = 0;
	for (let i = 0; i < lines.length; i++) {
		const len = lines[i].length + 1;
		if (acc + len > budget) break;
		acc += len;
		end = i + 1;
	}
	return lines.slice(0, end).join("\n") + suffix;
}

interface NodeError extends Error {
	code?: string;
}

export function isNodeError(err: unknown): err is NodeError {
	return err instanceof Error && "code" in err;
}

// ---------------------------------------------------------------------------
// Line endings & BOM
// ---------------------------------------------------------------------------

export function detectLineEnding(content: string): string {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: string): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

// ---------------------------------------------------------------------------
// Fuzzy text matching
// ---------------------------------------------------------------------------

function normalizeForFuzzyMatch(text: string): string {
	return (text
		.split("\n").map((line) => line.trimEnd()).join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " "));
}

function normalizedToOriginalIndex(original: string, normIdx: number): number {
	const lines = original.split("\n");
	let normLineStart = 0;
	let cumTrimmed = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmedLen = line.trimEnd().length;
		const trimCount = line.length - trimmedLen;
		const normLineEnd = normLineStart + trimmedLen;

		if (normIdx < normLineEnd) return normIdx + cumTrimmed;

		cumTrimmed += trimCount;

		if (i < lines.length - 1) {
			if (normIdx === normLineEnd) return normIdx + cumTrimmed;
			normLineStart = normLineEnd + 1;
		}
	}

	return normIdx + cumTrimmed;
}

interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
	}

	const origStart = normalizedToOriginalIndex(content, fuzzyIndex);
	const origEnd = normalizedToOriginalIndex(content, fuzzyIndex + fuzzyOldText.length);

	return { found: true, index: origStart, matchLength: origEnd - origStart, usedFuzzyMatch: true, contentForReplacement: content };
}

export interface SearchReplaceResult { success: true; content: string }
export interface SearchReplaceError { success: false; error: string }

export function applySearchReplace(
	content: string,
	search: string,
	replace: string,
): SearchReplaceResult | SearchReplaceError {
	const matchResult = fuzzyFindText(content, search);
	if (!matchResult.found) {
		return { success: false, error: "Search text not found. Ensure it matches exactly (including whitespace)." };
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzySearch = normalizeForFuzzyMatch(search);
	const occurrences = fuzzyContent.split(fuzzySearch).length - 1;
	if (occurrences > 1) {
		return { success: false, error: `Search text matches ${occurrences} locations. Provide more surrounding context to disambiguate.` };
	}

	const baseContent = matchResult.contentForReplacement;
	const updated = baseContent.substring(0, matchResult.index) +
		replace +
		baseContent.substring(matchResult.index + matchResult.matchLength);

	if (baseContent === updated) {
		return { success: false, error: "No changes made. The replacement produced identical content." };
	}

	return { success: true, content: updated };
}

export function required<T>(value: T | undefined | null, name: string): NonNullable<T> {
	if (value == null || value === "") {
		throw new Error(`'${name}' is required`);
	}
	return value as NonNullable<T>;
}

export function safeParseInt(value: string | undefined | null, fallback: number): number {
	if (!value) return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? Math.floor(n) : fallback;
}
