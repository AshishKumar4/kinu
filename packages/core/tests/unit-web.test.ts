/**
 * Behavioral tests for the web search + fetch capability.
 *
 * Covers, on the SHARED core layer (both backends construct the same provider):
 *   - search returns ranked results (Tavily path + DuckDuckGo key-less path),
 *     capturing the injected fetch stub
 *   - fetch returns clamped markdown + a VFS restore path for big pages
 *   - the web_search / web_fetch builtins are gated on the provider dep
 *   - codemode `web.search()` / `web.fetch()` reach the same provider
 *   - SSRF + secret-exfil URL guards
 *   - error mapping (rate-limit retriable, http errors)
 */

import { describe, test, expect } from 'bun:test';
import { tool, jsonSchema } from 'ai';
import { createTestRuntime } from './helpers.js';
import {
  buildBuiltinTools,
  createDefaultWebSearchProvider,
  createWebCodemodeProvider,
  assertSafeUrl,
  isSafeUrl,
  UnsafeUrlError,
  WebFetchError,
  TOOL_OUTPUT_DIR,
  type CraftedToolExecute,
  type WebSearchProvider,
} from '../src/index.js';

const nodeCraftedExecute: CraftedToolExecute = (t) => {
  let compiled: ((arg: unknown) => Promise<unknown>) | null = null;
  return async (arg) => {
    if (!compiled) {
      const fn = new Function('return (' + t.code + ')')();
      compiled = fn as (arg: unknown) => Promise<unknown>;
    }
    return compiled(arg);
  };
};

/** execute_tools factory that wires every injected provider namespace into the
 *  sandbox by name (mirrors the cli-backend factory) so codemode `web.*` works. */
const nodeExecFactory = (opts: {
  tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  providers: unknown[];
}) => {
  const codemode: Record<string, (arg: unknown) => Promise<unknown>> = {};
  for (const [n, e] of Object.entries(opts.tools)) codemode[n] = e.execute as (arg: unknown) => Promise<unknown>;
  const nsBindings: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> = {};
  for (const p of opts.providers as Array<{ name: string; tools: Record<string, { execute: (...a: unknown[]) => Promise<unknown> }> }>) {
    if (!p?.name || !p.tools) continue;
    const nsp: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    for (const [k, t] of Object.entries(p.tools)) nsp[k] = (...a) => t.execute(...a);
    nsBindings[p.name] = nsp;
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
        const result = await fn({}, codemode, ...extras.map((n) => nsBindings[n]));
        return { result };
      } catch (e) {
        return { result: undefined, error: (e as Error).message };
      }
    },
  });
};

interface StubResponse {
  ok?: boolean;
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

/** Build a fetch stub from a URL→response map, recording the calls. */
function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const r = handler(url, init);
    const status = r.status ?? (r.ok === false ? 500 : 200);
    return {
      ok: r.ok ?? status < 400,
      status,
      headers: new Headers(r.headers ?? { 'content-type': 'text/html' }),
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
      arrayBuffer: async () => new TextEncoder().encode(r.body).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
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
    const thisSensitiveFetch = async function (
      this: unknown,
      input: RequestInfo | URL,
    ): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
      }
      const url = typeof input === 'string' ? input : input.toString();
      const isSearch = url.includes('html.duckduckgo.com');
      return new Response(isSearch ? DDG_HTML : '# Plain page\n\nFetched safely.', {
        headers: { 'content-type': isSearch ? 'text/html' : 'text/markdown' },
      });
    } as typeof fetch;
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
    expect((calls[0].init?.headers as Record<string, string>).authorization).toContain('tvly-test');
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
    expect((calls[0].init?.headers as Record<string, string>).accept).toContain('text/markdown');
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

  test('http error maps to a WebFetchError', async () => {
    const { fetch } = stubFetch(() => ({ status: 404, body: 'nope' }));
    const provider = createDefaultWebSearchProvider({ fetch });
    await expect(provider.fetch('https://example.com/missing')).rejects.toBeInstanceOf(WebFetchError);
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

  test('provider.fetch refuses an unsafe URL', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: 'x' }));
    const provider = createDefaultWebSearchProvider({ fetch });
    await expect(provider.fetch('http://169.254.169.254/')).rejects.toBeInstanceOf(WebFetchError);
    expect(calls.length).toBe(0); // never left the runtime
  });
});

// ── Tool wiring ────────────────────────────────────────────────────────────

function buildWithWeb(rt: ReturnType<typeof createTestRuntime>['rt'], webSearch?: WebSearchProvider) {
  const provider = webSearch ?? createDefaultWebSearchProvider({ fetch: stubFetch(() => ({ body: DDG_HTML })).fetch });
  return buildBuiltinTools({
    rt,
    craftedToolExecute: nodeCraftedExecute,
    createExecuteTool: ((opts: Parameters<typeof nodeExecFactory>[0]) =>
      nodeExecFactory({ ...opts, providers: [createWebCodemodeProvider(provider)] })) as never,
    codemodeLoader: { __test: true } as unknown,
    webSearch: provider,
  });
}

describe('web_search / web_fetch builtins', () => {
  test('gated on the webSearch dep', () => {
    const { rt } = createTestRuntime();
    const without = buildBuiltinTools({
      rt, craftedToolExecute: nodeCraftedExecute,
      createExecuteTool: nodeExecFactory as never, codemodeLoader: {} as unknown,
    });
    expect(Object.keys(without)).not.toContain('web_search');
    expect(Object.keys(without)).not.toContain('web_fetch');

    const withWeb = buildWithWeb(rt);
    expect(Object.keys(withWeb)).toContain('web_search');
    expect(Object.keys(withWeb)).toContain('web_fetch');
  });

  test('web_search returns ranked, model-ready text', async () => {
    const { rt } = createTestRuntime();
    const t = buildWithWeb(rt) as { web_search: { execute: (a: { query: string }) => Promise<string> } };
    const out = await t.web_search.execute({ query: 'the topic' });
    expect(out).toContain('1. First & Best');
    expect(out).toContain('https://example.com/a');
    expect(out).toContain('via duckduckgo');
  });

  test('web_fetch clamps a big page to a head with a VFS restore path', async () => {
    const { rt } = createTestRuntime();
    const big = '<html><body>' + 'word '.repeat(20000) + '</body></html>';
    const provider = createDefaultWebSearchProvider({ fetch: stubFetch(() => ({ body: big, headers: { 'content-type': 'text/html' } })).fetch });
    const t = buildWithWeb(rt, provider) as { web_fetch: { execute: (a: { url: string }) => Promise<string> } };
    const out = await t.web_fetch.execute({ url: 'https://example.com/big' });

    expect(out).toContain('Source: https://example.com/big');
    expect(out).toContain('[output truncated');
    expect(out).toContain(`/${TOOL_OUTPUT_DIR}/`);
    // The full output is restorable from the VFS.
    const m = /full output saved to (\/[^\s]+)/.exec(out);
    expect(m).toBeTruthy();
    const saved = await rt.storage.vfs.readFile(m![1].slice(1), { encoding: 'utf8' });
    expect(String(saved).length).toBeGreaterThan(out.length);
  });

  test('web_search error maps to a structured error object', async () => {
    const { rt } = createTestRuntime();
    const failing: WebSearchProvider = {
      search: async () => { throw new WebFetchError('rate limited', true); },
      fetch: async () => { throw new WebFetchError('x'); },
    };
    const t = buildWithWeb(rt, failing) as { web_search: { execute: (a: { query: string }) => Promise<unknown> } };
    const out = await t.web_search.execute({ query: 'x' });
    expect(out).toMatchObject({ error: 'rate limited', retriable: true });
  });

  test('codemode can call web.search() and web.fetch()', async () => {
    const { rt } = createTestRuntime();
    const provider = createDefaultWebSearchProvider({
      fetch: stubFetch((url) =>
        url.includes('duckduckgo') ? { body: DDG_HTML } : { body: '<html><body><p>page body</p></body></html>' },
      ).fetch,
    });
    const t = buildWithWeb(rt, provider) as { execute_tools: { execute: (a: { code: string }) => Promise<{ result: unknown }> } };

    const searched = await t.execute_tools.execute({
      code: 'const r = await web.search("topic", { limit: 2 }); return r.results.length;',
    });
    expect(searched.result).toBe(2);

    const fetched = await t.execute_tools.execute({
      code: 'const r = await web.fetch("https://example.com/p"); return r.markdown;',
    });
    expect(String(fetched.result)).toContain('page body');
  });
});
