// The provider is cached for the DO lifetime, so getAuth must resolve per call: baking it at construction freezes
// undefined for a pre-claim first call and Tavily never engages after the owner claims.
import { describe, test, expect, afterEach } from 'bun:test';
import type { AuthResolver, WorkersAiWebSearch } from '@kinu.run/core';
import { buildCfWebSearchProvider, WEB_SEARCH_INDEX } from '@kinu.run/core';
import { unobservedSpend } from '@kinu.run/test-utils';

type WebSearchAsked = Parameters<WorkersAiWebSearch['websearch']>[0];

/** The AI binding at its edge: Cloudflare's Web Search API, answering as its docs show, every request recorded. */
function searchingBinding() {
  const asked: WebSearchAsked[] = [];

  return {
    asked,
    AI: {
      websearch: async (request: WebSearchAsked) => {
        asked.push(request);

        return Response.json({ items: [{ url: 'https://example.com/a', title: 'First', description: 'Snippet.' }], metadata: { query: 'topic', requestId: 'r', latencyMs: 600 } });
      },
    },
  };
}

const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/account/kinu-ai-gateway/workers-ai/v1';

const TAVILY_BODY = JSON.stringify({
  answer: 'synthesized',
  results: [{ title: 'Doc', url: 'https://docs.example.com/x', content: 'body' }],
});

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

interface FetchRecorder { readonly authHeaders: Array<string | null> }

function stubGlobalFetch(): FetchRecorder {
  const authHeaders: Array<string | null> = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;

    if (url.includes('tavily.com')) {
      authHeaders.push(new Headers(init?.headers).get('authorization'));

      return new Response(TAVILY_BODY, { headers: { 'content-type': 'application/json' } });
    }

    return new Response('no other host answers in this suite', { status: 599 });
  }, { preconnect: realFetch.preconnect });

  return { authHeaders };
}

const unusedBrowser = { quickAction: async () => new Response('this suite renders no page', { status: 500 }) };

describe('buildCfWebSearchProvider — lazy per-call getAuth', () => {
  test('a credential that lands after the first (pre-claim) search is picked up on the cached provider', async () => {
    stubGlobalFetch();
    let resolver: AuthResolver | undefined;
    const binding = searchingBinding();
    const provider = buildCfWebSearchProvider({ BROWSER: unusedBrowser, AI: binding.AI, AI_GATEWAY_URL: GATEWAY }, () => resolver, unobservedSpend);

    // Before anyone connected Tavily: the deployment's own search, on its gateway, on Ceramic.ai's index.
    const before = await provider.search('topic');
    expect(before).toMatchObject({ source: WEB_SEARCH_INDEX, results: [{ title: 'First', url: 'https://example.com/a', snippet: 'Snippet.', position: 1 }] });
    expect(binding.asked).toEqual([{ gatewayId: 'kinu-ai-gateway', query: 'topic', limit: 5, provider: WEB_SEARCH_INDEX }]);

    resolver = async (key) => (key === 'tavily' ? { headers: { authorization: 'Bearer tvly-x' } } : null);

    // The same cached provider now routes through Tavily.
    const after = await provider.search('topic');
    expect(after.source).toBe('tavily');
    expect(after.answer).toBe('synthesized');
  });

  test('the resolver is consulted every call and its credential reaches the request', async () => {
    const { authHeaders } = stubGlobalFetch();

    const resolver: AuthResolver = async (key) =>
      (key === 'tavily' ? { headers: { authorization: 'Bearer tvly-live' } } : null);

    const provider = buildCfWebSearchProvider({ BROWSER: unusedBrowser }, () => resolver, unobservedSpend);

    await provider.search('one');
    await provider.search('two');
    expect(authHeaders).toEqual(['Bearer tvly-live', 'Bearer tvly-live']);
  });
});
