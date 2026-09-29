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
import { TOOL_REACH } from '../tools/registry';
import { readExecSignal } from '../execution/signal';
import { codemodeText } from '../tools/sandbox-contract';
import { attemptInItsWords, diagnostics, KinuError, settle, toKinuError, tolerate } from '../obs/index';
import { Effect } from 'effect';
import type { CodemodeProvider } from '../types/codemode';
import type { VFS } from '../types/primitives';
import { bytesToBase64 } from '../utils/base64';
import { saveScreenshot } from './screenshots';


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

const WebSearchOptionsSchema = v.object({ limit: v.optional(v.number()) });

const MAX_FETCH_BYTES = 2_000_000;

/** WHATWG Fetch's redirect bound (https://fetch.spec.whatwg.org/#http-redirect-fetch). */
const MAX_REDIRECTS = 20;

class WebFetchError extends Error {
  override readonly name = 'WebFetchError';
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

  const browserRun = (url: string): Effect.Effect<{ readonly transport: QuickActionTransport; readonly target: URL }, KinuError> => {
    const access = deps.browser;

    if ('missing' in access) return Effect.fail(new KinuError('unavailable', access.missing));

    return Effect.map(
      attemptInItsWords('denied', () => judged(url)),
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
    const markdown = (yield* attemptInItsWords('io', () => convert(kept, finalUrl))).trim();
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

/** Explicit because members take positional args; a generated declaration would suggest `web.search({ query })`. */
const TYPES = `export declare const web: {
  /** Up to \`limit\` ranked results (default 5, max 20). */
  search(query: string, opts?: { limit?: number }): Promise<{
    query: string;
    results: Array<{ title: string; url: string; snippet: string; date?: string; position: number }>;
    answer?: string;
    source: string;
  } | Refusal>;
  /** \`render\`: load the page in a browser first, for a page its scripts build. \`engine\` (with \`render\` or a screenshot): Kitesurf by default; Chrome gets through some bot-checked and rate-limited sites. */
  fetch(url: string, opts?: { render?: boolean; engine?: 'kitesurf' | 'chrome' }): Promise<{ url: string; title?: string; retrievedAt: string; markdown: string } | Refusal>;
  /** In eval, saved at \`path\`, and a program that returns a data:image URL shows you the image; a slate gets no \`path\` (it writes nothing) and shows \`dataUrl\` in an <img>. */
  screenshot(url: string, opts?: { fullPage?: boolean; engine?: 'kitesurf' | 'chrome' }): Promise<{ url: string; path?: string; retrievedAt: string; dataUrl: string } | Refusal>;
  /** A browser for \`connectBrowser\`. Chrome: kept across programs and turns until closed or idle 20 min; \`liveView\` lets the owner watch or take over (a login, a captcha), so give it to them; \`lab\` enables the page's WebMCP tools. Kitesurf: lighter, with WebMCP; each connect starts a browser that ends with its program, and it has no Live View. */
  openBrowser(opts?: { browser?: 'chrome' | 'kitesurf'; lab?: boolean }): Promise<{ id: string; liveView: string | null } | Refusal>;
  browsers(): Promise<Array<{ id: string; liveView: string }> | Refusal>;
  closeBrowser(id: string): Promise<null | Refusal>;
  /** A @cloudflare/puppeteer \`Browser\` on an \`openBrowser\` id. \`page.accessibility.snapshot()\` reads the accessibility tree. */
  connectBrowser(id: string): Promise<Browser | Refusal>;
  /** The page's WebMCP tools, and a call to one. */
  pageTools(page: Page): Promise<Array<{ name: string; description: string; inputSchema: object }> | Refusal>;
  callPageTool(page: Page, name: string, input: object): Promise<unknown>;
};
`;

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

export type BrowserSessionsAccess = { readonly sessions: BrowserSessions } | { readonly missing: string };

export interface WebCodemodeDeps {
  readonly provider: WebSearchProvider;
  /** Where a screenshot is saved; null on a slate's route, where a share visitor writes nothing into the workspace. */
  readonly vfs: VFS | null;
  readonly sessions: BrowserSessionsAccess;
  /** Sandbox-side `connectBrowser`, `pageTools` and `callPageTool`; without it they refuse, naming `missing`. */
  readonly prelude?: { readonly source: string } | { readonly missing: string };
}

const EngineSchema = v.optional(v.picklist(['kitesurf', 'chrome']));

/** What the sandbox half of a browser member hands its host member when it fails (cf-backend `browser-prelude.ts`). */
const SandboxRefusalSchema = v.object({ refused: v.string(), reason: v.picklist(['denied', 'unavailable']) });

type SandboxRefusal = v.InferOutput<typeof SandboxRefusalSchema>;

/** The first argument a browser member's host half received, as a sandbox refusal when it is one. */
function sandboxRefusal(input: { readonly argument: unknown }): SandboxRefusal | undefined {
  const parsed = v.safeParse(SandboxRefusalSchema, input.argument);

  return parsed.success ? parsed.output : undefined;
}

const FetchOptionsSchema = v.object({ render: v.optional(v.boolean()), engine: EngineSchema });

const ScreenshotOptionsSchema = v.object({ fullPage: v.optional(v.boolean()), engine: EngineSchema });

const OpenBrowserOptionsSchema = v.object({ browser: v.optional(v.picklist(['chrome', 'kitesurf'])), lab: v.optional(v.boolean()) });

/**
 * The engine `openBrowser` picks when the call names none. Chrome, because only a Chrome session outlives its
 * connection, keeps a Live View, and reconnects by id (measured 2026-09-28); Kitesurf's id is its connection.
 */
const OPEN_BROWSER_DEFAULT = 'chrome';

/** Kitesurf has no session to keep: `connectBrowser` starts one per program under this id. */
export const KITESURF_SESSION_ID = 'kitesurf';

/** A slate's \`web\`: the one-shot members only, writing nothing into the workspace, since a share visitor may call it. */
export function createSlateWebCodemodeProvider(provider: WebSearchProvider): CodemodeProvider {
  return createWebCodemodeProvider({
    provider, vfs: null,
    sessions: { missing: 'a slate holds no browser session; it has web.search, web.fetch and web.screenshot' },
  });
}

export function createWebCodemodeProvider(deps: WebCodemodeDeps): CodemodeProvider {
  const { provider, vfs } = deps;

  const sessions: Effect.Effect<BrowserSessions, KinuError> = 'missing' in deps.sessions
    ? Effect.fail(new KinuError('unavailable', deps.sessions.missing))
    : Effect.succeed(deps.sessions.sessions);

  const withSessions = <A>(run: (open: BrowserSessions) => Promise<A>): Effect.Effect<A, KinuError> => (
    Effect.flatMap(sessions, (open) => attemptInItsWords('unavailable', () => run(open)))
  );

  /**
   * Where no prelude defines the member, a call reaches the host, which refuses it. Where one does, its failure
   * arrives here as a `SandboxRefusal`, so the program's census records it as it records a host member's.
   */
  const sandboxOnly = (member: string, refused: SandboxRefusal | undefined): Effect.Effect<never, KinuError> => {
    if (refused !== undefined) return Effect.fail(new KinuError(refused.reason, `web.${member}: ${refused.refused}`));

    return Effect.fail(new KinuError('unsupported', deps.prelude !== undefined && 'missing' in deps.prelude
      ? deps.prelude.missing
      : `web.${member} runs only inside an eval program`));
  };

  const tools: CodemodeProvider['tools'] = {
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
      description: 'web.fetch(url, { render?, engine? }) -> { url, title?, retrievedAt, markdown }',
      execute: async (...args: unknown[]) => {
        const url = codemodeText({ value: args[0], parameter: 'web.fetch(url)' });
        const opts = v.safeParse(FetchOptionsSchema, args[1] ?? {});
        const signal = readExecSignal({ context: args[2] });

        if (!opts.success) return settle(Effect.fail(new KinuError('bad_input', `web.fetch takes { render?: boolean, engine?: 'kitesurf' | 'chrome' }`)));
        const { render = false, engine } = opts.output;

        if (engine !== undefined && !render) return settle(Effect.fail(new KinuError('bad_input', 'web.fetch: `engine` applies to a rendered fetch; add `render: true`')));

        return render ? provider.render(url, { engine, signal }) : provider.fetch(url, { signal });
      },
    },
    screenshot: {
      description: 'web.screenshot(url, { fullPage?, engine? }) -> { url, path?, retrievedAt, dataUrl }',
      execute: async (...args: unknown[]) => {
        const url = codemodeText({ value: args[0], parameter: 'web.screenshot(url)' });
        const opts = v.safeParse(ScreenshotOptionsSchema, args[1] ?? {});

        if (!opts.success) return settle(Effect.fail(new KinuError('bad_input', `web.screenshot takes { fullPage?: boolean, engine?: 'kitesurf' | 'chrome' }`)));
        const shot = await provider.screenshot(url, { fullPage: opts.output.fullPage === true, engine: opts.output.engine, signal: readExecSignal({ context: args[2] }) });
        const dataUrl = `data:image/png;base64,${bytesToBase64(shot.bytes)}`;

        if (vfs === null) return { url: shot.url, retrievedAt: shot.retrievedAt, dataUrl };

        return { url: shot.url, path: await saveScreenshot(vfs, shot), retrievedAt: shot.retrievedAt, dataUrl };
      },
    },
    openBrowser: {
      description: 'web.openBrowser({ browser?, lab? }) -> { id, liveView }',
      execute: async (...args: unknown[]) => {
        const parsed = v.safeParse(OpenBrowserOptionsSchema, args[0] ?? {});

        if (!parsed.success) return settle(Effect.fail(new KinuError('bad_input', `web.openBrowser takes { browser?: 'chrome' | 'kitesurf', lab?: boolean }`)));
        const { browser = OPEN_BROWSER_DEFAULT, lab = false } = parsed.output;

        if (browser === 'chrome') return settle(withSessions((open) => open.open({ lab })));

        if (lab) return settle(Effect.fail(new KinuError('bad_input', 'web.openBrowser: `lab` is a Chrome option; Kitesurf has WebMCP already')));

        return { id: KITESURF_SESSION_ID, liveView: null };
      },
    },
    browsers: {
      planAllowed: true,
      description: 'web.browsers() -> [{ id, liveView }]',
      execute: async () => settle(withSessions((open) => open.list())),
    },
    closeBrowser: {
      description: 'web.closeBrowser(id) -> null',
      execute: async (...args: unknown[]) => settle(Effect.as(withSessions((open) => open.close(codemodeText({ value: args[0], parameter: 'web.closeBrowser(id)' }))), null)),
    },
    connectBrowser: { description: 'web.connectBrowser(id): puppeteer in the eval sandbox', execute: async (...args: unknown[]) => settle(sandboxOnly('connectBrowser', sandboxRefusal({ argument: args[0] }))) },
    pageTools: { description: 'web.pageTools(page): WebMCP in the eval sandbox', execute: async (...args: unknown[]) => settle(sandboxOnly('pageTools', sandboxRefusal({ argument: args[0] }))) },
    callPageTool: { description: 'web.callPageTool(page, name, input): WebMCP in the eval sandbox', execute: async (...args: unknown[]) => settle(sandboxOnly('callPageTool', sandboxRefusal({ argument: args[0] }))) },
  };

  return deps.prelude !== undefined && 'source' in deps.prelude
    ? { name: TOOL_REACH.web.codemode, types: TYPES, tools, prelude: deps.prelude.source }
    : { name: TOOL_REACH.web.codemode, types: TYPES, tools };
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

