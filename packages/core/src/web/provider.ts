/**
 * Web search/fetch provider shared by both backends; key-less by default (DuckDuckGo), Tavily when a `tavily`
 * credential is stored. Rendered fetches and screenshots go through Browser Run (`browser-run.ts`).
 */

import * as v from 'valibot';
import { refusedResolution, assertSafeUrl, isSafeUrl, UnsafeUrlError, type HostResolver } from './url-safety';
import { decodeEntities, htmlToMarkdown as localHtmlToMarkdown, looksLikeHtml, stripBase64Images, stripTags } from './markdown';
import { quickAction, type BrowserRunAccess, type QuickActionEngine, type QuickActionTransport } from './browser-run';
import type { AuthResolution, AuthResolver } from '../providers/types';
import { TAVILY_CRED_KEY } from '../credentials/validate';
import { attempt, attemptInItsWords, diagnostics, inItsWords, KinuError, settle, tolerate } from '../obs/index';
import { Data, Effect } from 'effect';



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

/** A PNG: Browser Run's default, and the one type Kitesurf takes (webp answers 501, measured 2026-09-28). */
export interface WebScreenshot {
  url: string;
  retrievedAt: string;
  bytes: Uint8Array;
}

export interface WebSearchProvider {
  search(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<WebSearchResponse>;
  fetch(url: string, opts?: { signal?: AbortSignal }): Promise<WebFetchResult>;
  /** The page after its scripts ran, as markdown. */
  render(url: string, opts?: { engine?: QuickActionEngine; signal?: AbortSignal }): Promise<WebFetchResult>;
  screenshot(url: string, opts?: { engine?: QuickActionEngine; fullPage?: boolean; signal?: AbortSignal }): Promise<WebScreenshot>;
}

export interface DefaultWebSearchProviderDeps {
  fetch: typeof fetch;
  /** Absent: search is always DuckDuckGo. */
  getAuth?: AuthResolver;
  /** Falls back to the local converter when absent or throwing. */
  htmlToMarkdown?: (html: string, opts?: { url?: string }) => Promise<string>;
  /** Absent on a Worker, whose platform refuses a name resolving inward (`url-safety.ts`). */
  resolve?: HostResolver;
  browser: BrowserRunAccess;
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


const MAX_FETCH_BYTES = 2_000_000;

/** WHATWG Fetch's redirect bound (https://fetch.spec.whatwg.org/#http-redirect-fetch). */
const MAX_REDIRECTS = 20;

class WebFetchError extends Data.TaggedError('WebFetchError')<{ readonly message: string; readonly cause?: unknown }> {
  constructor(message: string, options?: { readonly cause: unknown }) {
    super(options === undefined ? { message } : { message, cause: options.cause });
  }
}

/**
 * Measured 2026-09-28: Browser Run's default `domcontentloaded` returned the empty shell of a page whose script
 * writes its content after load; `networkidle2` found the content on 7 of 8 script-built pages on Kitesurf, as
 * `networkidle0` did, in 1.0-1.3 s against 1.4-2.3 s (the eighth rate-limits Kitesurf's egress).
 */
const RENDERED = 'networkidle2';

/** The slate pictures' viewport; Browser Run's 1920x1080 default costs a vision model about twice the tokens. */
const SCREENSHOT_VIEWPORT = { width: 1280, height: 800 };

/**
 * The rendered HTML, converted as a plain fetch's is. Browser Run's `/markdown` drops whitespace-only elements:
 * example.com, whose script wraps each character in a span, came back "Thisdomainisforuse..." on both engines.
 */
const RenderedPageSchema = v.object({
  result: v.string(),
  meta: v.object({ status: v.number(), title: v.string(), finalUrl: v.optional(v.string()) }),
});

export function createDefaultWebSearchProvider(deps: DefaultWebSearchProviderDeps): WebSearchProvider {
  // Detached: workerd's fetch throws "Illegal invocation" when called as `deps.fetch`.
  const fetchImpl = deps.fetch;

  const convert = (html: string, url: string): Effect.Effect<string> => {
    const toMarkdown = deps.htmlToMarkdown;

    if (!toMarkdown) return Effect.sync(() => localHtmlToMarkdown(html));

    return attempt({ doing: 'convert fetched HTML to markdown', otherwise: 'io' }, async () => stripBase64Images(await toMarkdown(html, { url }))).pipe(
      Effect.catch((failure) => Effect.sync(() => {
        diagnostics.failure('web.convert_failed', failure);

        return localHtmlToMarkdown(html);
      })),
    );
  };

  const tavilySearch = (
    query: string,
    limit: number,
    { headers, baseURL = TAVILY_API }: AuthResolution,
    signal: AbortSignal | undefined,
  ): Effect.Effect<WebSearchResponse> => Effect.gen(function* () {
    const res = yield* Effect.promise(() => fetchImpl(new URL('search', baseURL.endsWith('/') ? baseURL : `${baseURL}/`).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        query,
        max_results: limit,
        include_answer: true,
        search_depth: 'basic',
      }),
      signal,
    }));

    if (res.status === 429) return yield* Effect.die(new WebFetchError('Tavily rate limit (429): retry shortly'));

    if (!res.ok) {
      const body = yield* Effect.promise(() => res.text());

      return yield* Effect.die(new WebFetchError(`Tavily search failed (${res.status}): ${body.slice(0, 200)}`));
    }

    const read = Effect.tryPromise({
      try: async (): Promise<WebSearchResponse> => {
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
      },
      catch: (cause) => ({ cause }),
    });

    return yield* Effect.catch(read, (failed) => Effect.die(signal?.aborted === true
      ? failed.cause
      : new WebFetchError('Tavily search returned an unreadable response', { cause: failed.cause })));
  });

  const duckDuckGoSearch = (query: string, limit: number, signal: AbortSignal | undefined): Effect.Effect<WebSearchResponse> => Effect.gen(function* () {
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const res = yield* Effect.promise(() => fetchImpl(endpoint, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; KinuAgent/1.0; +https://kinu.dev)',
        accept: 'text/html',
      },
      signal,
    }));

    if (res.status === 429 || res.status === 202) {
      return yield* Effect.die(new WebFetchError('DuckDuckGo rate-limited the request: retry shortly, or connect a Tavily key for reliable search'));
    }

    if (!res.ok) return yield* Effect.die(new WebFetchError(`web search failed (${res.status})`));
    const html = yield* Effect.promise(() => res.text());
    const results = parseDuckDuckGoHtml(html, limit);

    return { query, results, source: 'duckduckgo' };
  });

  const judged = (url: string): Effect.Effect<URL> => Effect.gen(function* () {
    const parsed = yield* Effect.try({ try: () => assertSafeUrl(url), catch: (cause) => ({ cause }) }).pipe(
      Effect.catch((failed) => Effect.die(failed.cause instanceof UnsafeUrlError
        ? new WebFetchError(failed.cause.reason, { cause: failed.cause })
        : failed.cause)),
    );

    const resolve = deps.resolve;
    const refusal = resolve === undefined ? null : yield* Effect.promise(() => refusedResolution(parsed, resolve));

    if (refusal !== null) return yield* Effect.die(new WebFetchError(refusal));

    return parsed;
  });

  const browserRun = (url: string): Effect.Effect<{ readonly transport: QuickActionTransport; readonly target: URL }, KinuError> => {
    const access = deps.browser;

    if ('missing' in access) return Effect.fail(new KinuError('unavailable', access.missing));

    return Effect.map(
      inItsWords('denied', judged(url)),
      (target) => ({ transport: access.quickActions, target }),
    );
  };

  const renderPage = (url: string, engine: QuickActionEngine, signal: AbortSignal | undefined): Effect.Effect<WebFetchResult, KinuError> => Effect.gen(function* () {
    const { transport, target } = yield* browserRun(url);
    const doing = `rendering ${target.href}`;

    const response = yield* attemptInItsWords('unavailable', () => quickAction({
      transport, action: 'content', engine, signal,
      options: { url: target.href, gotoOptions: { waitUntil: RENDERED } },
    }));

    const answer = v.safeParse(RenderedPageSchema, yield* attemptInItsWords('io', () => response.json()));

    if (!answer.success) return yield* Effect.fail(new KinuError('io', `Browser Run answered ${doing} in a shape Kinu does not read`));
    const { result, meta } = answer.output;
    const finalUrl = meta.finalUrl ?? target.href;

    if (meta.status >= 400) return yield* Effect.fail(new KinuError('unavailable', engine === 'kitesurf'
      ? `the site answered ${meta.status} to Kitesurf at ${finalUrl}; Chrome (engine 'chrome') gets through some bot-checked and rate-limited sites`
      : `the site answered ${meta.status} to Chrome at ${finalUrl}`));
    // The plain fetch's cap on the page it converts, with the size the page had.
    const html = new TextEncoder().encode(result);
    const kept = html.length > MAX_FETCH_BYTES ? new TextDecoder('utf-8', { fatal: false }).decode(html.subarray(0, MAX_FETCH_BYTES)) : result;
    const markdown = (yield* convert(kept, finalUrl)).trim();
    const note = kept === result ? '' : `\n\n[fetch truncated: kept the first ${MAX_FETCH_BYTES} of ${html.length} bytes]`;

    return {
      url: finalUrl,
      title: meta.title || extractMarkdownTitle(markdown) || undefined,
      retrievedAt: new Date().toISOString(),
      markdown: markdown + note,
    };
  });

  const shootPage = (url: string, engine: QuickActionEngine, fullPage: boolean, signal: AbortSignal | undefined): Effect.Effect<WebScreenshot, KinuError> => Effect.gen(function* () {
    const { transport, target } = yield* browserRun(url);

    const response = yield* attemptInItsWords('unavailable', () => quickAction({
      transport, action: 'screenshot', engine, signal,
      options: { url: target.href, viewport: SCREENSHOT_VIEWPORT, gotoOptions: { waitUntil: RENDERED }, screenshotOptions: { fullPage } },
    }));

    const bytes = new Uint8Array(yield* attemptInItsWords('io', () => response.arrayBuffer()));

    return { url: target.href, retrievedAt: new Date().toISOString(), bytes };
  });

  return {
    search(query, opts) {
      return settle(Effect.gen(function* () {
        const q = query.trim();

        if (!q) return yield* Effect.die(new WebFetchError('search query is empty'));
        const limit = clampLimit(opts?.limit);
        const getAuth = deps.getAuth;
        const auth = getAuth ? yield* Effect.promise(() => getAuth(TAVILY_CRED_KEY)) : null;

        if (auth) return yield* tavilySearch(q, limit, auth, opts?.signal);

        return yield* duckDuckGoSearch(q, limit, opts?.signal);
      }));
    },

    fetch(url, opts) {
      return settle(Effect.gen(function* () {
        const parsed = yield* judged(url);

        // Redirects followed manually so every Location passes the SSRF guard.
        let finalUrl = parsed.toString();
        let hop: Response;

        for (let redirects = 0; ; redirects++) {
          if (redirects > 0) yield* judged(finalUrl);
          const from = finalUrl;

          hop = yield* Effect.promise(() => fetchImpl(from, {
            headers: {
              // Markdown-for-Agents: Cloudflare-proxied zones answer with markdown.
              accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8',
              'user-agent': 'Mozilla/5.0 (compatible; KinuAgent/1.0; +https://kinu.dev)',
            },
            redirect: 'manual',
            signal: opts?.signal,
          }));

          const location =
            hop.status === 301 || hop.status === 302 || hop.status === 303 || hop.status === 307 || hop.status === 308
              ? hop.headers.get('location')
              : null;

          if (!location) break;

          if (redirects >= MAX_REDIRECTS) {
            return yield* Effect.die(new WebFetchError(`too many redirects (over ${MAX_REDIRECTS}) for ${parsed.toString()}`));
          }

          const next = yield* Effect.try({ try: () => new URL(location, from), catch: (cause) => ({ cause }) }).pipe(
            Effect.catch((failed) => Effect.die(new WebFetchError(`redirect from ${from} names an unparseable location`, { cause: failed.cause }))),
          );

          finalUrl = next.toString();
        }

        if (hop.status === 429) return yield* Effect.die(new WebFetchError('fetch rate-limited (429): retry shortly'));

        if (!hop.ok) return yield* Effect.die(new WebFetchError(`fetch failed (${hop.status}) for ${finalUrl}`));
        const contentType = hop.headers.get('content-type') ?? '';
        const answered = hop;
        const { bytes, clipped } = yield* Effect.promise(() => readCappedBody(answered, MAX_FETCH_BYTES));
        const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

        const markdown = looksLikeHtml(raw, contentType)
          ? yield* convert(raw, finalUrl)
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
      }));
    },

    render: (url, opts) => settle(renderPage(url, opts?.engine ?? 'kitesurf', opts?.signal)),

    screenshot: (url, opts) => settle(shootPage(url, opts?.engine ?? 'kitesurf', opts?.fullPage === true, opts?.signal)),
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

export interface BrowserSessionView {
  readonly id: string;
  readonly liveView: string;
}

/** Chrome sessions an actor opened; Kitesurf ones never outlive a connection (measured 2026-09-28). */
export interface BrowserSessions {
  open(opts: { readonly lab: boolean }): Promise<BrowserSessionView>;
  list(): Promise<BrowserSessionView[]>;
  close(id: string): Promise<void>;
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

