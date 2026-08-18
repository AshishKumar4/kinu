/**
 * The web-search/fetch provider seam — one interface, two thin backend
 * adapters (cf-backend Worker fetch, cli-backend node fetch).
 *
 * Design (reconciling both research reports):
 *   - ONE model-facing tool, `web`, with a search action and a fetch action:
 *     discovery and retrieval are distinct operations but a single capability,
 *     always used as a pair. The tool lives in tools/builtins.ts; this module
 *     owns the network behaviour behind it.
 *   - KEY-LESS out of the box: search degrades to a DuckDuckGo HTML scrape and
 *     fetch uses plain `fetch` (Markdown-for-Agents `Accept: text/markdown`,
 *     falling back to local HTML→markdown). No credential is required for the
 *     agent to research the web on either backend.
 *   - KEYED upgrade: when a `tavily` credential is stored, search routes
 *     through Tavily for ranked, relevance-filtered, agent-tuned results. The
 *     credential is resolved through the same auth seam every model provider
 *     uses (`getAuth`), so no new credential plumbing is invented.
 *
 * Backends supply only what differs: the `fetch` implementation, the auth
 * resolver, and (cf-only) an `htmlToMarkdown` override that calls
 * `env.AI.toMarkdown`. Everything else is shared here.
 */

import * as v from 'valibot';
import { assertSafeUrl, isSafeUrl, UnsafeUrlError } from './url-safety';
import { htmlToMarkdown as localHtmlToMarkdown, looksLikeHtml, stripBase64Images } from './markdown';
import type { AuthResolver } from '../providers/types';
import { TOOL_REACH } from '../tools/registry';
import { tolerate } from '../obs/index';

/** Credential key for the optional Tavily search upgrade. */
export const TAVILY_CRED_KEY = 'tavily';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Freshness signal when the backend reports one (ISO date or relative). */
  date?: string;
  /** 1-based rank in the result list. */
  position: number;
}

export interface WebSearchResponse {
  query: string;
  /** Optional synthesized answer (Tavily only). */
  answer?: string;
  results: WebSearchResult[];
  /** Which backend served the results — surfaced to the model so it knows
   *  whether it got ranked (tavily) or degraded (duckduckgo) results. */
  source: 'tavily' | 'duckduckgo';
}

export interface WebFetchResult {
  url: string;
  title?: string;
  retrievedAt: string;
  /** Clean markdown (already base64-stripped). */
  markdown: string;
}

export interface WebSearchProvider {
  search(query: string, opts?: { limit?: number }): Promise<WebSearchResponse>;
  fetch(url: string): Promise<WebFetchResult>;
}

export interface DefaultWebSearchProviderDeps {
  /** Outbound fetch. cf-backend passes the Worker global; cli-backend node fetch. */
  fetch: typeof fetch;
  /** Resolves credential headers. Optional — without it search is always
   *  key-less (DuckDuckGo). With it, a stored `tavily` key upgrades search. */
  getAuth?: AuthResolver;
  /** Platform HTML→markdown override (cf-backend: env.AI.toMarkdown). Falls
   *  back to the dependency-free local converter when absent or it throws. */
  htmlToMarkdown?: (html: string, opts?: { url?: string }) => Promise<string>;
  /** Per-request network timeout. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
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
/** Body cap before conversion — protects against multi-MB pages. */
const MAX_FETCH_BYTES = 2_000_000;

export class WebFetchError extends Error {
  constructor(message: string, public readonly retriable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebFetchError';
  }
}

/** The single shared provider implementation. Both backends construct it with
 *  their own `fetch` + auth seam; no per-backend search/fetch logic exists. */
export function createDefaultWebSearchProvider(deps: DefaultWebSearchProviderDeps): WebSearchProvider {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // workerd's fetch enforces its `this` binding: invoking the dependency as
  // a member of `deps` sets `this = deps` and throws "Illegal invocation".
  // Detach once so every call goes out with `this = undefined`, exactly like
  // a bare `fetch()` call (undici on the CLI is `this`-insensitive either way).
  const fetchImpl = deps.fetch;

  const withTimeout = async (run: (signal: AbortSignal) => Promise<Response>): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await run(ctrl.signal);
    } catch (error) {
      if (ctrl.signal.aborted) {
        throw new WebFetchError(`request timed out after ${timeoutMs}ms`, true, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const convert = async (html: string, url: string): Promise<string> =>
    deps.htmlToMarkdown
      ? stripBase64Images(await deps.htmlToMarkdown(html, { url }))
      : localHtmlToMarkdown(html);

  async function tavilyKey(): Promise<Record<string, string> | null> {
    if (!deps.getAuth) return null;
    const auth = await deps.getAuth(TAVILY_CRED_KEY);
    return auth?.headers ?? null;
  }

  async function tavilySearch(
    query: string,
    limit: number,
    headers: Record<string, string>,
  ): Promise<WebSearchResponse> {
    const res = await withTimeout((signal) =>
      fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          query,
          max_results: limit,
          include_answer: true,
          search_depth: 'basic',
        }),
        signal,
      }),
    );
    if (res.status === 429) throw new WebFetchError('Tavily rate limit (429) — retry shortly', true);
    if (!res.ok) {
      const body = await res.text();
      throw new WebFetchError(`Tavily search failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = v.parse(TavilyResponseSchema, await res.json());
    const results: WebSearchResult[] = (json.results ?? [])
      .filter((r) => r.url && isSafeUrl(r.url))
      .slice(0, limit)
      .map((r, i) => ({
        title: r.title?.trim() || r.url!,
        url: r.url!,
        snippet: stripBase64Images((r.content ?? '').trim()).slice(0, 600),
        date: r.published_date || undefined,
        position: i + 1,
      }));
    return { query, answer: json.answer?.trim() || undefined, results, source: 'tavily' };
  }

  async function duckDuckGoSearch(query: string, limit: number): Promise<WebSearchResponse> {
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await withTimeout((signal) =>
      fetchImpl(endpoint, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; ProteusAgent/1.0; +https://proteus.dev)',
          accept: 'text/html',
        },
        signal,
      }),
    );
    if (res.status === 429 || res.status === 202) {
      throw new WebFetchError('DuckDuckGo rate-limited the request — retry shortly, or connect a Tavily key for reliable search', true);
    }
    if (!res.ok) throw new WebFetchError(`web search failed (${res.status})`);
    const html = await res.text();
    const results = parseDuckDuckGoHtml(html, limit);
    return { query, results, source: 'duckduckgo' };
  }

  return {
    async search(query, opts) {
      const q = (query ?? '').trim();
      if (!q) throw new WebFetchError('search query is empty');
      const limit = clampLimit(opts?.limit);
      const headers = await tavilyKey();
      if (headers) return tavilySearch(q, limit, headers);
      return duckDuckGoSearch(q, limit);
    },

    async fetch(url) {
      let parsed: URL;
      try {
        parsed = assertSafeUrl(url);
      } catch (error) {
        if (error instanceof UnsafeUrlError) throw new WebFetchError(error.reason, false, { cause: error });
        throw error;
      }
      const res = await withTimeout((signal) =>
        fetchImpl(parsed.toString(), {
          headers: {
            // Markdown-for-Agents: Cloudflare-proxied zones return clean
            // markdown directly. Non-CF origins ignore it and serve HTML,
            // which we convert below.
            accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8',
            'user-agent': 'Mozilla/5.0 (compatible; ProteusAgent/1.0; +https://proteus.dev)',
          },
          redirect: 'follow',
          signal,
        }),
      );
      if (res.status === 429) throw new WebFetchError('fetch rate-limited (429) — retry shortly', true);
      if (!res.ok) throw new WebFetchError(`fetch failed (${res.status}) for ${parsed.toString()}`);

      const contentType = res.headers.get('content-type') ?? '';
      const buf = await res.arrayBuffer();
      const clipped = buf.byteLength > MAX_FETCH_BYTES;
      const bytes = clipped ? buf.slice(0, MAX_FETCH_BYTES) : buf;
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

      const markdown = looksLikeHtml(raw, contentType)
        ? await convert(raw, parsed.toString())
        : stripBase64Images(raw);

      // The byte guard is a memory ceiling; when it binds, the reader must be
      // able to tell a complete page from a cut one.
      const note = clipped
        ? `\n\n[fetch truncated: kept the first ${MAX_FETCH_BYTES} of ${buf.byteLength} bytes]`
        : '';
      return {
        url: parsed.toString(),
        title: extractTitle(raw) || extractMarkdownTitle(markdown) || undefined,
        retrievedAt: new Date().toISOString(),
        markdown: markdown.trim() + note,
      };
    },
  };
}

/** The `web.*` declaration the sandbox shows the model.
 *
 *  Explicit, like every sibling provider's, because the members take POSITIONAL
 *  arguments. Without it @cloudflare/codemode generates a declaration from the
 *  tools' (absent) input schemas and produces `search: (input: SearchInput) =>
 *  Promise<SearchOutput>` with `type SearchInput = unknown` — an object-argument
 *  signature sitting beside a member description that states the positional
 *  shape. A model following the generated signature writes
 *  `web.search({ query })`, which arrives as args[0] and is stringified into a
 *  search for the literal "[object Object]". */
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

/** Codemode provider exposing the same web capability inside execute_tools as
 *  `web.search(query, { limit })` / `web.fetch(url)`, so agents can loop
 *  searches and fetch in parallel from one JS block. Shape is the shared
 *  `{ name, tools }` codemode contract both backends already inject. */
export function createWebCodemodeProvider(provider: WebSearchProvider) {
  return {
    name: TOOL_REACH.web.codemode,
    types: TYPES,
    tools: {
      search: {
        description: 'web.search(query, { limit? }) → { results: [{ title, url, snippet, date, position }], answer?, source }',
        execute: async (...args: unknown[]) => {
          const query = String(args[0] ?? '');
          const parsedOpts = v.safeParse(WebSearchOptionsSchema, args[1]);
          const opts = parsedOpts.success ? parsedOpts.output : undefined;
          return provider.search(query, opts);
        },
      },
      fetch: {
        description: 'web.fetch(url) → { url, title?, retrievedAt, markdown }',
        execute: async (...args: unknown[]) => provider.fetch(String(args[0] ?? '')),
      },
    },
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)));
}

/** Parse DuckDuckGo's HTML SERP into ranked results. The lite HTML endpoint
 *  wraps each hit in `<a class="result__a" href="...">title</a>` plus a
 *  `<a class="result__snippet">snippet</a>`. DDG proxies the real URL behind
 *  a `/l/?uddg=` redirect — we unwrap it. */
export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(decodeText(stripTags(sm[1])));

  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < limit) {
    const url = unwrapDuckUrl(decodeAttr(m[1]));
    const title = decodeText(stripTags(m[2])).trim();
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
  // A result row can carry anything the page put in `href`; an unparseable one
  // is a value here. Every other URL failure is this module's own bug.
  const parsed = tolerate(() => new URL(abs, 'https://duckduckgo.com'), 'malformed-input');
  if (!parsed) return '';
  const uddg = parsed.searchParams.get('uddg');
  if (uddg) return uddg;
  return /^https?:/.test(abs) ? abs : '';
}

function extractTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeText(stripTags(m[1])).trim().slice(0, 300) : '';
}

/** Title for already-markdown content (Markdown-for-Agents): YAML frontmatter
 *  `title:` then the first `# heading`. */
function extractMarkdownTitle(md: string): string {
  const fm = /^---\s*[\s\S]*?\btitle:\s*["']?([^"'\n]+)["']?\s*[\s\S]*?\n---/m.exec(md);
  if (fm) return fm[1].trim().slice(0, 300);
  const h1 = /^#\s+(.+)$/m.exec(md);
  return h1 ? h1[1].trim().slice(0, 300) : '';
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeAttr(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/');
}

function decodeText(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

