/** Web search/fetch provider shared by both backends; key-less by default (DuckDuckGo), Tavily when a `tavily` credential is stored. */

import * as v from 'valibot';
import { assertSafeUrl, isSafeUrl, UnsafeUrlError } from './url-safety';
import { decodeEntities, htmlToMarkdown as localHtmlToMarkdown, looksLikeHtml, stripBase64Images, stripTags } from './markdown';
import type { AuthResolver } from '../providers/types';
import { TOOL_REACH } from '../tools/registry';
import { readExecSignal } from '../execution/signal';
import { codemodeText } from '../tools/sandbox-contract';
import { diagnostics, toKinuError, tolerate } from '../obs/index';
import { REAL_CLOCK, type Clock } from '../types/clock';

const TAVILY_CRED_KEY = 'tavily';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO or relative date, when the backend reports one. */
  date?: string;
  /** 1-based. */
  position: number;
}

export interface WebSearchResponse {
  query: string;
  /** Tavily only. */
  answer?: string;
  results: WebSearchResult[];
  source: 'tavily' | 'duckduckgo';
}

export interface WebFetchResult {
  url: string;
  title?: string;
  retrievedAt: string;
  /** Base64 images already stripped. */
  markdown: string;
}

export interface WebSearchProvider {
  /** Without `timeoutMs`, `signal` is the only thing that ends a request early. */
  search(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<WebSearchResponse>;
  fetch(url: string, opts?: { signal?: AbortSignal }): Promise<WebFetchResult>;
}

export interface DefaultWebSearchProviderDeps {
  fetch: typeof fetch;
  /** Absent: search is always DuckDuckGo. */
  getAuth?: AuthResolver;
  /** Falls back to the local converter when absent or throwing. */
  htmlToMarkdown?: (html: string, opts?: { url?: string }) => Promise<string>;
  /** Per-request budget in ms; absent means no local timeout. */
  timeoutMs?: number;
  clock?: Clock;
}

const DEFAULT_SEARCH_LIMIT = 5;

const MAX_SEARCH_LIMIT = 20;

const TavilyResponseSchema = v.object({
  answer: v.optional(v.string()),
  results: v.optional(v.array(v.object({
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    content: v.optional(v.string()),
    published_date: v.optional(v.string()),
  }))),
});

const WebSearchOptionsSchema = v.object({ limit: v.optional(v.number()) });

const MAX_FETCH_BYTES = 2_000_000;

/** WHATWG Fetch's redirect bound (https://fetch.spec.whatwg.org/#http-redirect-fetch). */
const MAX_REDIRECTS = 20;

class WebFetchError extends Error {
  constructor(message: string, public readonly retriable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebFetchError';
  }
}

export function createDefaultWebSearchProvider(deps: DefaultWebSearchProviderDeps): WebSearchProvider {
  const budgetMs = deps.timeoutMs;
  const clock = deps.clock ?? REAL_CLOCK;
  // Detached: workerd's fetch throws "Illegal invocation" when called as `deps.fetch`.
  const fetchImpl = deps.fetch;

  const withRequestBudget = async <T>(
    caller: AbortSignal | undefined,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (budgetMs === undefined) return run(caller);
    const ctrl = new AbortController();
    caller?.addEventListener('abort', () => ctrl.abort(caller.reason), { once: true });
    const cancelBudget = clock.after(budgetMs, () => { ctrl.abort(); });

    const onAbort = new Promise<never>((_, reject) => {
      ctrl.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
    });

    try {
      return await Promise.race([run(ctrl.signal), onAbort]);
    } catch (error) {
      if (caller?.aborted === true) throw error;

      if (ctrl.signal.aborted) {
        throw new WebFetchError(`request timed out after ${String(budgetMs)}ms`, true, { cause: error });
      }

      throw error;
    } finally {
      cancelBudget();
    }
  };

  const convert = async (html: string, url: string): Promise<string> => {
    if (!deps.htmlToMarkdown) return localHtmlToMarkdown(html);

    try {
      return stripBase64Images(await deps.htmlToMarkdown(html, { url }));
    } catch (error) {
      diagnostics.failure(
        'web.convert_failed',
        toKinuError({ doing: 'convert fetched HTML to markdown', cause: error, otherwise: 'io' }),
      );

      return localHtmlToMarkdown(html);
    }
  };

  async function tavilyKey(): Promise<Record<string, string> | null> {
    if (!deps.getAuth) return null;
    const auth = await deps.getAuth(TAVILY_CRED_KEY);

    return auth?.headers ?? null;
  }

  async function tavilySearch(
    query: string,
    limit: number,
    headers: Record<string, string>,
    caller: AbortSignal | undefined,
  ): Promise<WebSearchResponse> {
    return withRequestBudget(caller, async (signal) => {
      const res = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          query,
          max_results: limit,
          include_answer: true,
          search_depth: 'basic',
        }),
        signal,
      });

      if (res.status === 429) throw new WebFetchError('Tavily rate limit (429) — retry shortly', true);

      if (!res.ok) {
        const body = await res.text();
        throw new WebFetchError(`Tavily search failed (${res.status}): ${body.slice(0, 200)}`);
      }

      try {
        const json = v.parse(TavilyResponseSchema, await res.json());

        const safe = (json.results ?? []).flatMap((r) => {
          const url = r.url;

          return url !== undefined && isSafeUrl(url) ? [{ ...r, url }] : [];
        });

        const results: WebSearchResult[] = safe
          .slice(0, limit)
          .map((r, i) => {
            const title = r.title?.trim();

            return {
              title: title === undefined || title === '' ? r.url : title,
              url: r.url,
              snippet: stripBase64Images((r.content ?? '').trim()).slice(0, 600),
              date: r.published_date === '' ? undefined : r.published_date,
              position: i + 1,
            };
          });

        const answer = json.answer?.trim();

        return { query, answer: answer === '' ? undefined : answer, results, source: 'tavily' };
      } catch (error) {
        if (signal?.aborted === true) throw error;
        throw new WebFetchError('Tavily search returned an unreadable response', false, { cause: error });
      }
    });
  }

  async function duckDuckGoSearch(query: string, limit: number, caller: AbortSignal | undefined): Promise<WebSearchResponse> {
    return withRequestBudget(caller, async (signal) => {
      const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

      const res = await fetchImpl(endpoint, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; KinuAgent/1.0; +https://kinu.dev)',
          accept: 'text/html',
        },
        signal,
      });

      if (res.status === 429 || res.status === 202) {
        throw new WebFetchError('DuckDuckGo rate-limited the request — retry shortly, or connect a Tavily key for reliable search', true);
      }

      if (!res.ok) throw new WebFetchError(`web search failed (${res.status})`);
      const html = await res.text();
      const results = parseDuckDuckGoHtml(html, limit);

      return { query, results, source: 'duckduckgo' };
    });
  }

  return {
    async search(query, opts) {
      const q = (query ?? '').trim();

      if (!q) throw new WebFetchError('search query is empty');
      const limit = clampLimit(opts?.limit);
      const headers = await tavilyKey();

      if (headers) return tavilySearch(q, limit, headers, opts?.signal);

      return duckDuckGoSearch(q, limit, opts?.signal);
    },

    async fetch(url, opts) {
      let parsed: URL;

      try {
        parsed = assertSafeUrl(url);
      } catch (error) {
        if (error instanceof UnsafeUrlError) throw new WebFetchError(error.reason, false, { cause: error });
        throw error;
      }

      // Redirects followed manually so every Location passes the SSRF guard.
      let finalUrl = parsed.toString();

      const fetched = await withRequestBudget(opts?.signal, async (signal) => {
        let target = finalUrl;

        for (let redirects = 0; ; redirects++) {
          const hop = await fetchImpl(target, {
            headers: {
              // Markdown-for-Agents: Cloudflare-proxied zones answer with markdown.
              accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8',
              'user-agent': 'Mozilla/5.0 (compatible; KinuAgent/1.0; +https://kinu.dev)',
            },
            redirect: 'manual',
            signal,
          });

          const location =
            hop.status === 301 || hop.status === 302 || hop.status === 303 || hop.status === 307 || hop.status === 308
              ? hop.headers.get('location')
              : null;

          if (!location) {
            finalUrl = target;

            if (hop.status === 429) throw new WebFetchError('fetch rate-limited (429) — retry shortly', true);

            if (!hop.ok) throw new WebFetchError(`fetch failed (${hop.status}) for ${finalUrl}`);
            const contentType = hop.headers.get('content-type') ?? '';
            const { bytes, clipped } = await readCappedBody(hop, MAX_FETCH_BYTES);

            return { contentType, bytes, clipped };
          }

          if (redirects >= MAX_REDIRECTS) {
            throw new WebFetchError(`too many redirects (over ${MAX_REDIRECTS}) for ${parsed.toString()}`);
          }

          let next: URL;

          try {
            next = new URL(location, target);
          } catch (error) {
            throw new WebFetchError(`redirect from ${target} names an unparseable location`, false, { cause: error });
          }

          try {
            assertSafeUrl(next.toString());
          } catch (error) {
            if (error instanceof UnsafeUrlError) throw new WebFetchError(error.reason, false, { cause: error });
            throw error;
          }

          target = next.toString();
        }
      });

      const { contentType, bytes, clipped } = fetched;
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

      const markdown = looksLikeHtml(raw, contentType)
        ? await convert(raw, finalUrl)
        : stripBase64Images(raw);

      const note = clipped
        ? `\n\n[fetch truncated: kept the first ${MAX_FETCH_BYTES} of more than ${MAX_FETCH_BYTES} bytes]`
        : '';

      return {
        url: finalUrl,
        title: extractTitle(raw) || extractMarkdownTitle(markdown) || undefined,
        retrievedAt: new Date().toISOString(),
        markdown: markdown.trim() + note,
      };
    },
  };
}

/** Streams at most `cap` bytes; the total past the cap is never measured. */
async function readCappedBody(res: Response, cap: number): Promise<{ bytes: Uint8Array; clipped: boolean }> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    const clipped = buf.byteLength > cap;

    return { bytes: new Uint8Array(clipped ? buf.slice(0, cap) : buf), clipped };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let clipped = false;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    if (kept + value.byteLength > cap) {
      const room = cap - kept;

      if (room > 0) {
        chunks.push(value.slice(0, room));
        kept = cap;
      }

      clipped = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    kept += value.byteLength;
  }

  const bytes = new Uint8Array(kept);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { bytes, clipped };
}

/** Explicit because members take positional args; a generated declaration would suggest `web.search({ query })`. */
const TYPES = `export declare const web: {
  /** Search the live web. Returns up to \`limit\` ranked results (default 5,
   *  max 20), each with title, url, snippet and position — plus a freshness
   *  date when the source has one, and a synthesized answer when a Tavily key
   *  is connected. */
  search(query: string, opts?: { limit?: number }): Promise<{
    query: string;
    results: Array<{ title: string; url: string; snippet: string; date?: string; position: number }>;
    answer?: string;
    source: string;
  }>;
  /** Fetch one absolute http(s) URL as clean markdown. */
  fetch(url: string): Promise<{ url: string; title?: string; retrievedAt: string; markdown: string }>;
};
`;

export function createWebCodemodeProvider(provider: WebSearchProvider) {
  return {
    name: TOOL_REACH.web.codemode,
    types: TYPES,
    tools: {
      search: {
        planAllowed: true,
        description: 'web.search(query, { limit? }) → { results: [{ title, url, snippet, date, position }], answer?, source }',
        execute: async (...args: unknown[]) => {
          const query = codemodeText({ value: args[0], parameter: 'web.search(query)' });
          const parsedOpts = v.safeParse(WebSearchOptionsSchema, args[1]);
          const opts = parsedOpts.success ? parsedOpts.output : undefined;

          return provider.search(query, { ...opts, signal: readExecSignal({ context: args[2] }) });
        },
      },
      fetch: {
        planAllowed: true,
        description: 'web.fetch(url) → { url, title?, retrievedAt, markdown }',
        execute: async (...args: unknown[]) => provider.fetch(codemodeText({ value: args[0], parameter: 'web.fetch(url)' }), { signal: readExecSignal({ context: args[1] }) }),
      },
    },
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;

  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)));
}

/** Parses `result__a` / `result__snippet` anchors from DuckDuckGo's HTML endpoint. */
function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;

  while ((sm = snippetRe.exec(html)) !== null) snippets.push(decodeEntities(stripTags(sm[1])));

  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = linkRe.exec(html)) !== null && results.length < limit) {
    const url = unwrapDuckUrl(decodeEntities(m[1]));
    const title = decodeEntities(stripTags(m[2])).trim();

    if (!url || !title || !isSafeUrl(url)) {
      i++;
      continue;
    }

    results.push({
      title,
      url,
      snippet: (snippets[i] ?? '').trim(),
      position: results.length + 1,
    });
    i++;
  }

  return results;
}

/** DuckDuckGo wraps targets in `//duckduckgo.com/l/?uddg=<encoded>&...`. */
function unwrapDuckUrl(href: string): string {
  const abs = href.startsWith('//') ? `https:${href}` : href;
  const parsed = tolerate(() => new URL(abs, 'https://duckduckgo.com'), 'malformed-input');

  if (!parsed) return '';
  const uddg = parsed.searchParams.get('uddg');

  if (uddg) return uddg;

  return /^https?:/.test(abs) ? abs : '';
}

function extractTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  return m ? decodeEntities(stripTags(m[1])).trim().slice(0, 300) : '';
}

/** Frontmatter `title:`, else the first `# heading`. */
function extractMarkdownTitle(md: string): string {
  const fm = /^---\s*[\s\S]*?\btitle:\s*["']?([^"'\n]+)["']?\s*[\s\S]*?\n---/m.exec(md);

  if (fm) return fm[1].trim().slice(0, 300);
  const h1 = /^#\s+(.+)$/m.exec(md);

  return h1 ? h1[1].trim().slice(0, 300) : '';
}

