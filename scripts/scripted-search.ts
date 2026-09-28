/**
 * The tiers' web search, answered the way Tavily's `/search` answers, so a case drives the keyed search path whole:
 * the tool call, the provider's request and its result shaping. Pure: the scripted model's Worker serves it behind
 * the same bearer as the model. Whether a real search provider answers from a Worker is the evals' question.
 */
import * as v from 'valibot';

const SearchRequestSchema = v.object({ query: v.pipe(v.string(), v.minLength(1)), max_results: v.optional(v.number()) });

/** Results any query gets, public pages whose URLs pass the provider's own safety check. */
const RESULTS = [
  { title: 'Durable Objects · Cloudflare Docs', url: 'https://developers.cloudflare.com/durable-objects/' },
  { title: 'Workers · Cloudflare Docs', url: 'https://developers.cloudflare.com/workers/' },
  { title: 'Cloudflare Blog', url: 'https://blog.cloudflare.com/' },
] as const;

/** Tavily's answer to one search request body, or the provider-shaped refusal of a body it cannot read. */
export function scriptedSearch(body: string) {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), SearchRequestSchema), body);

  if (!parsed.success) return { status: 400, body: JSON.stringify({ detail: { error: v.summarize(parsed.issues) } }) };
  const { query, max_results: limit = 5 } = parsed.output;

  return {
    status: 200,
    body: JSON.stringify({
      query,
      answer: `Scripted results for "${query}".`,
      results: RESULTS.slice(0, limit).map((result) => ({ ...result, content: `A scripted page about ${query}.` })),
    }),
  };
}
