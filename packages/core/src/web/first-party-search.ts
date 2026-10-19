/**
 * The deployment's own web search ({@link FirstPartySearch}): Cloudflare's Web Search API, called through the Worker's
 * AI binding on the platform's gateway, or, from the CLI, through the signed-in account's gated route that makes the
 * same call. One request shape and one answer either way: the route hands the API's response back as it came.
 */
import * as v from 'valibot';
import type { FirstPartySearch } from './provider';
import { parseGatewayTarget } from '../providers/gateway-binding-fetch';
import { workersAiWebSearch, type WorkersAiWebSearch } from '../providers/model-invocation';
import { WEB_SEARCH_INDEX } from './search-index';
import type { ModelCallSink } from '../events/model-call';

/** `POST`, CLI-bearer gated as the inference proxy is: a search on the platform's gateway for a CLI signed in to it. */
export const USER_WEB_SEARCH_PATH = '/api/user/web/search';

export const WebSearchRequestSchema = v.strictObject({
  query: v.pipe(v.string(), v.nonEmpty()),
  limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)),
});


/**
 * Search through the binding on the gateway `AI_GATEWAY_URL` names, billed to that account's AI Gateway credits, each
 * search filed to `report`. Null where the Worker has no binding that searches or no gateway configured: search then
 * needs a Tavily key.
 */
export function bindingWebSearch(env: { readonly AI?: Partial<WorkersAiWebSearch>; readonly AI_GATEWAY_URL?: string }, report: ModelCallSink): FirstPartySearch | null {
  const websearch = workersAiWebSearch(env, report);
  const target = parseGatewayTarget(env.AI_GATEWAY_URL);

  if (websearch === undefined || 'reason' in target) return null;

  return { search: ({ query, limit }) => websearch({ gatewayId: target.id, query, limit, provider: WEB_SEARCH_INDEX }) };
}

/** Search through the signed-in account's route at `origin`, as the CLI reaches the platform's models. */
export function routeWebSearch(input: { readonly origin: string; readonly token: string; readonly fetch: typeof fetch }): FirstPartySearch {
  const url = `${input.origin.replace(/\/+$/, '')}${USER_WEB_SEARCH_PATH}`;
  const fetchImpl = input.fetch;

  return {
    search: async ({ query, limit, signal }) => fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, limit }),
      ...(signal !== undefined && { signal }),
    }),
  };
}
