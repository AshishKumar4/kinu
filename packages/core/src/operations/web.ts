/** The web: search, a page as Markdown, a screenshot, and remote browser sessions a program drives. */
import * as v from 'valibot';
import { defineOperation } from './operation';

/** Kitesurf has no session to keep: `connectBrowser` starts one per program under this id. */
export const KITESURF_SESSION_ID = 'kitesurf';

const described = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const Url = described(v.pipe(v.string(), v.url()), 'An absolute http(s) URL.');

const Engine = v.optional(described(v.picklist(['kitesurf', 'chrome']), 'kitesurf (default), or chrome, which gets through some bot-checked and rate-limited sites.'));

const SessionView = v.strictObject({ id: v.string(), liveView: v.string() });

export const WEB = {
  search: defineOperation({
    ns: 'web', name: 'search', help: 'Search the web.', impact: 'observe', availability: 'both', slate: true,
    input: v.strictObject({ query: v.pipe(v.string(), v.nonEmpty()), limit: v.optional(described(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)), 'Default 5.')) }),
    output: v.strictObject({
      query: v.string(),
      answer: v.optional(v.string()),
      results: v.array(v.strictObject({ title: v.string(), url: v.string(), snippet: v.string(), date: v.optional(v.string()), position: v.number() })),
      source: v.picklist(['tavily', 'duckduckgo']),
    }),
    text: ({ query, answer, results, source }) => {
      if (results.length === 0) return `No web results for "${query}".`;

      return [
        ...(answer === undefined ? [] : [`Answer: ${answer}`, '']),
        ...results.map((r) => `${r.position}. ${r.title}${r.date === undefined ? '' : ` (${r.date})`}\n   ${r.url}\n   ${r.snippet}`),
        '', `[${results.length} results via ${source}]`,
      ].join('\n');
    },
  }),
  fetch: defineOperation({
    ns: 'web', name: 'fetch', help: 'A page as Markdown. Private and internal addresses are blocked.', impact: 'observe', availability: 'both', slate: true,
    input: v.strictObject({
      url: Url,
      render: v.optional(described(v.boolean(), 'Load the page in a browser first, for a page its scripts build; slower.')),
      engine: Engine,
    }),
    output: v.strictObject({ url: v.string(), title: v.optional(v.string()), retrievedAt: v.string(), markdown: v.string() }),
    // The provenance header is inside what is clamped, so a hostile title cannot buy room outside the cap.
    text: (page) => `# ${page.title ?? page.url}\nSource: ${page.url}\nRetrieved: ${page.retrievedAt}\n\n${page.markdown}`,
  }),
  // It saves a file, so a Plan turn has none.
  screenshot: defineOperation({
    ns: 'web', name: 'screenshot', help: 'A screenshot of a page, saved under screenshots/ and shown to you.', impact: 'observe', plan: false, availability: 'both', slate: true,
    input: v.strictObject({ url: Url, fullPage: v.optional(described(v.boolean(), 'The whole page, saved only; you get its path.')), engine: Engine }),
    output: v.strictObject({
      url: v.string(), retrievedAt: v.string(),
      path: v.optional(described(v.string(), 'Absent on a slate, which writes nothing.')),
      dataUrl: v.optional(described(v.string(), 'The PNG; absent for a whole page.')),
    }),
  }),
  openBrowser: defineOperation({
    ns: 'web', name: 'openBrowser',
    help: 'A browser for connectBrowser. Chrome: kept across programs and turns until closed or idle 20 min; liveView lets the owner watch or take over (a login, a captcha), so give it to them; lab enables the page\'s WebMCP tools. Kitesurf: lighter, with WebMCP; each connect starts a browser that ends with its program, and it has no Live View.',
    impact: 'execute', availability: 'code', slate: false,
    input: v.strictObject({ browser: v.optional(described(v.picklist(['chrome', 'kitesurf']), 'Default chrome.')), lab: v.optional(described(v.boolean(), 'Chrome only.')) }),
    output: v.strictObject({ id: v.string(), liveView: v.nullable(v.string()) }),
  }),
  browsers: defineOperation({
    ns: 'web', name: 'browsers', help: 'Your open Chrome sessions.', impact: 'observe', availability: 'code', slate: false,
    input: v.strictObject({}), output: v.array(SessionView),
  }),
  closeBrowser: defineOperation({
    ns: 'web', name: 'closeBrowser', help: 'Close a Chrome session.', impact: 'mutate', availability: 'code', slate: false,
    input: v.strictObject({ id: v.pipe(v.string(), v.nonEmpty()) }), output: v.null(),
  }),
} as const;
