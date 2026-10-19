// The provider is cached for the DO lifetime, so the account's login and chain must resolve per search: baking either at
// construction freezes undefined for a pre-claim first call, and a login or a Settings change after it never applies.
import { describe, test, expect, afterEach } from 'bun:test';
import type { AuthResolver, WebSearchChain, WorkersAiWebSearch } from '@kinu.run/core';
import { buildCfWebSearchProvider, DEFAULT_WEB_SEARCH_CHAIN } from '@kinu.run/core';
import { unobservedSpend } from '@kinu.run/test-utils';

type WebSearchAsked = Parameters<WorkersAiWebSearch['websearch']>[0];

const ANSWER = { items: [{ url: 'https://developers.cloudflare.com/workers/', title: 'Workers', description: 'Snippet.' }], metadata: { query: 'topic', requestId: 'r', latencyMs: 600 } };

/** The AI binding at its edge: Cloudflare's Web Search API, answering as its docs show, every request recorded. */
function searchingBinding() {
  const asked: WebSearchAsked[] = [];

  return {
    asked,
    AI: {
      websearch: async (request: WebSearchAsked) => {
        asked.push(request);

        return Response.json(ANSWER);
      },
    },
  };
}

const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/account/kinu-ai-gateway/workers-ai/v1';

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

/** Cloudflare's REST API at its edge: what each request asked, and who it was signed as. */
function stubGlobalFetch(): Array<{ url: string; authorization: string | null; body: string }> {
  const asked: Array<{ url: string; authorization: string | null; body: string }> = [];

  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    asked.push({ url: request.url, authorization: request.headers.get('authorization'), body: await request.text() });

    return Response.json(ANSWER);
  }, { preconnect: realFetch.preconnect });

  return asked;
}

const unusedBrowser = { quickAction: async () => new Response('this suite renders no page', { status: 500 }) };

const ACCOUNT_BASE = 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1';

describe('buildCfWebSearchProvider — the login and the chain are read per search', () => {
  test('a Cloudflare login that lands after the first (pre-claim) search bills the account from the next search on', async () => {
    const rest = stubGlobalFetch();
    let resolver: AuthResolver | undefined;
    const binding = searchingBinding();

    const provider = buildCfWebSearchProvider({ BROWSER: unusedBrowser, AI: binding.AI, AI_GATEWAY_URL: GATEWAY },
      { auth: () => resolver, chain: async () => ({ routes: DEFAULT_WEB_SEARCH_CHAIN, retries: 0 }) }, unobservedSpend);

    // Before the owner claims: the deployment's own search, on its gateway, on Exa's index.
    expect(await provider.search('topic')).toMatchObject({ source: 'exa', results: [{ url: 'https://developers.cloudflare.com/workers/', position: 1 }] });
    expect(binding.asked).toEqual([{ gatewayId: 'kinu-ai-gateway', query: 'topic', limit: 5, provider: 'exa' }]);

    resolver = async (key) => (key === 'cloudflare.web-search'
      ? { headers: { Authorization: 'Bearer cf-login', 'cf-aig-gateway-id': 'default' }, baseURL: ACCOUNT_BASE }
      : null);

    expect((await provider.search('topic')).source).toBe('exa');
    expect(binding.asked).toHaveLength(1);
    expect(rest.map(({ url, authorization }) => ({ url, authorization }))).toEqual([
      { url: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/websearch/', authorization: 'Bearer cf-login' },
    ]);
  });

  test("a choice saved in Settings applies to the cached provider's next search", async () => {
    const binding = searchingBinding();
    let chain: WebSearchChain = { routes: DEFAULT_WEB_SEARCH_CHAIN, retries: 0 };

    const provider = buildCfWebSearchProvider({ BROWSER: unusedBrowser, AI: binding.AI, AI_GATEWAY_URL: GATEWAY },
      { auth: () => undefined, chain: async () => chain }, unobservedSpend);

    await provider.search('one');
    chain = { routes: [{ provider: 'linkup', billing: 'cloudflare' }], retries: 0 };
    expect((await provider.search('two')).source).toBe('linkup');
    expect(binding.asked.map((asked) => asked.provider)).toEqual(['exa', 'linkup']);
  });
});
