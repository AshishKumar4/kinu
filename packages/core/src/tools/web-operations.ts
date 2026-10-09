/** The web operations served over a search provider and browser sessions, natively and as `web.*`. */
import { Effect } from 'effect';
import * as v from 'valibot';
import type { BrowserSessions, WebSearchProvider } from '../web/provider';
import { saveScreenshot } from '../web/screenshots';
import { bytesToBase64 } from '../utils/base64';
import type { Storage } from '../types/primitives';
import type { CodemodeProvider } from '../types/codemode';
import { attemptInItsWords, KinuError, settle } from '../obs/index';
import { requireBuild } from '../execution/work-mode';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace } from './operation-surfaces';
import { KITESURF_SESSION_ID, WEB } from '../operations/web';

export interface WebDeps {
  readonly provider: WebSearchProvider;
  /** Where a screenshot is saved; null on a slate, where a visitor writes nothing into the workspace. */
  readonly files: Pick<Storage, 'vfs' | 'home'> | null;
  /** Absent on a slate, and where no browser is reachable: the session operations are not served. */
  readonly sessions?: BrowserSessions;
}

export function serveWeb({ provider, files, sessions }: WebDeps): readonly Served[] {
  const reached = <A>(run: () => Promise<A>) => attemptInItsWords('unavailable', run);

  const served = [
    serve(WEB.search, ({ query, limit }, { signal }) => reached(() => provider.search(query, { ...(limit !== undefined && { limit }), ...(signal !== undefined && { signal }) }))),
    serve(WEB.fetch, ({ url, render, engine }, { signal }) => {
      if (engine !== undefined && render !== true) return Effect.fail(new KinuError('bad_input', 'web.fetch: `engine` applies to a rendered fetch; add `render: true`'));

      return reached(() => (render === true ? provider.render(url, { engine, signal }) : provider.fetch(url, { signal })));
    }),
    serve(WEB.screenshot, ({ url, fullPage, engine }, { signal }) => Effect.gen(function* () {
      const shot = yield* reached(() => provider.screenshot(url, { fullPage: fullPage === true, engine, signal }));
      const dataUrl = fullPage === true ? {} : { dataUrl: `data:image/png;base64,${bytesToBase64(shot.bytes)}` };

      if (files === null) return { url: shot.url, retrievedAt: shot.retrievedAt, ...dataUrl };
      requireBuild('web.screenshot');

      return { url: shot.url, retrievedAt: shot.retrievedAt, path: yield* reached(() => saveScreenshot(files, shot)), ...dataUrl };
    })),
  ];

  if (sessions === undefined) return served;

  return [
    ...served,
    serve(WEB.openBrowser, ({ browser = 'chrome', lab = false }) => {
      // Chrome by default: only a Chrome session outlives its connection, keeps a Live View, and reconnects by id.
      if (browser === 'chrome') return reached(() => sessions.open({ lab }));

      if (lab) return Effect.fail(new KinuError('bad_input', 'web.openBrowser: `lab` is a Chrome option; Kitesurf has WebMCP already'));

      return Effect.succeed({ id: KITESURF_SESSION_ID, liveView: null });
    }),
    serve(WEB.browsers, () => reached(() => sessions.list())),
    serve(WEB.closeBrowser, ({ id }) => reached(() => sessions.close(id)).pipe(Effect.as(null))),
  ];
}

/** What the sandbox half of a browser member hands its host member when it fails (cf-backend `browser-prelude.ts`). */
const SandboxRefusalSchema = v.object({ refused: v.string(), reason: v.picklist(['denied', 'unavailable']) });

/** Members a prelude defines in the sandbox, on objects that never reach the host; declared with puppeteer's types. */
const SANDBOX_MEMBERS = {
  connectBrowser: {
    full: '/** A @cloudflare/puppeteer `Browser` on an `openBrowser` id. `page.accessibility.snapshot()` reads the accessibility tree. */\nconnectBrowser(id: string): Promise<Browser | Refusal>;',
    call: 'connectBrowser(id)',
  },
  pageTools: {
    full: '/** The page\'s WebMCP tools. */\npageTools(page: Page): Promise<Array<{ name: string; description: string; inputSchema: object }> | Refusal>;',
    call: 'pageTools(page)',
  },
  callPageTool: { full: 'callPageTool(page: Page, name: string, input: object): Promise<unknown>;', call: 'callPageTool(page, name, input)' },
} as const;

/**
 * `web.*` for programs. With a prelude, the browser members run in the sandbox; a failure there reaches the host
 * member as a refusal, so the program's census records it as it records a host member's.
 */
export function createWebCodemodeProvider(deps: WebDeps & { readonly prelude?: { readonly source: string } | { readonly missing: string } }): CodemodeProvider {
  const namespace = codemodeNamespace('web', 'Search the web, fetch a page as markdown, take a screenshot, or drive a browser.', serveWeb(deps));
  const { prelude } = deps;

  if (prelude === undefined) return namespace;

  return {
    ...namespace,
    tools: { ...namespace.tools, ...Object.fromEntries(Object.keys(SANDBOX_MEMBERS).map((member) => [member, {
      description: `web.${member} runs in the eval sandbox`,
      execute: async (...args: unknown[]) => {
        const refused = v.safeParse(SandboxRefusalSchema, args[0]);

        return await settle(Effect.fail(refused.success
          ? new KinuError(refused.output.reason, `web.${member}: ${refused.output.refused}`)
          : new KinuError('unsupported', 'missing' in prelude ? prelude.missing : `web.${member} runs only inside an eval program`)));
      },
    }])) },
    declarations: { ...namespace.declarations, ...SANDBOX_MEMBERS },
    ...('source' in prelude && { prelude: prelude.source }),
  };
}
