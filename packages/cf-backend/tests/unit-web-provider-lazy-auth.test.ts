// The provider is cached for the DO lifetime, so getAuth must resolve per call: baking it at construction freezes
// undefined for a pre-claim first call and Tavily never engages after the owner claims.
import { describe, test, expect, afterEach } from 'bun:test';
import type { AuthResolver } from '@kinu.run/core';
import { buildCfWebSearchProvider } from '@kinu.run/core';

const DDG_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First</a>
  <a class="result__snippet">Snippet.</a>
</div>`;

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

    return new Response(DDG_HTML, { headers: { 'content-type': 'text/html' } });
  }, { preconnect: realFetch.preconnect });

  return { authHeaders };
}

describe('buildCfWebSearchProvider — lazy per-call getAuth', () => {
  test('a credential that lands after the first (pre-claim) search is picked up on the cached provider', async () => {
    stubGlobalFetch();
    let resolver: AuthResolver | undefined;
    const provider = buildCfWebSearchProvider({}, () => resolver);

    const before = await provider.search('topic');
    expect(before.source).toBe('duckduckgo');

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

    const provider = buildCfWebSearchProvider({}, () => resolver);

    await provider.search('one');
    await provider.search('two');
    expect(authHeaders).toEqual(['Bearer tvly-live', 'Bearer tvly-live']);
  });
});
