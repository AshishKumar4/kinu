/**
 * Web search/fetch provider shared by both backends. Search runs the account's chain of providers (`search-chain.ts`);
 * rendered fetches and screenshots go through Browser Run (`browser-run.ts`).
 */

import * as v from 'valibot';
import { refusedResolution, assertSafeUrl, UnsafeUrlError, type HostResolver } from './url-safety';
import { htmlToMarkdown as localHtmlToMarkdown, looksLikeHtml, stripBase64Images } from './markdown';
import { readHtml } from '../utils/html';
import { MarkdownFrontmatterError, parseMarkdownFrontmatter } from '../utils/markdown-frontmatter';
import { quickAction, type BrowserRunAccess, type QuickActionEngine, type QuickActionTransport } from './browser-run';
import type { WebSearchProviderId } from '../providers/web-search';
import type { WebSearch } from './search-chain';
import { attempt, attemptInItsWords, diagnostics, inItsWords, KinuError, settle } from '../obs/index';
import { Data, Effect } from 'effect';
import type { JsonObject } from '../utils/json';
import { boundedInt } from '../utils/bounds';

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
  /** A provider that writes an answer of its own (Tavily). */
  answer?: string;
  results: WebSearchResult[];
  /** The provider whose index the results came from, however it was billed. */
  source: WebSearchProviderId;
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
  /** The account's search: its chain where its keys are (`chainWebSearch`), or its deployment's route from a CLI. */
  search: WebSearch;
  /** Falls back to the local converter when absent or throwing. */
  htmlToMarkdown?: (html: string, opts?: { url?: string }) => Promise<string>;
  /** Absent on a Worker, whose platform refuses a name resolving inward (`url-safety.ts`). */
  resolve?: HostResolver;
  browser: BrowserRunAccess;
  /**
   * The cookie Browser Run carries to `url` when it is one of this workspace's own previews, which open only for their
   * owner; null for any other page. Absent outside a workspace.
   */
  previewPass?: (url: URL) => Promise<BrowserCookie | null>;
}

/** A cookie Browser Run sets on one page's host before it loads the page. */
export interface BrowserCookie {
  readonly name: string;
  readonly value: string;
}

const DEFAULT_SEARCH_LIMIT = 5;

const MAX_SEARCH_LIMIT = 20;

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

    if (!toMarkdown) return Effect.promise(() => localHtmlToMarkdown(html));

    return attempt({ doing: 'convert fetched HTML to markdown', otherwise: 'io' }, async () => stripBase64Images(await toMarkdown(html, { url }))).pipe(
      Effect.catch((failure) => Effect.sync(() => {
        diagnostics.failure('web.convert_failed', failure);
      }).pipe(Effect.andThen(Effect.promise(() => localHtmlToMarkdown(html))))),
    );
  };

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

  const browserRun = (url: string): Effect.Effect<{ readonly transport: QuickActionTransport; readonly target: URL; readonly cookies: JsonObject }, KinuError> => {
    const access = deps.browser;

    if ('missing' in access) return Effect.fail(new KinuError('unavailable', access.missing));
    const previewPass = deps.previewPass;

    return Effect.gen(function* () {
      const target = yield* inItsWords('denied', judged(url));
      const pass = previewPass === undefined ? null : yield* Effect.promise(() => previewPass(target));
      // A host-only, secure cookie, as the preview's own exchange sets it.
      const cookies: JsonObject = pass === null ? {} : { cookies: [{ name: pass.name, value: pass.value, url: `${target.origin}/`, secure: true, httpOnly: true, sameSite: 'Lax' }] };

      return { transport: access.quickActions, target, cookies };
    });
  };

  const renderPage = (url: string, engine: QuickActionEngine, signal: AbortSignal | undefined): Effect.Effect<WebFetchResult, KinuError> => Effect.gen(function* () {
    const { transport, target, cookies } = yield* browserRun(url);
    const doing = `rendering ${target.href}`;

    const response = yield* attemptInItsWords('unavailable', () => quickAction({
      transport, action: 'content', engine, signal,
      options: { url: target.href, gotoOptions: { waitUntil: RENDERED }, ...cookies },
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
      title: meta.title || (yield* markdownTitle(markdown)) || undefined,
      retrievedAt: new Date().toISOString(),
      markdown: markdown + note,
    };
  });

  const shootPage = (url: string, engine: QuickActionEngine, fullPage: boolean, signal: AbortSignal | undefined): Effect.Effect<WebScreenshot, KinuError> => Effect.gen(function* () {
    const { transport, target, cookies } = yield* browserRun(url);

    const response = yield* attemptInItsWords('unavailable', () => quickAction({
      transport, action: 'screenshot', engine, signal,
      options: { url: target.href, viewport: SCREENSHOT_VIEWPORT, gotoOptions: { waitUntil: RENDERED }, screenshotOptions: { fullPage }, ...cookies },
    }));

    const bytes = new Uint8Array(yield* attemptInItsWords('io', () => response.arrayBuffer()));

    return { url: target.href, retrievedAt: new Date().toISOString(), bytes };
  });

  return {
    search(query, opts) {
      return settle(Effect.gen(function* () {
        const q = query.trim();

        if (!q) return yield* Effect.die(new WebFetchError('search query is empty'));
        const signal = opts?.signal;

        return yield* attemptInItsWords('unavailable', () => deps.search({ query: q, limit: clampLimit(opts?.limit), ...(signal !== undefined && { signal }) }));
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

        const html = looksLikeHtml(raw, contentType);
        const markdown = html ? yield* convert(raw, finalUrl) : stripBase64Images(raw);
        const title = html ? (yield* Effect.promise(() => readHtml(raw))).title : '';

        const note = clipped
          ? `\n\n[fetch truncated: kept the first ${MAX_FETCH_BYTES} of more than ${MAX_FETCH_BYTES} bytes]`
          : '';

        return {
          url: finalUrl,
          title: title.slice(0, 300) || (yield* markdownTitle(markdown)) || undefined,
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
  return boundedInt(limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
}

/** A markdown page's title: its front matter's `title:`, as the skill reader reads front matter, else its first
 *  top-level heading outside a code block. */
function markdownTitle(md: string): Effect.Effect<string> {
  // A page whose front matter the reader refuses has none: its text is the body.
  return Effect.try({ try: () => parseMarkdownFrontmatter(md), catch: (cause) => cause }).pipe(
    Effect.catchIf((cause) => cause instanceof MarkdownFrontmatterError, () => Effect.succeed(null)),
    Effect.catch((cause) => Effect.die(cause)),
    Effect.flatMap((front) => {
      const named = front?.frontmatter['title'];

      if (typeof named === 'string' && named.trim() !== '') return Effect.succeed(named.trim().slice(0, 300));

      // The grammar is imported by the first page that needs it, never by a startup (L27).
      return Effect.map(Effect.promise(() => import('mdast-util-from-markdown')), ({ fromMarkdown }) => {
        const heading = fromMarkdown(front?.body ?? md).children.find((node) => node.type === 'heading' && node.depth === 1);

        return heading === undefined ? '' : phrasingText(heading).trim().slice(0, 300);
      });
    }),
  );
}

/** A markdown node, as far as its text goes. */
interface Phrasing {
  readonly type: string;
  readonly value?: unknown;
  readonly children?: readonly Phrasing[];
}

/** A node's text as a reader sees it: its text and code children's values, in order. */
function phrasingText(node: Phrasing): string {
  if (typeof node.value === 'string') return node.value;

  return (node.children ?? []).map(phrasingText).join('');
}

