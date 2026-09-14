const FTS_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);

const STOP_WORDS = new Set([
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "shall",
	"should", "may", "might", "must", "can", "could", "am", "it", "its",
	"i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
	"them", "his", "her", "this", "that", "these", "those", "what", "which",
	"who", "whom", "how", "when", "where", "why", "if", "then", "than",
	"so", "no", "not", "of", "in", "on", "at", "to", "for", "with",
	"by", "from", "about", "into", "through", "during", "before", "after",
	"and", "but", "or", "as", "just", "also", "very", "too", "any", "all",
]);

export interface SanitizeOptions {
	stopWords?: boolean;
}

/**
 * The terms an FTS query is reduced to before it runs: word tokens with FTS
 * operators and (unless `stopWords` is off) stop words removed. The fallback —
 * an unstripped token list when stripping would empty the query — keeps a
 * stop-words-only search matching the same rows `sanitizeFtsQuery` would.
 *
 * Exported on its own so a non-SQL lexical source (the facts store's in-memory
 * matcher) can apply the exact query-normalization the note index sees,
 * instead of growing a second idea of what a query term is.
 */
export function ftsQueryTerms(query: string, options?: SanitizeOptions): string[] {
	const useStopWords = options?.stopWords ?? true;

	const tokens = query
		.replace(/[^\w\s]/g, " ")
		.split(/\s+/)
		.filter((t) => {
			if (!t) return false;

			if (FTS_OPERATORS.has(t.toUpperCase())) return false;

			if (useStopWords && STOP_WORDS.has(t.toLowerCase())) return false;

			return true;
		});

	if (tokens.length === 0) {
		return query.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
	}

	return tokens;
}

export function sanitizeFtsQuery(query: string, options?: SanitizeOptions): string {
	const tokens = ftsQueryTerms(query, options);

	if (tokens.length === 0) return '""';

	return tokens.map((t) => `"${t}"`).join(" ");
}

/**
 * The any-term form of an already-sanitized all-term query, or null when
 * broadening cannot add anything: a single token makes the two queries
 * identical, so the second fetch would return the first page again.
 */
export function relaxFtsQuery(safeQuery: string): string | null {
	const tokens = safeQuery.split(" ").filter(Boolean);

	return tokens.length > 1 ? tokens.join(" OR ") : null;
}

/**
 * The one recall fill policy, shared by every FTS surface: the strict page in
 * rank order, then partial matches in rank order until `capacity` DISTINCT rows
 * are held.
 *
 * A strict row is never displaced — a partial supplements the page, it does not
 * compete for it — and a partial already present is skipped. Broadening only
 * when the strict page came back EMPTY left an underfull page underfull and
 * silently dropped every relevant partial.
 *
 * A `partial` page of `capacity` rows is exactly enough to finish the fill, and
 * this is why the caller need fetch no more: every all-term match is also an
 * any-term match, so `partial` repeats at most the `strict.length` rows already
 * held and therefore still carries the `capacity - strict.length` new ones the
 * page is missing.
 */
export function fillToCapacity<Row>(
	strict: readonly Row[],
	partial: readonly Row[],
	capacity: number,
	idOf: (row: Row) => string,
): Row[] {
	const merged = strict.slice(0, capacity);

	if (merged.length >= capacity) return merged;
	const seen = new Set(merged.map(idOf));

	for (const row of partial) {
		if (merged.length >= capacity) break;
		const id = idOf(row);

		if (seen.has(id)) continue;
		seen.add(id);
		merged.push(row);
	}

	return merged;
}

export interface MemorySearchResult {
	path: string;
	startLine: number;
	endLine: number;
	snippet: string;
	score: number;
}
