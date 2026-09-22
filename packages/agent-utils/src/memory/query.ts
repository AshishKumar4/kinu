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
 * Terms an FTS query reduces to (operators and, unless disabled, stop words removed). Exported so
 * non-SQL lexical matchers share the same query normalization.
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

/** Any-term form of a sanitized query, or null when a single token makes it identical. */
export function relaxFtsQuery(safeQuery: string): string | null {
	const tokens = safeQuery.split(" ").filter(Boolean);

	return tokens.length > 1 ? tokens.join(" OR ") : null;
}

/**
 * Shared recall fill policy: the strict page in rank order, then partial matches until `capacity`
 * distinct rows. One `capacity`-sized partial page suffices: every strict match is also a partial match.
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
