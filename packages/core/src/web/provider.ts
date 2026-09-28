/** Web search/fetch provider shared by both backends; key-less by default (DuckDuckGo), Tavily when a `tavily` credential is stored. */

import * as v from 'valibot';
import { refusedResolution, assertSafeUrl, isSafeUrl, UnsafeUrlError, type HostResolver } from './url-safety';
import { decodeEntities, htmlToMarkdown as localHtmlToMarkdown, looksLikeHtml, stripBase64Images, stripTags } from './markdown';
import type { AuthResolution, AuthResolver } from '../providers/types';
import { TAVILY_CRED_KEY } from '../credentials/validate';
import { TOOL_REACH } from '../tools/registry';
import { readExecSignal } from '../execution/signal';
import { codemodeText } from '../tools/sandbox-contract';
import { diagnostics, toKinuError, tolerate } from '../obs/index';


const TAVILY_API = 'https://api.tavily.com';

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
  search(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<WebSearchResponse>;
  fetch(url: string, opts?: { signal?: AbortSignal }): Promise<WebFetchResult>;
}

export interface DefaultWebSearchProviderDeps {
  fetch: typeof fetch;
  /** Absent: search is always DuckDuckGo. */
  getAuth?: AuthResolver;
  /** Falls back to the local converter when absent or throwing. */
  htmlToMarkdown?: (html: string, opts?: { url?: string }) => Promise<string>;
  /** Absent on a Worker, whose platform refuses a name resolving inward (`url-safety.ts`). */
  resolve?: HostResolver;
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
  override readonly name = 'WebFetchError';
}

export function createDefaultWebSearchProvider(deps: DefaultWebSearchProviderDeps): WebSearchProvider {
  // Detached: workerd's fetch throws "Illegal invocation" when called as `deps.fetch`.
  const fetchImpl = deps.fetch;

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

  async function tavilyAuth(): Promise<AuthResolution | null> {
    return deps.getAuth ? await deps.getAuth(TAVILY_CRED_KEY) : null;
  }

  async function tavilySearch(
    query: string,
    limit: number,
    { headers, baseURL = TAVILY_API }: AuthResolution,
    signal: AbortSignal | undefined,
  ): Promise<WebSearchResponse> {
    const res = await fetchImpl(new URL('search', baseURL.endsWith('/') ? baseURL : `${baseURL}/`).href, {
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

    if (res.status === 429) throw new WebFetchError('Tavily rate limit (429): retry shortly');

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
      throw new WebFetchError('Tavily search returned an unreadable response', { cause: error });
    }
  }

  async function duckDuckGoSearch(query: string, limit: number, signal: AbortSignal | undefined): Promise<WebSearchResponse> {
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const res = await fetchImpl(endpoint, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; KinuAgent/1.0; +https://kinu.dev)',
        accept: 'text/html',
      },
      signal,
    });

    if (res.status === 429 || res.status === 202) {
      throw new WebFetchError('DuckDuckGo rate-limited the request: retry shortly, or connect a Tavily key for reliable search');
    }

    if (!res.ok) throw new WebFetchError(`web search failed (${res.status})`);
    const html = await res.text();
    const results = parseDuckDuckGoHtml(html, limit);

    return { query, results, source: 'duckduckgo' };
  }

  const judged = async (url: string): Promise<URL> => {
    let parsed: URL;

    try {
      parsed = assertSafeUrl(url);
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new WebFetchError(error.reason, { cause: error });
      throw error;
    }

    const refusal = deps.resolve === undefined ? null : await refusedResolution(parsed, deps.resolve);

    if (refusal !== null) throw new WebFetchError(refusal);

    return parsed;
  };

  return {
    async search(query, opts) {
      const q = query.trim();

      if (!q) throw new WebFetchError('search query is empty');
      const limit = clampLimit(opts?.limit);
      const auth = await tavilyAuth();

      if (auth) return tavilySearch(q, limit, auth, opts?.signal);

      return duckDuckGoSearch(q, limit, opts?.signal);
    },

    async fetch(url, opts) {
      const parsed = await judged(url);

      // Redirects followed manually so every Location passes the SSRF guard.
      let finalUrl = parsed.toString();
      let hop: Response;

      for (let redirects = 0; ; redirects++) {
        if (redirects > 0) await judged(finalUrl);

        hop = await fetchImpl(finalUrl, {
          headers: {
            // Markdown-for-Agents: Cloudflare-proxied zones answer with markdown.
            accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8',
            'user-agent': 'Mozilla/5.0 (compatible; KinuAgent/1.0; +https://kinu.dev)',
          },
          redirect: 'manual',
          signal: opts?.signal,
        });

        const location =
          hop.status === 301 || hop.status === 302 || hop.status === 303 || hop.status === 307 || hop.status === 308
            ? hop.headers.get('location')
            : null;

        if (!location) break;

        if (redirects >= MAX_REDIRECTS) {
          throw new WebFetchError(`too many redirects (over ${MAX_REDIRECTS}) for ${parsed.toString()}`);
        }

        let next: URL;

        try {
          next = new URL(location, finalUrl);
        } catch (error) {
          throw new WebFetchError(`redirect from ${finalUrl} names an unparseable location`, { cause: error });
        }

        finalUrl = next.toString();
      }

      if (hop.status === 429) throw new WebFetchError('fetch rate-limited (429): retry shortly');

      if (!hop.ok) throw new WebFetchError(`fetch failed (${hop.status}) for ${finalUrl}`);
      const contentType = hop.headers.get('content-type') ?? '';
      const { bytes, clipped } = await readCappedBody(hop, MAX_FETCH_BYTES);
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
  /** Up to \`limit\` ranked results (default 5, max 20). */
  search(query: string, opts?: { limit?: number }): Promise<{
    query: string;
    results: Array<{ title: string; url: string; snippet: string; date?: string; position: number }>;
    answer?: string;
    source: string;
  } | Refusal>;
  fetch(url: string): Promise<{ url: string; title?: string; retrievedAt: string; markdown: string } | Refusal>;
};
`;

export function createWebCodemodeProvider(provider: WebSearchProvider) {
  return {
    name: TOOL_REACH.web.codemode,
    types: TYPES,
    tools: {
      search: {
        planAllowed: true,
        description: 'web.search(query, { limit? }) -> { results: [{ title, url, snippet, date, position }], answer?, source }',
        execute: async (...args: unknown[]) => {
          const query = codemodeText({ value: args[0], parameter: 'web.search(query)' });
          const parsedOpts = v.safeParse(WebSearchOptionsSchema, args[1]);
          const opts = parsedOpts.success ? parsedOpts.output : undefined;

          return provider.search(query, { ...opts, signal: readExecSignal({ context: args[2] }) });
        },
      },
      fetch: {
        planAllowed: true,
        description: 'web.fetch(url) -> { url, title?, retrievedAt, markdown }',
        execute: async (...args: unknown[]) => provider.fetch(codemodeText({ value: args[0], parameter: 'web.fetch(url)' }), { signal: readExecSignal({ context: args[1] }) }),
      },
    },
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;

  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)));
}

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

