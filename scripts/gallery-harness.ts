/**
 * Boot the component gallery in a real browser, once, for whoever asks.
 *
 * `packages/cf-backend/gallery.html` renders the real signed-in components
 * against mock data with no worker and no auth. That makes it the only place
 * the product's own CSS can be observed as a browser computes it, rather than
 * as a stylesheet parser reads it — which matters, because the defect that made
 * every `rounded-*` in the app compute to 0px was valid CSS, built clean, and
 * invisible to every non-browser instrument in the repo.
 *
 * The gates consume ONE immutable artifact. Vite's build API runs once per
 * test process into a fresh temp directory, with `gallery.html` and
 * `landing.html` as the inputs — the production build never includes the
 * gallery, and this build never touches `dist/`. Every `withGallery` call then
 * serves that finished output over a plain static file server. A dev server
 * has no place in a gate: HMR turns any mid-run file save into a reload that
 * destroys the execution context a gate is awaiting on, and the dep optimizer
 * forces the same reload on first discovery — both were observed killing
 * gates on this shared tree ("Execution context was destroyed").
 */

import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, watch } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import type { Page } from 'puppeteer';
import { build } from 'vite';
import * as v from 'valibot';
import { tolerate } from '@kinu.run/core/obs';
import { releaseScratch, scratchDir, SCRATCH_ROOT_PREFIX } from '../packages/test-utils/src/scratch';
import { declaredSettings } from './browser-declarations';
import { SILENCE_NOTICE_ENV } from './deadline';
import { launchTestChrome } from './test-chrome';

const REPO = join(import.meta.dir, '..');

const CF = join(REPO, 'packages', 'cf-backend');

const TcpAddressSchema = v.object({
  port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)),
});

export interface Gallery {
  /** A page with no clock: puppeteer's per-page and navigation defaults are 0,
   *  so every `waitFor*` ends on its condition or on the target closing, never
   *  on a duration. A wait that can genuinely hang is killed with the browser
   *  at `withGallery`'s teardown or by the deploy ladder at the gate's
   *  deadline, which names the gate; `gate:test-clocks` refuses a per-call
   *  `{ timeout }` in the suites. */
  readonly newPage: () => Promise<Page>;
  /** `http://127.0.0.1:<port>` — this run's server, never another worktree's. */
  readonly origin: string;
}

/** A classified diagnostic, as the page's `diagnostics` sink writes it to the
 *  console: the JSON envelope `createLineLogger` emits. `cause` is the rendered
 *  chain for a `failure` line and absent for an `event` line. */
export interface DiagnosticLine {
  readonly event: string;
  readonly code?: string;
  readonly cause?: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

const DiagnosticLineSchema = v.object({
  event: v.string(),
  code: v.optional(v.string()),
  cause: v.optional(v.string()),
  fields: v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
});

/**
 * Collect every classified diagnostic a page emits, in order. The gates over
 * failure handling assert on these: a handled failure must be RECORDED, and the
 * record must carry the whole cause chain — neither is observable in the DOM.
 * Console output that is not a diagnostic line (the product's own prose) does
 * not parse and is not collected.
 */
/** The collected diagnostics, and the wait for a count of them: resolved by
 *  the console relay's own delivery, never by a poll against a clock. */
export type RecordedDiagnostics = DiagnosticLine[] & { readonly settled: (count: number) => Promise<void> };

export function recordDiagnostics(page: Page): RecordedDiagnostics {
  const lines: DiagnosticLine[] = [];
  const waiting: { readonly count: number; readonly resolve: () => void }[] = [];

  page.on('console', (message) => {
    const parsed = v.safeParse(
      DiagnosticLineSchema,
      tolerate(() => JSON.parse(message.text()), 'malformed-input'),
    );

    if (!parsed.success) return;
    lines.push(parsed.output);

    for (const waiter of waiting.splice(0)) {
      if (lines.length >= waiter.count) waiter.resolve();
      else waiting.push(waiter);
    }
  });

  return Object.assign(lines, {
    settled: (count: number): Promise<void> => {
      if (lines.length >= count) return Promise.resolve();
      const { promise, resolve: settle } = Promise.withResolvers<void>();
      waiting.push({ count, resolve: settle });

      return promise;
    },
  });
}

/** Wait for at least `count` collected diagnostics: the console relay is
 *  asynchronous, so a click's diagnostic lands a beat after its DOM effect.
 *  An end condition on the relay's own delivery; a diagnostic that never
 *  arrives is a hang the ladder's deadline ends and names. */
export function diagnosticsSettled(lines: RecordedDiagnostics, count: number): Promise<void> {
  return lines.settled(count);
}

export interface Rgba { readonly r: number; readonly g: number; readonly b: number; readonly a: number }

/** A computed `color`: Chromium serialises sRGB colours as `rgb(…)` or `rgba(…)`. */
export function rgba(computed: string): Rgba {
  const channels = /^rgba?\(([^)]+)\)$/u.exec(computed)?.[1]?.split(',').map((part) => Number(part.trim()));

  if (channels === undefined || channels.length < 3 || channels.some(Number.isNaN)) {
    throw new Error(`not an sRGB computed colour: ${computed}`);
  }

  const [r = 0, g = 0, b = 0, a = 1] = channels;

  return { r, g, b, a };
}

export const over = (ink: Rgba, paper: Rgba): Rgba => ({
  r: ink.r * ink.a + paper.r * (1 - ink.a),
  g: ink.g * ink.a + paper.g * (1 - ink.a),
  b: ink.b * ink.a + paper.b * (1 - ink.a),
  a: 1,
});

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const unit = value / 255;

    return unit <= 0.040_45 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG's contrast ratio of `ink` laid over `paper`. */
export function contrast(ink: Rgba, paper: Rgba): number {
  const light = luminance(over(ink, paper));
  const dark = luminance(paper);

  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

/**
 * Runs inside the page, so it closes over nothing: `page.evaluate(unruledClasses, scope, family, markers)`.
 * Each class the elements matching `scope` carry, with `family` in its name, that no rule in the page's
 * stylesheets selects. Tailwind generates only the utilities its sources reach, so a vendor component
 * whose `@source` matched nothing carries classes that paint nothing. `markers` are classes a library
 * uses as handles, never as styles.
 */
export function unruledClasses(scope: string, family: string, markers: readonly string[]): string[] {
  const selectors: string[] = [];

  const walk = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) selectors.push(rule.selectorText);

      if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
    }
  };

  for (const sheet of document.styleSheets) walk(sheet.cssRules);

  // `.bg-kumo-base/90` is another class than `.bg-kumo-base`: a selected name ends at an identifier boundary.
  const selects = (selector: string, name: string): boolean => {
    const needle = `.${CSS.escape(name)}`;

    for (let at = selector.indexOf(needle); at !== -1; at = selector.indexOf(needle, at + 1)) {
      if (!/^[\w\\-]/u.test(selector.slice(at + needle.length))) return true;
    }

    return false;
  };

  const classes = new Set([...document.querySelectorAll(scope)]
    .flatMap((element) => [...element.classList].filter((name) => name.includes(family) && !markers.includes(name))));

  return [...classes].filter((name) => !selectors.some((selector) => selects(selector, name)));
}

/** The conditions pages are being waited on, so a run ended mid-wait names them. No page wait has a clock; a
 *  condition that never arrives is reported when the row's runner says its silence nears the bound
 *  (`SILENCE_NOTICE_ENV`), and ended by the row's bound, and each prints what it knows. A page opened on
 *  `gallery.browser` directly, not through `newPage`, records nothing. */
interface OpenWait {
  readonly condition: string;
  readonly page: Page;
  /** The page's requests sent and not yet answered, by URL. */
  readonly requests: ReadonlySet<string>;
  reported: boolean;
  /** The page was asked what it shows and has not answered. */
  asking: boolean;
}

const pendingWaits = new Set<OpenWait>();

/** `wait`, with `condition` recorded while it is open. */
async function recorded<T>(open: Omit<OpenWait, 'reported' | 'asking'>, wait: () => Promise<T>): Promise<T> {
  const entry: OpenWait = { ...open, reported: false, asking: false };

  pendingWaits.add(entry);

  try {
    return await wait();
  } finally {
    pendingWaits.delete(entry);
  }
}

/** Whether puppeteer's generic "Waiting for selector … failed" was the page going away under the wait. */
function detachedCause(error: Error): boolean {
  for (let link: unknown = error.cause; link instanceof Error; link = link.cause) {
    if (link.name === 'TargetCloseError' || link.message.includes('Frame detached')) return true;
  }

  return false;
}

const STUCK_SHOTS = join(REPO, '..', 'kinu-logs', 'gallery-stuck');

let stuckShots = 0;

/**
 * Writes what a stuck wait's page shows: first what the harness knows without the page, then what the page answers.
 * A page whose script never yields never answers, and the first line says the question is open, so the log reads
 * the same whether the page is busy, paused, or slow.
 */
async function reportStuck(open: OpenWait): Promise<void> {
  open.reported = true;
  open.asking = true;
  const requests = open.requests.size === 0 ? 'none' : [...open.requests].join(', ');

  process.stderr.write(`gallery-harness: stuck on ${open.condition}; open requests: ${requests}; asking the page what it shows\n`);

  const view = await open.page.evaluate(() => ({
    readyState: document.readyState,
    elements: document.querySelectorAll('*').length,
    headings: [...document.querySelectorAll('h1, h2, [role="alert"]')].map((node) => node.textContent?.trim() ?? '').slice(0, 6),
    text: (document.body?.innerText ?? '').replace(/\s+/gu, ' ').slice(0, 300),
  })).then((facts) => facts, (...rejection: [unknown]) => ({ unread: String(rejection[0]) }));

  mkdirSync(STUCK_SHOTS, { recursive: true });
  stuckShots += 1;
  const shot = join(STUCK_SHOTS, `${String(process.pid)}-${String(stuckShots)}.png`);
  const taken = await open.page.screenshot({ path: shot }).then(() => shot, () => 'none');

  open.asking = false;

  process.stderr.write('unread' in view
    ? `gallery-harness: the page could not be read (${open.condition}): ${view.unread}; screenshot: ${taken}\n`
    : `gallery-harness: the page shows (${open.condition}): readyState: ${view.readyState}, elements: ${String(view.elements)}, `
      + `headings: ${JSON.stringify(view.headings)}, text: ${JSON.stringify(view.text)}, screenshot: ${taken}\n`);
}

/** The one built artifact this process serves. Built lazily on the first
 *  `withGallery` and shared by every later call: the whole point is that a
 *  gate photographs an immutable snapshot of the sources as they were when
 *  the build ran, so two gates in one process MUST see the same bytes. The
 *  directory outlives each call's `finally` for exactly that reason and is
 *  removed when the process exits. */
let galleryDist: Promise<string> | null = null;

/** The owner's pid is in the shared scratch name so a
 *  later run can tell a live sibling's build from a leaked one. */
const DIST_NAME = new RegExp(`^${SCRATCH_ROOT_PREFIX}gallery-dist-(\\d+)-`);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Remove the builds of owners that are gone. The `exit` handler below removes
 * this process's own build, and it never runs when the process is killed:
 * a suite past its deadline, a hook past its wall, a worker its parent
 * reaped. Sixty-one of those builds, 71 MiB each, sat under /tmp on
 * 2026-09-05 and exhausted the user's tmpfs quota, which turned `bun run
 * check` red for every checkout on the box. Reclaiming by liveness rather
 * than by age is what lets the next build clean up after a killed one at
 * once, and a build whose owner is still running is left alone.
 */
export function reclaimLeakedBuilds(directory = tmpdir()): number {
  let removed = 0;

  for (const name of readdirSync(directory)) {
    const owner = DIST_NAME.exec(name)?.[1];

    if (owner === undefined) continue;
    const pid = Number(owner);

    if (pid === process.pid || processAlive(pid)) continue;
    rmSync(join(directory, name), { recursive: true, force: true });
    removed += 1;
  }

  return removed;
}

function builtGalleryDist(): Promise<string> {
  galleryDist ??= (async () => {
    const leaked = reclaimLeakedBuilds();

    if (leaked > 0) {
      process.stderr.write(`gallery-harness: removed ${String(leaked)} build(s) left by processes that are gone\n`);
    }

    const outDir = scratchDir(`gallery-dist-${String(process.pid)}`);
    process.once('exit', releaseScratch);
    await build({
      root: CF,
      configFile: join(CF, 'gallery.vite.config.ts'),
      configLoader: 'runner',
      logLevel: 'error',
      build: {
        outDir,
        emptyOutDir: true,
        // The gallery is a TEST input, included only here. The production
        // build (vite.config.ts, driven by scripts/deploy.sh) never names it,
        // so the signed-in component gallery cannot ship.
        rollupOptions: {
          input: {
            gallery: join(CF, 'gallery.html'),
            landing: join(CF, 'landing.html'),
          },
        },
      },
    });

    return outDir;
  })();

  return galleryDist;
}

/** Total content type projection for the closed set Vite emits. `extname` is
 *  open (an asset can have any suffix), but the server's answers are closed
 *  and the binary fallback is explicit — a switch owns that invariant better
 *  than a lookup table that implies runtime-extensible entries. */
function builtAssetContentType(file: string): string {
  switch (extname(file)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.woff2': return 'font/woff2';
    case '.json':
    case '.map': return 'application/json';
    case '.webp': return 'image/webp';
    case '.png': return 'image/png';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/** The exit code a run ended by SIGTERM reports: 128 + SIGTERM, the shell's
 *  own convention. `runUnderDeadline` overrides it with 124 in the ladder's
 *  transcript; this is what an unwrapped hand run sees. */
const SIGTERM_EXIT_CODE = 143;

export interface GalleryOptions {
  /** Declare a mouse at launch; default true. A touch-only visitor launches
   *  without it (`declaredSettings`). */
  readonly mouse?: boolean;
  /** Launch flags for the one test that needs a capability the default lane
   *  disables (e.g. WebGPU). */
  readonly browserArgs?: string[];
}

/** Run `body` against a live gallery, then tear the server and browser down
 *  entirely. Every route answers one immutable, pre-rendered build of
 *  `gallery-dist` — a frozen artifact, never the dev server — so a page's
 *  every response is a file that existed before the browser launched. */
export async function withGallery<T>(body: (gallery: Gallery) => Promise<T>, options: GalleryOptions = {}): Promise<T> {
  const dist = await builtGalleryDist();

  const http = createHttpServer((request, response) => {
    // Static semantics, GET/HEAD only: the artifact is immutable, and any
    // /api/* traffic a frame produces belongs to the page's own fixtures or
    // to a gate's request interception, never to this server.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();

      return;
    }

    const url = new URL(request.url ?? '/', 'http://gallery.invalid');
    const pathname = decodeURIComponent(url.pathname);
    const file = resolve(dist, `.${pathname === '/' ? '/gallery.html' : pathname}`);

    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404);
      response.end();

      return;
    }

    response.writeHead(200, { 'content-type': builtAssetContentType(file) });

    if (request.method === 'HEAD') {
      response.end();

      return;
    }

    createReadStream(file).pipe(response);
  });

  const listening = Promise.withResolvers<void>();
  http.once('error', listening.reject);
  http.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;

  try {
    const address = v.safeParse(TcpAddressSchema, http.address());

    if (!address.success) {
      throw new Error('gallery HTTP server has no TCP address after listen');
    }

    const origin = `http://127.0.0.1:${String(address.output.port)}`;

    const chrome = await launchTestChrome({
      args: [declaredSettings({ mouse: options.mouse !== false }), ...(options.browserArgs ?? [])],
      onAbandon: () => {
        if (pendingWaits.size > 0) {
          process.stderr.write(`gallery-harness: ended while waiting for ${[...pendingWaits].map((open) => open.condition).join('; ')}\n`);
        }

        for (const open of pendingWaits) {
          if (open.asking) process.stderr.write(`gallery-harness: the page never answered what it shows (${open.condition})\n`);
        }
      },
    });

    const { browser } = chrome;
    const noticePath = process.env[SILENCE_NOTICE_ENV];

    // The row's runner appends a line when its silence nears the bound: each open wait not yet reported says why.
    const notices = noticePath === undefined ? null : watch(noticePath, async () => {
      await Promise.all([...pendingWaits].filter((open) => !open.reported).map(reportStuck));
    });

    // Under `bun test` the preload's own listener ends the process first and the browser goes with its release
    // (test-chrome.ts). Under a bare `bun scripts/…` run (computed-style, plan-demo-film, review-package) there is no
    // preload, and this listener is the whole answer.
    const endOnSignal = (): void => {
      chrome.abandon();
      process.exit(SIGTERM_EXIT_CODE);
    };

    process.on('SIGTERM', endOnSignal);

    const newPage = async (): Promise<Page> => {
      const page = await browser.newPage();
      const waitForSelector = page.waitForSelector.bind(page);
      const waitForFunction = page.waitForFunction.bind(page);
      const goto = page.goto.bind(page);
      const requests = new Set<string>();

      page.on('request', (request) => { requests.add(request.url()); });
      page.on('requestfinished', (request) => { requests.delete(request.url()); });
      page.on('requestfailed', (request) => { requests.delete(request.url()); });

      // Puppeteer answers a renderer crash with an `error` event and nothing else, and a closed tab or a dead browser
      // with events no wait listens to: a wait with no timeout on the page never ends. Every unbounded wait is ended
      // by each of them, so the test fails by the name of what happened instead of going silent.
      let ended: Error | null = null;
      const onEnd = new Set<(cause: Error) => void>();

      const end = (reason: Error, always: boolean): void => {
        if (ended !== null) return;
        ended = reason;

        if (always || onEnd.size > 0) process.stderr.write(`gallery-harness: ${reason.message}\n`);

        for (const stop of onEnd) stop(reason);
      };

      page.once('error', (cause) => { end(new Error(`the page crashed on ${page.url()}`, { cause }), true); });
      page.once('close', () => { end(new Error(`the page closed on ${page.url()}`), false); });
      browser.once('disconnected', () => { end(new Error(`the browser disconnected while on ${page.url()}`), false); });

      const untilEnded = async <Result>(work: Promise<Result>): Promise<Result> => {
        if (ended !== null) throw ended;
        const stopped = Promise.withResolvers<never>();

        onEnd.add(stopped.reject);

        try {
          return await Promise.race([work, stopped.promise]);
        } catch (cause) {
          // Puppeteer ends a wait on a detached page itself, sooner than the events above, with the reason only in
          // the error's `cause`.
          if (ended === null && !browser.connected) throw new Error(`the browser disconnected while on ${page.url()}`, { cause });

          if (ended === null && cause instanceof Error && detachedCause(cause)) throw new Error(`the page closed on ${page.url()}`, { cause });

          throw cause;
        } finally {
          onEnd.delete(stopped.reject);
        }
      };

      page.setDefaultTimeout(0);
      page.setDefaultNavigationTimeout(0);
      page.waitForSelector = async (selector, waitOptions) => recorded(
        { condition: `${selector} on ${page.url()}`, page, requests },
        () => untilEnded(waitForSelector(selector, waitOptions)),
      );
      page.waitForFunction = async (condition, waitOptions, ...args) => recorded(
        { condition: `${String(condition).replace(/\s+/gu, ' ')} on ${page.url()}`, page, requests },
        () => untilEnded(waitForFunction(condition, waitOptions, ...args)),
      );
      page.goto = async (url, gotoOptions) => recorded({ condition: `load of ${url}`, page, requests }, () => untilEnded(goto(url, gotoOptions)));

      return page;
    };

    try {
      return await body({ newPage, origin });
    } finally {
      notices?.close();
      process.off('SIGTERM', endOnSignal);
      await chrome.close();
    }
  } finally {
    const closed = Promise.withResolvers<void>();
    http.close((error) => error === undefined ? closed.resolve() : closed.reject(error));
    await closed.promise;
  }
}
