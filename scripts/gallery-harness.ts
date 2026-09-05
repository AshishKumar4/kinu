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

import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer, { type Browser, type LaunchOptions, type Page } from 'puppeteer';
import { build } from 'vite';
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
 * Console output that is not a diagnostic line (the product's own prose) does
 * not parse and is not collected.
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

/** The one built artifact this process serves. Built lazily on the first
 *  `withGallery` and shared by every later call: the whole point is that a
 *  gate photographs an immutable snapshot of the sources as they were when
 *  the build ran, so two gates in one process MUST see the same bytes. The
 *  directory outlives each call's `finally` for exactly that reason and is
 *  removed when the process exits. */
let galleryDist: Promise<string> | null = null;

/** `kinu-gallery-dist-<pid>-<random>`. The owner's pid is in the name so a
 *  later run can tell a live sibling's build from a leaked one. */
const DIST_NAME = /^kinu-gallery-dist-(\d+)-/;

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
export function reclaimLeakedBuilds(): number {
  let removed = 0;
  for (const name of readdirSync(tmpdir())) {
    const owner = DIST_NAME.exec(name)?.[1];
    if (owner === undefined) continue;
    const pid = Number(owner);
    if (pid === process.pid || processAlive(pid)) continue;
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
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
    const outDir = mkdtempSync(join(tmpdir(), `kinu-gallery-dist-${String(process.pid)}-`));
    process.once('exit', () => rmSync(outDir, { recursive: true, force: true }));
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

/** Run `body` against a live gallery, then tear the server and browser down
 *  in one finally. The HTTP server binds port 0 — the kernel selects and
 *  binds in one syscall, so another gate cannot claim the port between a
 *  probe and a later listen — and serves only the finished build output:
 *  every response is a file that existed before the browser launched. */
export async function withGallery<T>(body: (gallery: Gallery) => Promise<T>): Promise<T> {
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
  }
}
