/**
 * The index Kinu's own web search reads through Cloudflare's Web Search API, and the `source` its answers name. Exa, the
 * best of the three the API offers on 36 queries judged blind (2026-10-19): relevance 3.92 of 4 and 35 answerable,
 * against Linkup's 3.17 and 32 and Ceramic.ai's 1.72 and 11, at $7.00 per 1,000 searches
 * (developers.cloudflare.com/web-search/providers).
 */
export const WEB_SEARCH_INDEX = 'exa' as const;
