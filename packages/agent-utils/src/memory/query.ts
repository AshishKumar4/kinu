const FTS_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);

export const STOP_WORDS = new Set([
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

export function sanitizeFtsQuery(query: string, options?: SanitizeOptions): string {
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
		const fallback = query.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
		if (fallback.length === 0) return '""';
		return fallback.map((t) => `"${t}"`).join(" ");
	}
	return tokens.map((t) => `"${t}"`).join(" ");
}

export interface MemorySearchResult {
	path: string;
	startLine: number;
	endLine: number;
	snippet: string;
	score: number;
}
