/**
 * Behavioral tests for the web search + fetch capability.
 *
 * Covers, on the SHARED core layer (both backends construct the same provider):
 *   - search returns ranked results (Tavily path + DuckDuckGo key-less path),
 *     capturing the injected fetch stub
 *   - fetch returns clamped markdown + a VFS restore path for big pages
 *   - the `web` builtin (search / fetch actions) is gated on the provider dep
 *   - codemode `web.search()` / `web.fetch()` reach the same provider
 *   - SSRF + secret-exfil URL guards
 *   - error mapping (rate-limit retriable, http errors)
 */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { tool, jsonSchema } from 'ai';
import * as v from 'valibot';
import { createTestRuntime } from './helpers';
import {
  buildBuiltinTools,
  createDefaultWebSearchProvider,
  createWebCodemodeProvider,
  assertSafeUrl,
  isSafeUrl,
  UnsafeUrlError,
  WebFetchError,
  stripBase64Images,
  TOOL_OUTPUT_DIR,
  decodeJsonValue,
  projectJsonValue,
  type CraftedToolExecute,
  type CodemodeProvider,
  type CreateExecuteToolFactory,
  type JsonValue,
  type WebSearchProvider,
} from '../src/index';

const unusedCraftedExecute: CraftedToolExecute = () => async () => {
  throw new Error('This web-tool suite does not install crafted tools');
};

/** execute_tools factory that wires every injected provider namespace into the
 *  sandbox by name (mirrors the cli-backend factory) so codemode `web.*` works. */
function createNodeExecFactory(codemodeProviders: CodemodeProvider[] = []): CreateExecuteToolFactory {
  return (opts) => {
    const codemode = opts.craftedTools();
    const nsBindings: Record<string, Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>>> = {};
    for (const provider of opts.providers) {
      const namespace: Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>> = {};
      for (const [toolName, entry] of Object.entries(provider.tools)) {
        namespace[toolName] = async (...args) => await entry.execute(...args);
      }
      nsBindings[provider.name] = namespace;
    }
    for (const provider of codemodeProviders) {
      const namespace: Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>> = {};
      for (const [toolName, entry] of Object.entries(provider.tools)) {
        namespace[toolName] = async (...args) => {
          const result = await entry.execute(...args);
          return result === undefined ? undefined : projectJsonValue({ value: result });
        };
      }
      nsBindings[provider.name] = namespace;
    }
    const extras = Object.keys(nsBindings);
    return tool({
      description: 'test exec_tools',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
      }),
      execute: async (a: { code: string }) => {
        try {
          const fn = new Function('workspace', 'codemode', ...extras,
            'return (async () => { ' + a.code + ' })()');
          const rawResult = await fn({}, codemode, ...extras.map((name) => nsBindings[name]));
          const result = v.safeParse(v.undefined(), rawResult).success
            ? undefined
            : decodeJsonValue({ value: rawResult });
          return { result };
        } catch (error) {
          return { result: undefined, error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  };
}

const nodeExecFactory = createNodeExecFactory();

interface StubResponse {
  ok?: boolean;
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

interface StubFetch {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
}

/** Build a fetch stub from a URL→response map, recording the calls. */
function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse): StubFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input).url;
    calls.push({ url, init });
    const r = handler(url, init);
    const status = r.status ?? (r.ok === false ? 500 : 200);
    return new Response(r.body, {
      status,
      headers: new Headers(r.headers ?? { 'content-type': 'text/html' }),
    });
  }, { preconnect: fetch.preconnect }) satisfies typeof fetch;
  return { fetch: fn, calls };
}

const DDG_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First &amp; Best</a>
  <a class="result__snippet">Snippet one about the topic.</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second Result</a>
  <a class="result__snippet">Snippet two.</a>
</div>`;

describe('web provider — search', () => {
  test('key-less DuckDuckGo path returns ranked results', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: DDG_HTML }));
    const provider = createDefaultWebSearchProvider({ fetch });
    const res = await provider.search('the topic', { limit: 5 });

    expect(res.source).toBe('duckduckgo');
    expect(res.results.length).toBe(2);
    expect(res.results[0]).toMatchObject({ position: 1, title: 'First & Best', url: 'https://example.com/a' });
    expect(res.results[0].snippet).toContain('Snippet one');
    expect(res.results[1].url).toBe('https://example.org/b');
    expect(calls[0].url).toContain('html.duckduckgo.com');
  });

  test('workerd this-binding regression: search and fetch invoke the injected fetch unbound', async () => {
    const thisSensitiveFetch = Object.assign(async function (
      this: void,
      input: RequestInfo | URL,
    ): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
      }
      const url = new Request(input).url;
      const isSearch = url.includes('html.duckduckgo.com');
      return new Response(isSearch ? DDG_HTML : '# Plain page\n\nFetched safely.', {
        headers: { 'content-type': isSearch ? 'text/html' : 'text/markdown' },
      });
    }, { preconnect: fetch.preconnect }) satisfies typeof fetch;
    const provider = createDefaultWebSearchProvider({ fetch: thisSensitiveFetch });

    const searchResult = await provider.search('the topic');
    const fetchResult = await provider.fetch('https://example.com/page');

    expect(searchResult.results[0]?.url).toBe('https://example.com/a');
    expect(fetchResult.markdown).toBe('# Plain page\n\nFetched safely.');
  });

  test('Tavily path used when a credential resolves, with ranked results + answer', async () => {
    const tavilyBody = JSON.stringify({
      answer: 'A synthesized answer.',
      results: [
        { title: 'Doc', url: 'https://docs.example.com/x', content: 'Body text', published_date: '2026-01-02' },
      ],
    });
    const { fetch, calls } = stubFetch((url) => {
      if (url.includes('tavily.com')) return { body: tavilyBody, headers: { 'content-type': 'application/json' } };
      return { body: DDG_HTML };
    });
    const provider = createDefaultWebSearchProvider({
      fetch,
      getAuth: async (key) => (key === 'tavily' ? { headers: { authorization: 'Bearer tvly-test' } } : null),
    });
    const res = await provider.search('query', { limit: 3 });

    expect(res.source).toBe('tavily');
    expect(res.answer).toBe('A synthesized answer.');
    expect(res.results[0]).toMatchObject({ position: 1, url: 'https://docs.example.com/x', date: '2026-01-02' });
    expect(calls[0].url).toContain('tavily.com');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toContain('tvly-test');
  });
  test('an unreadable Tavily response maps to a non-retriable WebFetchError with cause', async () => {
    const bodies = ['not-json-at-all', JSON.stringify({ results: [{ url: 123 }] })];
    for (const body of bodies) {
      const { fetch } = stubFetch((url) => {
        if (url.includes('tavily.com')) return { body, headers: { 'content-type': 'application/json' } };
        return { body: DDG_HTML };
      });
      const provider = createDefaultWebSearchProvider({
        fetch,
        getAuth: async (key) => (key === 'tavily' ? { headers: { authorization: 'Bearer tvly-test' } } : null),
      });
      const attempt = provider.search('query');
      await expect(attempt).rejects.toMatchObject({ name: 'WebFetchError', retriable: false });
      await expect(attempt).rejects.toThrow(/unreadable.*Tavily|Tavily.*unreadable/i);
      await expect(attempt).rejects.toMatchObject({ cause: expect.anything() });
    }
  });

  test('DuckDuckGo rate-limit maps to a retriable error', async () => {
    const { fetch } = stubFetch(() => ({ status: 429, body: '' }));
    const provider = createDefaultWebSearchProvider({ fetch });
    await expect(provider.search('x')).rejects.toMatchObject({ name: 'WebFetchError', retriable: true });
  });

  test('empty query is rejected', async () => {
    const { fetch } = stubFetch(() => ({ body: '' }));
    const provider = createDefaultWebSearchProvider({ fetch });
    await expect(provider.search('   ')).rejects.toBeInstanceOf(WebFetchError);
  });
});

describe('web provider — fetch', () => {
  test('HTML page is converted to markdown', async () => {
    const html = '<html><head><title>Hello</title><script>bad()</script></head><body><h1>Heading</h1><p>Para <a href="https://x.com">link</a></p></body></html>';
    const { fetch } = stubFetch(() => ({ body: html, headers: { 'content-type': 'text/html' } }));
    const provider = createDefaultWebSearchProvider({ fetch });
    const res = await provider.fetch('https://example.com/page');

    expect(res.title).toBe('Hello');
    expect(res.markdown).toContain('# Heading');
    expect(res.markdown).toContain('[link](https://x.com)');
    expect(res.markdown).not.toContain('bad()');
    expect(res.url).toBe('https://example.com/page');
  });

  test('text/markdown content passes through without HTML conversion', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: '# Already Markdown\n\nclean', headers: { 'content-type': 'text/markdown' } }));
    const provider = createDefaultWebSearchProvider({ fetch });
    const res = await provider.fetch('https://example.com/md');
    expect(res.markdown).toBe('# Already Markdown\n\nclean');
    expect(res.title).toBe('Already Markdown'); // first heading when no HTML <title>
    // Markdown-for-Agents Accept header is sent.
    expect(new Headers(calls[0]!.init?.headers).get('accept')).toContain('text/markdown');
  });

  test('markdown frontmatter title is extracted', async () => {
    const body = '---\ntitle: Durable Objects\ndescription: x\n---\n\n# Heading\n\nbody';
    const { fetch } = stubFetch(() => ({ body, headers: { 'content-type': 'text/markdown' } }));
    const provider = createDefaultWebSearchProvider({ fetch });
    const res = await provider.fetch('https://example.com/md');
    expect(res.title).toBe('Durable Objects');
  });

  test('htmlToMarkdown override (cf env.AI.toMarkdown) is used and base64-stripped', async () => {
    const html = '<html><body>x</body></html>';
    const { fetch } = stubFetch(() => ({ body: html }));
    const provider = createDefaultWebSearchProvider({
      fetch,
      htmlToMarkdown: async () => 'converted ![](data:image/png;base64,AAAA) tail',
    });
    const res = await provider.fetch('https://example.com');
    expect(res.markdown).toContain('converted');
    expect(res.markdown).not.toContain('base64,AAAA');
  });

  test('a throwing htmlToMarkdown override falls back to the local converter', async () => {
    const html = '<html><head><title>Hello</title></head><body><h1>Heading</h1><p>Para</p></body></html>';
    const { fetch } = stubFetch(() => ({ body: html, headers: { 'content-type': 'text/html' } }));
    const provider = createDefaultWebSearchProvider({
      fetch,
      htmlToMarkdown: async () => { throw new Error('cf AI.toMarkdown blew up'); },
    });
    const res = await provider.fetch('https://example.com/page');
    expect(res.markdown).toContain('# Heading');
    expect(res.markdown).toContain('Para');
  });

  test('http error maps to a WebFetchError', async () => {
    const { fetch } = stubFetch(() => ({ status: 404, body: 'nope' }));
    const provider = createDefaultWebSearchProvider({ fetch });
    await expect(provider.fetch('https://example.com/missing')).rejects.toBeInstanceOf(WebFetchError);
  });

  test('SECURITY: a redirect to a private/metadata address is refused before the second hop', async () => {
    // The fake models the platform redirect contract: with redirect:'follow'
    // the platform itself chases Location (so the fake performs that hop);
    // with redirect:'manual' it hands the 302 back untouched.
    const calls: string[] = [];
    const fakeFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input).url;
      calls.push(url);
      if (url === 'https://example.com/start') {
        if ((init?.redirect ?? 'follow') === 'follow') {
          calls.push('http://169.254.169.254/');
          return new Response('metadata secret', { headers: { 'content-type': 'text/plain' } });
        }
        return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
      }
      return new Response('unexpected hop', { headers: { 'content-type': 'text/plain' } });
    }, { preconnect: fetch.preconnect }) satisfies typeof fetch;
    const provider = createDefaultWebSearchProvider({ fetch: fakeFetch });
    const attempt = provider.fetch('https://example.com/start');
    await expect(attempt).rejects.toBeInstanceOf(WebFetchError);
    // The refusal leads with the guard's reason, like the initial-URL check.
    await expect(attempt).rejects.toThrow(/169\.254\.169\.254/);
    expect(calls).toEqual(['https://example.com/start']); // never left for the metadata host
  });

  test('a safe relative redirect succeeds and reports the final URL', async () => {
    const { fetch, calls } = stubFetch((url): StubResponse => {
      if (url === 'https://example.com/start') {
        return { status: 302, body: '', headers: { location: '/final' } };
      }
      return { body: '# Final page', headers: { 'content-type': 'text/markdown' } };
    });
    const provider = createDefaultWebSearchProvider({ fetch });
    const res = await provider.fetch('https://example.com/start');
    expect(res.url).toBe('https://example.com/final');
    expect(res.markdown).toBe('# Final page');
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/start', 'https://example.com/final']);
  });

  test('a redirect loop stops at the fetch-standard bound instead of hanging', async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 302, body: '', headers: { location: '/loop' } }));
    const provider = createDefaultWebSearchProvider({ fetch });
    await expect(provider.fetch('https://example.com/loop')).rejects.toThrow(/too many redirects/);
    expect(calls.length).toBe(21); // the initial request plus 20 bound follows
  });

  test('an oversize body stops at the cap instead of buffering everything', async () => {
    let pulls = 0;
    const chunk = new Uint8Array(65_536);
    const totalChunks = 40; // ~2.5 MB, over the 2 MB cap
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const bigFetch = Object.assign(
      async () => new Response(stream, { headers: { 'content-type': 'text/plain' } }),
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch;
    const provider = createDefaultWebSearchProvider({ fetch: bigFetch });
    const res = await provider.fetch('https://example.com/big');
    expect(res.markdown).toContain('[fetch truncated: kept the first');
    expect(pulls).toBeLessThan(totalChunks);
  });

  test('a trickling body past the timeout rejects as timed out', async () => {
    // Real timers: the behavior under test IS the wall clock (a body that
    // trickles past timeoutMs must reject), so fake timers cannot drive it.
    const makeStream = () => new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode('hello '));
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 300);
        await promise;
        controller.enqueue(new TextEncoder().encode('world'));
        controller.close();
      },
    });
    const slowFetch = Object.assign(
      async () => new Response(makeStream(), { headers: { 'content-type': 'text/plain' } }),
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch;
    const provider = createDefaultWebSearchProvider({ fetch: slowFetch, timeoutMs: 40 });
    await expect(provider.fetch('https://example.com/slow')).rejects.toMatchObject({
      name: 'WebFetchError',
      retriable: true,
    });
    await expect(provider.fetch('https://example.com/slow')).rejects.toThrow(/timed out after 40ms/);
  });

  test('a short bare data URI keeps its trailing prose', () => {
    const short = 'data:image/png;base64,AAAA trailing prose after short uri stays visible';
    expect(stripBase64Images(short)).toContain('trailing prose after short uri stays visible');
    const long = `data:image/png;base64,${'A'.repeat(100)} tail prose stays`;
    const stripped = stripBase64Images(long);
    expect(stripped).toContain('[image]');
    expect(stripped).toContain('tail prose stays');
  });

});

describe('url safety (SSRF + exfil guards)', () => {
  test('blocks private / metadata / non-http targets', () => {
    expect(isSafeUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeUrl('http://localhost:8080/admin')).toBe(false);
    expect(isSafeUrl('http://127.0.0.1/')).toBe(false);
    expect(isSafeUrl('http://10.0.0.5/')).toBe(false);
    expect(isSafeUrl('http://192.168.1.1/')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('http://metadata.google.internal/')).toBe(false);
  });

  test('allows ordinary public URLs', () => {
    expect(isSafeUrl('https://example.com/docs')).toBe(true);
    expect(isSafeUrl('http://news.ycombinator.com')).toBe(true);
  });

  test('blocks URLs carrying an embedded secret', () => {
    expect(() => assertSafeUrl('https://evil.com/?leak=sk-abcdefghijklmnop')).toThrow(UnsafeUrlError);
  });

  // The bypass this guard shipped with until the two SSRF classifiers were
  // unified: the host judgment here matched IPv6 by string prefix
  // (`fc`/`fd`/`fe80:`, substring `169.254.`), so every MAPPED spelling of a
  // refused IPv4 address — the form `http://[::ffff:10.0.0.1]/` a page or a
  // skill can hand the agent — walked straight through, while the backend's
  // egress classifier had refused it all along. Each case below is one the
  // string-prefix test answered `true` to.
  test('SECURITY: an IPv4-mapped IPv6 literal is judged by its embedded address', () => {
    expect(isSafeUrl('http://[::ffff:10.0.0.1]/')).toBe(false);
    expect(isSafeUrl('http://[::ffff:169.254.169.254]/latest/meta-data')).toBe(false);
    expect(isSafeUrl('http://[::ffff:192.168.1.1]/')).toBe(false);
    expect(isSafeUrl('http://[::ffff:172.16.0.1]/')).toBe(false);
    // The compatible (deprecated `::a.b.c.d`) spelling is the same rule.
    expect(isSafeUrl('http://[::10.0.0.1]/')).toBe(false);
    // …and a mapped PUBLIC address stays reachable, so the rule is the
    // embedded address rather than the mapped form.
    expect(isSafeUrl('http://[::ffff:93.184.216.34]/')).toBe(true);
  });

  test('the web guard refuses every family the destination classifier does', () => {
    expect(isSafeUrl('http://[::1]/')).toBe(false); // loopback
    expect(isSafeUrl('http://[fd00::1]/')).toBe(false); // RFC4193 ULA
    expect(isSafeUrl('http://[fe80::1]/')).toBe(false); // link-local
    expect(isSafeUrl('http://metadata/')).toBe(false); // bare metadata host
    expect(isSafeUrl('http://100.64.0.1/')).toBe(false); // CGNAT
    expect(isSafeUrl('http://0.0.0.0/')).toBe(false); // this-network
    expect(isSafeUrl('http://api.service.localhost/')).toBe(false); // RFC6761
    expect(isSafeUrl('http://svc.internal/')).toBe(false); // private-use TLD
    // Fail-closed on a bracketed literal that is not IPv6 at all.
    expect(isSafeUrl('http://[not-an-address]/')).toBe(false);
  });

  test('provider.fetch refuses the mapped form too — nothing leaves the runtime', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: 'x' }));
    const provider = createDefaultWebSearchProvider({ fetch });
    await expect(provider.fetch('http://[::ffff:169.254.169.254]/')).rejects.toBeInstanceOf(WebFetchError);
    expect(calls.length).toBe(0);
  });

  test('provider.fetch refuses an unsafe URL', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: 'x' }));
    const provider = createDefaultWebSearchProvider({ fetch });
    await expect(provider.fetch('http://169.254.169.254/')).rejects.toBeInstanceOf(WebFetchError);
    expect(calls.length).toBe(0); // never left the runtime
  });
});

// ── Tool wiring ────────────────────────────────────────────────────────────

type WebArgs = { action: 'search' | 'fetch'; query?: string; url?: string; limit?: number };

function buildWithWeb(rt: ReturnType<typeof createTestRuntime>['rt'], webSearch?: WebSearchProvider) {
  const provider = webSearch ?? createDefaultWebSearchProvider({ fetch: stubFetch(() => ({ body: DDG_HTML })).fetch });
  return buildBuiltinTools({
    rt,
    craftedToolExecute: unusedCraftedExecute,
    createExecuteTool: createNodeExecFactory([createWebCodemodeProvider(provider)]),
    codemodeLoader: { __test: true },
    webSearch: provider,
  });
}

describe('web builtin', () => {
  test('gated on the webSearch dep', () => {
    const { rt } = createTestRuntime();
    const without = buildBuiltinTools({
      rt, craftedToolExecute: unusedCraftedExecute,
      createExecuteTool: nodeExecFactory, codemodeLoader: {},
    });
    expect(Object.keys(without)).not.toContain('web');

    const withWeb = buildWithWeb(rt);
    expect(Object.keys(withWeb)).toContain('web');
  });

  test('action=search returns ranked, model-ready text', async () => {
    const { rt } = createTestRuntime();
    const execute = toolExecute<WebArgs, string>(buildWithWeb(rt).web);
    const out = await execute({ action: 'search', query: 'the topic' });
    expect(out).toContain('1. First & Best');
    expect(out).toContain('https://example.com/a');
    expect(out).toContain('via duckduckgo');
  });

  test('a call missing the argument its action needs says which', async () => {
    const { rt } = createTestRuntime();
    const execute = toolExecute<WebArgs, JsonValue>(buildWithWeb(rt).web);
    expect(await execute({ action: 'search' })).toEqual({ error: 'web.search requires `query`' });
    expect(await execute({ action: 'fetch' })).toEqual({ error: 'web.fetch requires `url`' });
  });

  test('action=fetch clamps a big page to a head with a VFS restore path', async () => {
    const { rt } = createTestRuntime();
    const big = '<html><body>' + 'word '.repeat(20000) + '</body></html>';
    const provider = createDefaultWebSearchProvider({ fetch: stubFetch(() => ({ body: big, headers: { 'content-type': 'text/html' } })).fetch });
    const execute = toolExecute<WebArgs, string>(buildWithWeb(rt, provider).web);
    const out = await execute({ action: 'fetch', url: 'https://example.com/big' });

    expect(out).toContain('Source: https://example.com/big');
    expect(out).toContain('[output truncated');
    expect(out).toContain(`${TOOL_OUTPUT_DIR}/`);
    // The full output is restorable from the VFS.
    const m = /full output saved to (\S+)/.exec(out);
    expect(m).toBeTruthy();
    const saved = await rt.storage.vfs.readFile(m?.[1] ?? '', { encoding: 'utf8' });
    expect(String(saved).length).toBeGreaterThan(out.length);
  });

  test('a provider error maps to a structured error object', async () => {
    const { rt } = createTestRuntime();
    const failing: WebSearchProvider = {
      search: async () => { throw new WebFetchError('rate limited', true); },
      fetch: async () => { throw new WebFetchError('x'); },
    };
    const execute = toolExecute<WebArgs, JsonValue>(buildWithWeb(rt, failing).web);
    expect(await execute({ action: 'search', query: 'x' }))
      .toMatchObject({ error: 'rate limited', retriable: true });
    expect(await execute({ action: 'fetch', url: 'https://example.com' }))
      .toMatchObject({ error: 'x' });
  });

  test('codemode can call web.search() and web.fetch()', async () => {
    const { rt } = createTestRuntime();
    const provider = createDefaultWebSearchProvider({
      fetch: stubFetch((url) =>
        url.includes('duckduckgo') ? { body: DDG_HTML } : { body: '<html><body><p>page body</p></body></html>' },
      ).fetch,
    });
    const execute = toolExecute<{ code: string }, { result: JsonValue | undefined }>(
      buildWithWeb(rt, provider).execute_tools,
    );

    const searched = await execute({
      code: 'const r = await web.search("topic", { limit: 2 }); return r.results.length;',
    });
    expect(searched.result).toBe(2);

    const fetched = await execute({
      code: 'const r = await web.fetch("https://example.com/p"); return r.markdown;',
    });
    expect(String(fetched.result)).toContain('page body');
  });
});
