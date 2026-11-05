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

/** A query's words as FTS5 phrases: split on anything but a letter, digit or underscore (any script), each quoted, so
 *  no word reads as FTS5 syntax. */
export function ftsPhrases(query: string): string[] {
	return query.split(/[^\p{L}\p{N}_]+/u).filter(Boolean).map((word) => `"${word}"`);
}

/** Phrases a recall query reduces to: operators and stop words removed, unless nothing else is left. */
function ftsQueryTerms(query: string): string[] {
	const phrases = ftsPhrases(query);

	const kept = phrases.filter((phrase) => {
		const word = phrase.slice(1, -1);

		return !FTS_OPERATORS.has(word.toUpperCase()) && !STOP_WORDS.has(word.toLowerCase());
	});

	return kept.length === 0 ? phrases : kept;
}

function sanitizeFtsQuery(query: string): string {
	const terms = ftsQueryTerms(query);

	return terms.length === 0 ? '""' : terms.join(" ");
}

/** Any-term form of a sanitized query, or null when a single token makes it identical. */
function relaxFtsQuery(safeQuery: string): string | null {
	const tokens = safeQuery.split(" ").filter(Boolean);

	return tokens.length > 1 ? tokens.join(" OR ") : null;
}

/** Keep the strict page first, querying partial matches only when it needs filling. */
export function searchFts<Row>(
	query: string,
	capacity: number,
	matching: (query: string, capacity: number) => Row[],
	idOf: (row: Row) => string,
): Row[] {
	const safe = sanitizeFtsQuery(query);
	const strict = matching(safe, capacity);
	const relaxed = strict.length >= capacity ? null : relaxFtsQuery(safe);

	return relaxed === null ? strict : fillToCapacity(strict, matching(relaxed, capacity), capacity, idOf);
}

/**
 * Shared recall fill policy: the strict page in rank order, then partial matches until `capacity`
 * distinct rows. One `capacity`-sized partial page suffices: every strict match is also a partial match.
 */
function fillToCapacity<Row>(
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
	/** When its note was last written, where the reader knows. */
	writtenAt?: number;
}
