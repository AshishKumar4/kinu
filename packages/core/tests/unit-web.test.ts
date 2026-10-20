import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { tool, jsonSchema } from 'ai';
import * as v from 'valibot';
import { createTestRuntime, conversationsFor, actorJobsFor } from './helpers';
import {
  buildActorTools,
  buildBuiltinTools,
  createDefaultWebSearchProvider,
  createWebCodemodeProvider,
  successfulToolOutcome,
  withClampedToolResult,
  assertSafeUrl,
  isSafeUrl,
  UnsafeUrlError,
  stripBase64Images,
  decodeJsonValue,
  projectJsonValue,
  type CodemodeProvider,
  type CodemodeBuilder,
  type JsonValue,
  type WebSearchProvider,
  chainWebSearch,
  DEFAULT_WEB_SEARCH_CHAIN,
  type QuickActionTransport,
  SPILL_DIRS,
} from '../src/index';
import { imageCarrier } from '../src/types/tool-images';
import { callCodemodeMember } from '../src/tools/sandbox-contract';
import { KinuError } from '../src/obs/index';

const NO_BROWSER_RUN = { missing: 'this suite reaches no Browser Run' };

/** A provider these fetch cases build never searches. */
const NO_SEARCH = async (): Promise<never> => { throw new KinuError('unavailable', 'this case searches nothing'); };

function createNodeCodemodeBuilder(codemodeProviders: CodemodeProvider[] = []): CodemodeBuilder {
  return (surface) => {
    const codemode = surface.craftedTools();
    const nsBindings: Record<string, Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>>> = {};

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

/** The account's default chain on a deployment's Cloudflare Web Search API at its edge: what it was asked, and its answer. */
function searchApi(answer: () => Response = () => Response.json({
  items: [
    { url: 'https://example.com/a', title: 'First & Best', description: 'Snippet one about the topic.' },
    { url: 'https://example.org/b', title: 'Second Result', description: 'Snippet two.' },
  ],
  metadata: { query: 'the topic', requestId: 'r', latencyMs: 612 },
})) {
  const asked: Array<{ query: string; limit: number }> = [];

  const search = chainWebSearch({
    fetch: stubFetch(() => ({ status: 599, body: 'only the deployment searches here' })).fetch,
    getAuth: async () => null,
    deployment: async ({ query, limit }) => {
      asked.push({ query, limit });

      return answer();
    },
    report: () => undefined,
    chain: async () => ({ routes: DEFAULT_WEB_SEARCH_CHAIN, retries: 0 }),
  });

  return { asked, search };
}

describe('web provider — search', () => {
  test("search asks the account's search with the query trimmed and the tool's limit: 5 by default, at most 20", async () => {
    const asked: Array<{ query: string; limit: number }> = [];

    const provider = createDefaultWebSearchProvider({
      browser: NO_BROWSER_RUN, fetch: stubFetch(() => ({ body: '' })).fetch,
      search: async ({ query, limit }) => {
        asked.push({ query, limit });

        return { query, results: [], source: 'exa' };
      },
    });

    await provider.search('  the topic ');
    await provider.search('the topic', { limit: 50 });
    expect(asked).toEqual([{ query: 'the topic', limit: 5 }, { query: 'the topic', limit: 20 }]);
  });

  test('workerd this-binding regression: fetch invokes the injected fetch unbound', async () => {
    const thisSensitiveFetch = Object.assign(async function (
      this: void,
    ): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
      }

      return new Response('# Plain page\n\nFetched safely.', { headers: { 'content-type': 'text/markdown' } });
    }, { preconnect: fetch.preconnect }) satisfies typeof fetch;

    const provider = createDefaultWebSearchProvider({ browser: NO_BROWSER_RUN, search: NO_SEARCH, fetch: thisSensitiveFetch });

    const fetchResult = await provider.fetch('https://example.com/page');

    expect(fetchResult.markdown).toBe('# Plain page\n\nFetched safely.');
  });

  test('empty query is rejected', async () => {
    const asked: string[] = [];

    const provider = createDefaultWebSearchProvider({
      browser: NO_BROWSER_RUN, fetch: stubFetch(() => ({ body: '' })).fetch,
      search: async ({ query }) => {
        asked.push(query);

        return { query, results: [], source: 'exa' };
      },
    });

    await expect(provider.search('   ')).rejects.toMatchObject({ name: 'WebFetchError' });
    expect(asked).toEqual([]);
  });
});

describe('web provider — fetch', () => {
  test('HTML page is converted to markdown', async () => {
    const html = '<html><head><title>Hello</title><script>bad()</script></head><body><h1>Heading</h1><p>Para <a href="https://x.com">link</a></p></body></html>';
    const { fetch } = stubFetch(() => ({ body: html, headers: { 'content-type': 'text/html' } }));
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch });
    const res = await provider.fetch('https://example.com/page');

    expect(res.title).toBe('Hello');
    expect(res.markdown).toContain('# Heading');
    expect(res.markdown).toContain('[link](https://x.com)');
    expect(res.markdown).not.toContain('bad()');
    expect(res.url).toBe('https://example.com/page');
  });

  // core-rest review P1-5: references were decoded in sequence, so `&amp;lt;` became `<`, and a code point past Unicode
  // threw out of the whole fetch.
  test('an HTML page\'s character references are decoded once; one past Unicode decodes to nothing', async () => {
    const html = '<html><body><p>a &amp;lt;b&amp;gt; c&#1114112;d &#x1F600; e&nbsp;f</p></body></html>';
    const { fetch } = stubFetch(() => ({ body: html, headers: { 'content-type': 'text/html' } }));
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch });

    expect((await provider.fetch('https://example.com/page')).markdown).toContain('a &lt;b&gt; cd \u{1F600} e f');
  });

  test('text/markdown content passes through without HTML conversion', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: '# Already Markdown\n\nclean', headers: { 'content-type': 'text/markdown' } }));
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch });
    const res = await provider.fetch('https://example.com/md');
    expect(res.markdown).toBe('# Already Markdown\n\nclean');
    expect(res.title).toBe('Already Markdown');
    expect(new Headers(calls[0].init?.headers).get('accept')).toContain('text/markdown');
  });

  test('markdown frontmatter title is extracted', async () => {
    const body = '---\ntitle: Durable Objects\ndescription: x\n---\n\n# Heading\n\nbody';
    const { fetch } = stubFetch(() => ({ body, headers: { 'content-type': 'text/markdown' } }));
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch });
    const res = await provider.fetch('https://example.com/md');
    expect(res.title).toBe('Durable Objects');
  });

  test('htmlToMarkdown override (cf env.AI.toMarkdown) is used and base64-stripped', async () => {
    const html = '<html><body>x</body></html>';
    const { fetch } = stubFetch(() => ({ body: html }));

    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN,
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

    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN,
      fetch,
      htmlToMarkdown: async () => { throw new Error('cf AI.toMarkdown blew up'); },
    });

    const res = await provider.fetch('https://example.com/page');
    expect(res.markdown).toContain('# Heading');
    expect(res.markdown).toContain('Para');
  });

  test('http error maps to a WebFetchError', async () => {
    const { fetch } = stubFetch(() => ({ status: 404, body: 'nope' }));
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch });
    await expect(provider.fetch('https://example.com/missing')).rejects.toMatchObject({ message: expect.stringContaining('404') });
  });

  test('SECURITY: a public name that resolves to a private, loopback or metadata address is refused before connecting', async () => {
    const answers = new Map<string, readonly string[]>(Object.entries({
      'loop.example': ['127.0.0.1'],
      'meta.example': ['93.184.216.34', '169.254.169.254'],
      'mapped.example': ['::ffff:10.1.2.3'],
      'bounce.example': ['93.184.216.34'],
      'public.example': ['93.184.216.34', '2606:2800:220:1::1'],
    }));

    const { fetch, calls } = stubFetch((url): StubResponse => (url.includes('bounce.example')
      ? { status: 302, body: '', headers: { location: 'http://loop.example/next' } }
      : { body: 'ok', headers: { 'content-type': 'text/plain' } }));

    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch, resolve: async (host) => answers.get(host) ?? [] });

    for (const url of ['http://loop.example/', 'https://meta.example/latest/meta-data/', 'http://mapped.example/']) {
      await expect(provider.fetch(url)).rejects.toMatchObject({ name: 'WebFetchError' });
    }

    expect(calls).toEqual([]);
    await expect(provider.fetch('http://bounce.example/')).rejects.toMatchObject({ name: 'WebFetchError' });
    expect(calls.map((call) => call.url)).toEqual(['http://bounce.example/']);
    expect((await provider.fetch('https://public.example/')).markdown).toBe('ok');
  });

  test('SECURITY: a redirect to a private/metadata address is refused before the second hop', async () => {
    // Models the platform: redirect:'follow' chases Location itself; 'manual' returns the 302.
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

    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch: fakeFetch });
    const attempt = provider.fetch('https://example.com/start');
    await expect(attempt).rejects.toMatchObject({ name: 'WebFetchError' });
    await expect(attempt).rejects.toThrow(/169\.254\.169\.254/);
    expect(calls).toEqual(['https://example.com/start']);
  });

  test('a safe relative redirect succeeds and reports the final URL', async () => {
    const { fetch, calls } = stubFetch((url): StubResponse => {
      if (url === 'https://example.com/start') {
        return { status: 302, body: '', headers: { location: '/final' } };
      }

      return { body: '# Final page', headers: { 'content-type': 'text/markdown' } };
    });

    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch });
    const res = await provider.fetch('https://example.com/start');
    expect(res.url).toBe('https://example.com/final');
    expect(res.markdown).toBe('# Final page');
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/start', 'https://example.com/final']);
  });

  test('a redirect loop stops at the fetch-standard bound instead of hanging', async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 302, body: '', headers: { location: '/loop' } }));
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch });
    await expect(provider.fetch('https://example.com/loop')).rejects.toMatchObject({ name: 'WebFetchError' });
    expect(calls.length).toBe(21); // initial request + 20 follows
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

    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch: bigFetch });
    await provider.fetch('https://example.com/big');

    expect(pulls).toBeLessThan(totalChunks);
  });

  test('a fetch without a caller signal carries no abort signal, so no timer can end it', async () => {
    // A default timeout would arm on every request, and its refusal reads as a failed origin.
    const { fetch, calls } = stubFetch(() => ({ body: '<html><body><p>slow but fine</p></body></html>' }));
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch });
    const res = await provider.fetch('https://example.com/page');
    expect(res.markdown).toContain('slow but fine');
    expect(calls[0].init?.signal).toBeUndefined();
  });

  test('a short bare data URI keeps its trailing prose', () => {
    const short = 'data:image/png;base64,AAAA trailing prose after short uri stays visible';
    expect(stripBase64Images(short)).toContain('trailing prose after short uri stays visible');
    const long = `data:image/png;base64,${'A'.repeat(100)} tail prose stays`;
    const stripped = stripBase64Images(long);
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

  test('blocks URLs carrying an embedded secret', () => {
    expect(() => assertSafeUrl('https://evil.com/?leak=sk-abcdefghijklmnop')).toThrow(UnsafeUrlError);
  });

  test('every credential shape the secret policy names is refused in a URL, as written or percent-encoded', () => {
    // Assembled at runtime: a contiguous real-shaped literal trips the secret scan and push protection.
    const credentials = ['github' + '_pat_' + 'g'.repeat(40), 'np' + 'm_' + 'n'.repeat(36), 'cfut' + '_' + 'c'.repeat(48)];

    for (const credential of credentials) {
      expect(isSafeUrl(`https://example.com/search?q=${credential}`)).toBe(false);
      expect(isSafeUrl(`https://example.com/search?q=${encodeURIComponent(credential).replaceAll('_', '%5F')}`)).toBe(false);
    }

    expect(isSafeUrl('https://example.com/search?q=npm_install_guide')).toBe(true);
  });

  // A string-prefix host check let every mapped IPv6 spelling of a refused IPv4 address through.
  test('SECURITY: an IPv4-mapped IPv6 literal is judged by its embedded address', () => {
    expect(isSafeUrl('http://[::ffff:10.0.0.1]/')).toBe(false);
    expect(isSafeUrl('http://[::ffff:169.254.169.254]/latest/meta-data')).toBe(false);
    expect(isSafeUrl('http://[::ffff:192.168.1.1]/')).toBe(false);
    expect(isSafeUrl('http://[::ffff:172.16.0.1]/')).toBe(false);
    expect(isSafeUrl('http://[::10.0.0.1]/')).toBe(false);
    expect(isSafeUrl('http://[::ffff:93.184.216.34]/')).toBe(true);
  });

  test('the web guard refuses every family the destination classifier does', () => {
    expect(isSafeUrl('http://[::1]/')).toBe(false);
    expect(isSafeUrl('http://[fd00::1]/')).toBe(false);
    expect(isSafeUrl('http://[fe80::1]/')).toBe(false);
    expect(isSafeUrl('http://metadata/')).toBe(false);
    expect(isSafeUrl('http://100.64.0.1/')).toBe(false);
    expect(isSafeUrl('http://0.0.0.0/')).toBe(false);
    expect(isSafeUrl('http://api.service.localhost/')).toBe(false);
    expect(isSafeUrl('http://svc.internal/')).toBe(false);
    expect(isSafeUrl('http://[not-an-address]/')).toBe(false);
  });

  const refusedUrls = [
    { name: 'provider.fetch refuses the mapped form too — nothing leaves the runtime', url: 'http://[::ffff:169.254.169.254]/' },
    { name: 'provider.fetch refuses an unsafe URL', url: 'http://169.254.169.254/' },
  ];

  for (const c of refusedUrls) {
    test(c.name, async () => {
      const { fetch, calls } = stubFetch(() => ({ body: 'x' }));
      const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch });
      await expect(provider.fetch(c.url)).rejects.toMatchObject({ name: 'WebFetchError' });
      expect(calls.length).toBe(0);
    });
  }
});

type WebArgs = { op: 'search' | 'fetch'; query?: string; url?: string; limit?: number };

function buildWithWeb(rt: ReturnType<typeof createTestRuntime>['rt'], webSearch?: WebSearchProvider) {
  const provider = webSearch ?? createDefaultWebSearchProvider({ browser: NO_BROWSER_RUN, fetch: stubFetch(() => ({ body: '' })).fetch, search: searchApi().search });

  return buildActorTools({
    rt,
    conversations: conversationsFor(rt),
    codemode: createNodeCodemodeBuilder([createWebCodemodeProvider({ provider, files: rt.storage })]),
    effectClaims: { sql: rt.storage.sql, actor: rt.actor, execution: () => ({ turnId: 'turn-1', runId: 'run-1' }), durable: () => Promise.resolve() },
    webSearch: provider,
    jobs: actorJobsFor(rt),
  }).turn;
}

describe('web builtin', () => {
  test('gated on the webSearch dep', () => {
    const { rt } = createTestRuntime();
    const without = buildBuiltinTools({ rt, conversations: conversationsFor(rt) });
    expect(Object.keys(without)).not.toContain('web');

    const withWeb = buildWithWeb(rt);
    expect(Object.keys(withWeb)).toContain('web');
  });

  test('action=search returns ranked, model-ready text', async () => {
    const { rt } = createTestRuntime();
    const execute = toolExecute<WebArgs, string>(buildWithWeb(rt).web);
    const out = await execute({ op: 'search', query: 'the topic' });
    expect(out).toContain('First & Best');
    expect(out).toContain('https://example.com/a');
  });

  test('a call missing the argument its action needs says which', async () => {
    const { rt } = createTestRuntime();
    const execute = toolExecute<WebArgs, JsonValue>(buildWithWeb(rt).web);
    await expect(execute({ op: 'search' })).rejects.toMatchObject({ code: 'bad_input' });
    await expect(execute({ op: 'fetch' })).rejects.toMatchObject({ code: 'bad_input' });
  });

  test('action=fetch clamps a big page to a head with a VFS restore path, header included in the budget', async () => {
    const { rt } = createTestRuntime();
    const big = '<html><body>' + 'word '.repeat(20000) + '</body></html>';
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch: stubFetch(() => ({ body: big, headers: { 'content-type': 'text/html' } })).fetch });
    const execute = toolExecute<WebArgs, string>(buildWithWeb(rt, provider).web);
    const out = await execute({ op: 'fetch', url: 'https://example.com/big' });

    expect(out).toContain('Source: https://example.com/big');
    expect(out).toContain('[truncated;');
    expect(out).toContain(`${SPILL_DIRS.toolOutput}/`);
    expect(out.length).toBeLessThanOrEqual(8_000);

    const savedPath = /full result at (\S+)\]/.exec(out)?.[1];
    expect(savedPath).toContain(SPILL_DIRS.toolOutput);

    if (savedPath === undefined) throw new Error(`Expected a saved-output path in: ${out}`);
    const saved = await readText(rt.storage.vfs, savedPath);
    expect(String(saved).length).toBeGreaterThan(out.length);
  });

  test('a page whose own header material is huge cannot buy room outside the budget', async () => {
    const { rt } = createTestRuntime();
    const title = 'T'.repeat(30_000);
    const body = `<html><head><title>${title}</title></head><body>${'word '.repeat(5_000)}</body></html>`;
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch: stubFetch(() => ({ body, headers: { 'content-type': 'text/html' } })).fetch });
    const execute = toolExecute<WebArgs, string>(buildWithWeb(rt, provider).web);
    const out = await execute({ op: 'fetch', url: `https://example.com/${'u'.repeat(5_000)}` });

    expect(out.length).toBeLessThanOrEqual(8_000);
    expect(out).toContain('[truncated;');
    const savedPath = /full result at (\S+)\]/.exec(out)?.[1];

    if (savedPath === undefined) throw new Error(`Expected a saved-output path in: ${out.slice(-300)}`);
    const saved = String(await readText(rt.storage.vfs, savedPath));
    expect(saved.length).toBeGreaterThan(out.length);
  });

  test('an empty page still returns its provenance header, unclamped', async () => {
    const { rt } = createTestRuntime();
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, browser: NO_BROWSER_RUN, fetch: stubFetch(() => ({ body: '', headers: { 'content-type': 'text/html' } })).fetch });
    const execute = toolExecute<WebArgs, string>(buildWithWeb(rt, provider).web);
    const out = await execute({ op: 'fetch', url: 'https://example.com/empty' });

    expect(out).toContain('Source: https://example.com/empty');
    expect(out).not.toContain('[truncated;');
    expect(out.length).toBeLessThanOrEqual(8_000);
  });

  test('a provider error preserves its message and retry metadata on the error channel', async () => {
    const { rt } = createTestRuntime();

    const failing = createDefaultWebSearchProvider({
      browser: NO_BROWSER_RUN, fetch: stubFetch(() => ({ status: 404, body: 'upstream refused' })).fetch,
      search: searchApi(() => Response.json({ error: { code: 'web_search_payment_required' } }, { status: 402 })).search,
    });

    const execute = toolExecute<WebArgs, JsonValue>(buildWithWeb(rt, failing).web);
    await expect(execute({ op: 'search', query: 'x' })).rejects.toMatchObject({ message: expect.stringContaining('Cloudflare answered 402') });
    await expect(execute({ op: 'fetch', url: 'https://example.com' })).rejects.toMatchObject({ message: expect.stringContaining('404') });
  });

  test('codemode can call web.search() and web.fetch()', async () => {
    const { rt } = createTestRuntime();

    const provider = createDefaultWebSearchProvider({ browser: NO_BROWSER_RUN,
      fetch: stubFetch(() => ({ body: '<html><body><p>page body</p></body></html>' })).fetch,
      search: searchApi().search,
    });

    const execute = toolExecute<{ code: string }, { result: JsonValue | undefined }>(
      buildWithWeb(rt, provider).eval,
    );

    const searched = await execute({
      code: 'const r = await web.search("topic", { limit: 2 }); return r.results.length;',
    });

    expect(searched.result).toBe(2);

    const fetched = await execute({
      code: 'const r = await web.fetch("https://example.com/p"); return r.markdown;',
    });

    expect(v.parse(v.string(), fetched.result)).toContain('page body');
  });

  test('a codemode call with a number for its text is refused by parameter and type', async () => {
    const { rt } = createTestRuntime();
    const execute = toolExecute<{ code: string }, { result: JsonValue | undefined }>(buildWithWeb(rt).eval);

    const refused = await execute({ code: 'const r = await web.search(42); return r.error;' });

    // Refused by its own schema, naming the field.
    expect(v.parse(v.string(), refused.result)).toContain('"query"');
  });
});

/** Browser Run as a recording stub: each call's action, engine and options, answered by `answer`. */
function stubBrowserRun(answer: (action: string) => Response) {
  const calls: Array<{ action: string; engine: string; options: JsonValue }> = [];

  const quickActions: QuickActionTransport = async (action, options, engine) => {
    calls.push({ action, engine, options });

    return answer(action);
  };

  return { calls, browser: { quickActions } };
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const SHELL = '<html><head><title>shell</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

function rendered(html: string, status = 200): Response {
  return Response.json({ success: true, result: html, meta: { status, title: 'Rendered by JavaScript' } });
}

type BrowserArgs = { op: string } & Record<string, JsonValue>;

function webWithBrowser(answer: (action: string) => Response) {
  const { rt } = createTestRuntime();
  const run = stubBrowserRun(answer);
  const plain = stubFetch(() => ({ body: SHELL }));
  const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, fetch: plain.fetch, browser: run.browser });
  const web = buildWithWeb(rt, provider).web;

  return { rt, run, plain, web, execute: toolExecute<BrowserArgs, JsonValue>(web) };
}

describe('web through Browser Run', () => {
  test('fetch renders only when asked: plain reads the shell, render: true the page its script built, on Kitesurf', async () => {
    const { run, plain, execute } = webWithBrowser(() => rendered('<html><body><h1>Rendered by JavaScript</h1><p>alpha</p></body></html>'));

    const shell = v.parse(v.string(), await execute({ op: 'fetch', url: 'https://spa.example/' }));
    const page = v.parse(v.string(), await execute({ op: 'fetch', url: 'https://spa.example/', render: true }));

    expect(shell).not.toContain('Rendered by JavaScript');
    expect(page).toContain('# Rendered by JavaScript');
    expect(page).toContain('alpha');
    expect(plain.calls.map((call) => call.url)).toEqual(['https://spa.example/']);
    expect(run.calls.map(({ action, engine }) => `${action} ${engine}`)).toEqual(['content kitesurf']);
  });

  test('the engine is the call\'s choice, and a site refusing Kitesurf is named in plain words', async () => {
    const { run, execute } = webWithBrowser(() => rendered('<p>Rate limit exceeded</p>', 429));

    await expect(execute({ op: 'fetch', url: 'https://hub.example/', render: true }))
      .rejects.toMatchObject({ message: expect.stringContaining('the site answered 429 to Kitesurf') });
    await expect(execute({ op: 'fetch', url: 'https://hub.example/', render: true, engine: 'chrome' }))
      .rejects.toMatchObject({ message: expect.stringContaining('the site answered 429 to Chrome') });
    await expect(execute({ op: 'fetch', url: 'https://hub.example/', engine: 'chrome' }))
      .rejects.toMatchObject({ message: expect.stringContaining('`engine` applies to a rendered fetch') });
    expect(run.calls.map(({ engine }) => engine)).toEqual(['kitesurf', 'chrome']);
  });

  test('a screenshot is saved to the workspace and handed to the model as an image', async () => {
    const { rt, web, execute } = webWithBrowser(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));

    const output = await execute({ op: 'screenshot', url: 'https://example.com/' });
    const shot = v.parse(v.object({ output: v.object({ path: v.string(), dataUrl: v.literal('[image 1]') }) }), output).output;

    expect(await rt.storage.vfs.readFile(shot.path)).toEqual(PNG);
    expect(await web.toModelOutput?.({ toolCallId: 'c1', input: { op: 'screenshot', url: 'https://example.com/' }, output })).toEqual({
      type: 'content',
      value: [{ type: 'text', text: expect.stringContaining(shot.path) }, { type: 'file', data: { type: 'data', data: 'iVBORw0KGgo=' }, mediaType: 'image/png' }],
    });
  });

  test('a whole-page screenshot is saved but reaches the model as its path only', async () => {
    const { web, execute } = webWithBrowser(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const output = await execute({ op: 'screenshot', url: 'https://example.com/', fullPage: true });

    expect(output).toEqual({ url: 'https://example.com/', retrievedAt: expect.any(String), path: expect.stringMatching(/^\/home\/main\/screenshots\//u) });
    expect(await web.toModelOutput?.({ toolCallId: 'c1', input: {}, output })).toMatchObject({ type: 'json' });
  });

  test('private and internal addresses are refused before Browser Run is asked', async () => {
    const { run, execute } = webWithBrowser(() => new Response(PNG));

    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://localhost:8080/']) {
      await expect(execute({ op: 'screenshot', url })).rejects.toMatchObject({ code: 'denied' });
      await expect(execute({ op: 'fetch', url, render: true })).rejects.toMatchObject({ code: 'denied' });
    }

    expect(run.calls).toEqual([]);
  });

  test('a field the called operation does not take is refused, naming the fields it does', async () => {
    const { run, execute } = webWithBrowser(() => new Response(PNG));

    await expect(execute({ op: 'screenshot', url: 'https://example.com/', render: true }))
      .rejects.toMatchObject({ code: 'bad_input' });
    await expect(execute({ op: 'fetch', url: 'https://example.com/', rendr: true }))
      .rejects.toMatchObject({ code: 'bad_input' });
    expect(run.calls).toEqual([]);
  });

  test('where Browser Run is unreachable, rendering and screenshots refuse naming what is missing', async () => {
    const { rt } = createTestRuntime();
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, fetch: stubFetch(() => ({ body: SHELL })).fetch, browser: { missing: 'Browser Run needs CLOUDFLARE_API_TOKEN' } });
    const execute = toolExecute<BrowserArgs, JsonValue>(buildWithWeb(rt, provider).web);

    await expect(execute({ op: 'screenshot', url: 'https://example.com/' })).rejects.toMatchObject({ code: 'unavailable', message: 'Browser Run needs CLOUDFLARE_API_TOKEN' });
    await expect(execute({ op: 'fetch', url: 'https://example.com/', render: true })).rejects.toMatchObject({ message: 'Browser Run needs CLOUDFLARE_API_TOKEN' });
    expect(v.parse(v.string(), await execute({ op: 'fetch', url: 'https://example.com/' }))).toContain('Source: https://example.com/');
  });

  test('an eval program that returns an image data URL shows the model the image, outside the text clamp', async () => {
    const { rt } = createTestRuntime();
    const tools = buildWithWeb(rt);
    const execute = toolExecute<{ code: string }, JsonValue>(tools.eval);
    const output = await execute({ code: 'return { page: "done", shot: "data:image/png;base64,iVBORw0KGgo=" };' });
    const model = await tools.eval.toModelOutput?.({ toolCallId: 'c1', input: { code: '' }, output });

    expect(model).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: expect.any(String) },
        { type: 'file', data: { type: 'data', data: 'iVBORw0KGgo=' }, mediaType: 'image/png' },
      ],
    });
  });
});

describe('an eval that returns an image', () => {
  test('keeps the failures its program recorded where the turn reads them', async () => {
    const failure = { success: false as const, tool: 'web', op: 'fetch', reason: 'denied' as const, error: 'blocked private/internal address: 10.0.0.1' };
    const program = { result: { shot: 'data:image/png;base64,iVBORw0KGgo=' }, logs: [], failures: [failure] };
    const evalTool = withClampedToolResult(tool({ inputSchema: jsonSchema<{ code: string }>({ type: 'object' }), execute: async () => program }), { producer: 'eval', images: true });
    const output = await toolExecute<{ code: string }, JsonValue>(evalTool)({ code: '' });

    expect(successfulToolOutcome('eval', { output })).toEqual({ success: true, failures: [failure] });
    expect(await evalTool.toModelOutput?.({ toolCallId: 'c1', input: { code: '' }, output })).toMatchObject({
      type: 'content', value: [{ type: 'text' }, { type: 'file', data: { type: 'data', data: 'iVBORw0KGgo=' } }],
    });
  });
});

describe('an eval that returns a native tool\'s image', () => {
  test('shows the model the image a nested screenshot carried, not its base64 as text, and keeps the failures', async () => {
    const failure = { success: false as const, tool: 'web', op: 'fetch', reason: 'denied' as const, error: 'blocked private/internal address: 10.0.0.1' };
    // `return await tools.web({ op: 'screenshot', … })`: the native tool's carrier, nested under the program's result.
    const shot = imageCarrier('Screenshot of https://example.com/', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    const program = { result: { shot }, logs: [], failures: [failure] };
    const evalTool = withClampedToolResult(tool({ inputSchema: jsonSchema<{ code: string }>({ type: 'object' }), execute: async () => program }), { producer: 'eval', images: true });
    const output = await toolExecute<{ code: string }, JsonValue>(evalTool)({ code: '' });
    const model = await evalTool.toModelOutput?.({ toolCallId: 'c1', input: { code: '' }, output });

    expect(successfulToolOutcome('eval', { output })).toEqual({ success: true, failures: [failure] });
    expect(model).toMatchObject({
      type: 'content',
      value: [{ type: 'text', text: expect.stringContaining('Screenshot of https://example.com/') }, { type: 'file', data: { type: 'data', data: 'iVBORw0KGgo=' }, mediaType: 'image/png' }],
    });
  });

  test("keeps every field of the program's own data that names `output` and `images`, beside a screenshot", async () => {
    const row = { output: 'ok', images: [], id: 'row-1', status: 'failed' };
    const shot = imageCarrier('Screenshot of https://example.com/', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    const evalTool = withClampedToolResult(tool({ inputSchema: jsonSchema<{ code: string }>({ type: 'object' }), execute: async () => ({ result: { row, shot }, logs: [] }) }), { producer: 'eval', images: true });
    const output = await toolExecute<{ code: string }, JsonValue>(evalTool)({ code: '' });

    expect(output).toMatchObject({ output: { result: { row, shot: 'Screenshot of https://example.com/' } } });
  });
});

describe('web on a shared slate', () => {
  /** Every path under the workspace home, as the tree a visitor must leave alone. */
  async function tree(vfs: ReturnType<typeof createTestRuntime>['rt']['storage']['vfs'], dir = '.'): Promise<string[]> {
    const paths: string[] = [];

    for (const entry of await vfs.readdir(dir)) {
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      paths.push(path);

      if ((await vfs.stat(path))?.type === 'directory') paths.push(...await tree(vfs, path));
    }

    return paths;
  }

  test("a slate's screenshot and long rendered page come back to the slate and write nothing", async () => {
    const { rt } = createTestRuntime();
    const page = `<html><body><p>${'a'.repeat(2_100_000)}</p></body></html>`;
    const pageBytes = new TextEncoder().encode(page).length;
    const run = stubBrowserRun((action) => (action === 'screenshot' ? new Response(PNG) : rendered(page)));
    const provider = createDefaultWebSearchProvider({ search: NO_SEARCH, fetch: stubFetch(() => ({ body: SHELL })).fetch, browser: run.browser });
    // A slate's web writes nothing into the workspace.
    const slateWeb = createWebCodemodeProvider({ provider, files: null });
    const before = await tree(rt.storage.vfs);

    const shot = await callCodemodeMember([slateWeb], 'web', 'screenshot', ['https://example.com/']);
    const fetched = await callCodemodeMember([slateWeb], 'web', 'fetch', ['https://example.com/', { render: true }]);

    expect(shot).toEqual({ url: 'https://example.com/', retrievedAt: expect.any(String), dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(v.parse(v.object({ markdown: v.string() }), fetched).markdown.length).toBeLessThan(pageBytes);
    expect(await tree(rt.storage.vfs)).toEqual(before);

    // The same call from an agent's eval saves the picture, so the tree above is the slate route's doing.
    const evalWeb = createWebCodemodeProvider({ provider, files: rt.storage });
    const saved = await callCodemodeMember([evalWeb], 'web', 'screenshot', ['https://example.com/']);

    expect(saved).toMatchObject({ path: expect.stringMatching(/^\/home\/main\/screenshots\/example\.com-/u) });
    expect(await tree(rt.storage.vfs)).not.toEqual(before);
  });
});
