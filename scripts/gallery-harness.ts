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
 * Two scripts need that browser now (screenshots, computed-style), and the
 * lifecycle they need is identical: let the OS atomically assign a port,
 * start Vite in this process, launch one Chrome, and close both in one finally.
 * No probe-then-bind gap exists, so concurrent worktrees cannot select one port
 * and silently photograph whichever server won the race.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type LaunchOptions, type Page } from 'puppeteer';
import { createServer as createViteServer } from 'vite';
import * as v from 'valibot';
import { tolerate } from '@kinu.run/core/obs';

const REPO = join(import.meta.dir, '..');
const CF = join(REPO, 'packages', 'cf-backend');
const TcpAddressSchema = v.object({
  port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)),
});

export interface Gallery {
  readonly browser: Browser;
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
 * Console output that is not a diagnostic line (Vite's banner, the product's
 * own prose) does not parse and is not collected.
 */
export function recordDiagnostics(page: Page): DiagnosticLine[] {
  const lines: DiagnosticLine[] = [];
  page.on('console', (message) => {
    const parsed = v.safeParse(
      DiagnosticLineSchema,
      tolerate(() => JSON.parse(message.text()), 'malformed-input'),
    );
    if (parsed.success) lines.push(parsed.output);
  });
  return lines;
}

/** Wait for at least `count` collected diagnostics: the console relay is
 *  asynchronous, so a click's diagnostic lands a beat after its DOM effect.
 *  Fails naming what DID arrive rather than timing out silently. */
export async function diagnosticsSettled(
  lines: readonly DiagnosticLine[], count: number, timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (lines.length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `waited ${String(timeoutMs)}ms for ${String(count)} diagnostic(s); saw ${JSON.stringify(lines)}`,
      );
    }
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 50);
    await tick.promise;
  }
}


function chromePath(): string | undefined {
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Run `body` against a live gallery, then tear both halves down whatever
 *  happens. Vite runs as middleware behind a Node server that binds port 0.
 *  The kernel selects and binds that port in one syscall, so another gate
 *  cannot claim it between a probe and a later Vite spawn. Each run also owns
 *  a dependency cache; concurrent Vite optimizers never rewrite one tree. */
export async function withGallery<T>(body: (gallery: Gallery) => Promise<T>): Promise<T> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'kinu-gallery-vite-'));
  try {
    const http = createHttpServer();
    const vite = await createViteServer({
      root: CF,
      cacheDir,
      configFile: join(CF, 'gallery.vite.config.ts'),
      configLoader: 'runner',
      appType: 'spa',
      server: { middlewareMode: true, hmr: { server: http } },
    });
    http.on('request', (request, response) => {
      vite.middlewares(request, response, () => {
        response.statusCode = 404;
        response.end();
      });
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
      const executablePath = chromePath();
      const launchOptions: LaunchOptions = {
        // Headless Chrome reports no pointing device, so `(hover: hover)` and
        // `(pointer: fine)` are both false and every `hover:` utility Tailwind
        // emits behind them is dead. Declaring the mouse restores desktop states.
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2',
        ],
      };
      if (executablePath) launchOptions.executablePath = executablePath;
      const browser = await puppeteer.launch(launchOptions);
      try {
        return await body({ browser, origin });
      } finally {
        await browser.close();
      }
    } finally {
      const closed = Promise.withResolvers<void>();
      http.close((error) => error === undefined ? closed.resolve() : closed.reject(error));
      await closed.promise;
      await vite.close();
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
