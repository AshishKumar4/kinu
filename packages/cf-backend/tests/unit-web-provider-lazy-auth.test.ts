// The cf web-search provider is cached for the DO lifetime, and the toolset
// holding it is cached across turns. buildCfWebSearchProvider used to bake the
// owner-scoped getAuth at construction — so a first web call before owner claim
// froze getAuth=undefined and the Tavily upgrade never engaged even after the
// claim. The fix takes a thunk resolved PER CALL. This pins that behavior.
import { describe, test, expect, afterEach } from 'bun:test';
import type { AuthResolver } from '@proteus/core';
import { buildCfWebSearchProvider } from '../src/lib/web-provider.ts';

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

function stubGlobalFetch(): { authHeaders: Array<string | null> } {
  const authHeaders: Array<string | null> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('tavily.com')) {
      authHeaders.push(new Headers(init?.headers).get('authorization'));
      return new Response(TAVILY_BODY, { headers: { 'content-type': 'application/json' } });
    }
    return new Response(DDG_HTML, { headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  return { authHeaders };
}

describe('buildCfWebSearchProvider — lazy per-call getAuth', () => {
  test('a credential that lands after the first (pre-claim) search is picked up on the cached provider', async () => {
    stubGlobalFetch();
    // Pre-claim: no owner yet, the thunk returns undefined.
    let resolver: AuthResolver | undefined;
    const provider = buildCfWebSearchProvider({}, () => resolver);

    // First search precedes owner claim → key-less DuckDuckGo.
    const before = await provider.search('topic');
    expect(before.source).toBe('duckduckgo');

    // Owner claims → the resolver now yields the stored Tavily credential.
    resolver = async (key) => (key === 'tavily' ? { headers: { authorization: 'Bearer tvly-x' } } : null);

    // The SAME cached provider now routes through Tavily — proving getAuth
    // resolved at call time, not baked undefined at construction.
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
