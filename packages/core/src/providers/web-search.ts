/**
 * The web search providers Kinu offers: the one table the `web` tool, Settings, onboarding, the answer's `source` and
 * the spend row read. A provider earns its entry on 36 queries judged blind (2026-10-19, docs/WEB-SEARCH.md): a mean
 * relevance of 3.0 or more of 4, under terms that allow an agent's use. Ceramic.ai, which Cloudflare's Web Search API
 * also serves and names its default, scored 1.72 and is not offered.
 */
import * as v from 'valibot';

/** One result as a provider answered it, before Kinu ranks, clips and screens it. */
export interface SearchHit {
  readonly url: string;
  readonly title?: string | undefined;
  readonly snippet?: string | undefined;
  readonly date?: string | undefined;
}

export interface SearchAnswer {
  readonly hits: readonly SearchHit[];
  /** A provider that writes an answer of its own (Tavily). */
  readonly answer?: string | undefined;
}

/** A provider's own API, called with the account's key stored under the provider's id. */
export interface DirectSearchApi {
  /** Where a person makes a key. */
  readonly keyPage: string;
  /** The most results one request takes, from its docs. */
  readonly maxResults: number;
  request(input: { readonly query: string; readonly limit: number; readonly key: string }): { readonly url: string; readonly init: RequestInit };
  readonly answer: v.GenericSchema<unknown, SearchAnswer>;
  /** Where its refusal says why. */
  readonly refusal: v.GenericSchema<unknown, string>;
}

interface WebSearchProviderEntry {
  readonly label: string;
  /** Cloudflare's Web Search API serves it under this id, billed to the gateway's account. */
  readonly cloudflare: boolean;
  readonly direct: DirectSearchApi | null;
}

/**
 * Cloudflare's Web Search API (developers.cloudflare.com/web-search/how-to-use, updated 2026-10-12): `POST
 * /accounts/{id}/ai/websearch/` or the AI binding's `websearch()`, on a gateway whose account's credits pay each provider's
 * list price.
 */
export const CLOUDFLARE_WEB_SEARCH = {
  /** "Results per request: 10" (ibid., Limits). */
  maxResults: 10,
  answer: v.pipe(
    v.object({ items: v.array(v.object({ url: v.string(), title: v.optional(v.string()), description: v.optional(v.string()) })) }),
    v.transform(({ items }): SearchAnswer => ({ hits: items.map((item) => ({ url: item.url, title: item.title, snippet: item.description })) })),
  ),
  /**
   * The API's own refusal (`web_search_payment_required`, 402, measured 2026-10-17), or the REST API's envelope (403
   * `Authentication error` to a token without Workers AI Read, measured 2026-10-19).
   */
  refusal: v.union([
    v.pipe(v.object({ error: v.object({ message: v.string() }) }), v.transform(({ error }) => error.message)),
    v.pipe(v.object({ errors: v.pipe(v.array(v.object({ message: v.string() })), v.minLength(1)) }), v.transform(({ errors }) => errors.map((e) => e.message).join('; '))),
  ]),
} as const;

/**
 * Exa: relevance 3.92 of 4 through Cloudflare, 35 of 36 answerable and current, junk in 3; $7.00 per 1,000 searches
 * (developers.cloudflare.com/web-search/providers).
 */
const EXA: WebSearchProviderEntry = { label: 'Exa', cloudflare: true, direct: null };

/** Linkup: 3.17 through Cloudflare, 32 answerable, 26 current, junk in 21; $5.00 per 1,000. */
const LINKUP: WebSearchProviderEntry = { label: 'Linkup', cloudflare: true, direct: null };

/** In the order Settings offers them. */
export const WEB_SEARCH_PROVIDER_IDS = ['exa', 'linkup'] as const;

export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

/** `satisfies` makes an id without its entry a compile error. */
export const WEB_SEARCH_PROVIDERS = {
  exa: EXA,
  linkup: LINKUP,
} as const satisfies Readonly<Record<WebSearchProviderId, WebSearchProviderEntry>>;

/** Who pays: the gateway Cloudflare's API runs on, or the person's own key at the provider. */
export const WEB_SEARCH_BILLINGS = ['cloudflare', 'key'] as const;

export type WebSearchBilling = (typeof WEB_SEARCH_BILLINGS)[number];

/** One entry of an account's search chain. */
export interface WebSearchRoute {
  readonly provider: WebSearchProviderId;
  readonly billing: WebSearchBilling;
}

/** Whether `route` names a way its provider is served. */
function servedRoute(route: WebSearchRoute): boolean {
  const entry = WEB_SEARCH_PROVIDERS[route.provider];

  return route.billing === 'cloudflare' ? entry.cloudflare : entry.direct !== null;
}

export const WebSearchRouteSchema = v.pipe(
  v.strictObject({ provider: v.picklist(WEB_SEARCH_PROVIDER_IDS), billing: v.picklist(WEB_SEARCH_BILLINGS) }),
  v.check(servedRoute, 'a search entry names a way its provider is served: Cloudflare for the indexes its API offers, a key for a provider with its own API'),
);

/** What an account searches with until it chooses: Exa, the best index on the 36, billed through Cloudflare. */
export const DEFAULT_WEB_SEARCH_CHAIN: readonly [WebSearchRoute, ...WebSearchRoute[]] = [{ provider: 'exa', billing: 'cloudflare' }];
