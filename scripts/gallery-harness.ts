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
 * lifecycle they need is identical and entirely non-obvious: pick a port that
 * is free in THIS worktree, spawn vite, wait for it to answer, find a Chrome,
 * and declare a pointing device so `hover:` utilities are not silently dead.
 * All of it is here so neither caller carries it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer';

const REPO = join(import.meta.dir, '..');
const CF = join(REPO, 'packages', 'cf-backend');

export interface Gallery {
  readonly browser: Browser;
  /** `http://127.0.0.1:<port>` — this run's server, never another worktree's. */
  readonly origin: string;
}

/** A free port, starting at the usual one.
 *
 *  Not a nicety: several worktrees of this repo are normally checked out at
 *  once, and a fixed port means the second run's vite fails to bind, the
 *  readiness probe succeeds against the FIRST worktree's server, and the run
 *  reports on somebody else's code — silently, under the names you asked for. */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 50; port++) {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
    const free = await promise;
    if (free) return port;
  }
  throw new Error(`no free port in ${from}..${from + 50}`);
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  throw new Error(`gallery server never came up at ${url}`);
}

function chromePath(): string | undefined {
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Run `body` against a live gallery, then tear both halves down whatever
 *  happens. The server and the browser are never handed out separately: a
 *  caller that could forget one is a caller that leaves a vite process on a
 *  port the next run will then avoid. */
export async function withGallery<T>(body: (gallery: Gallery) => Promise<T>): Promise<T> {
  const port = await freePort(5199);
  const server = spawn(
    'bunx', ['vite', 'dev', '--config', 'gallery.vite.config.ts', '--port', String(port)],
    { cwd: CF, stdio: 'ignore' },
  );
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitForServer(`${origin}/gallery.html`);
    const executablePath = chromePath();
    const launchOptions: LaunchOptions = {
      // Headless Chrome reports no pointing device, so `(hover: hover)` and
      // `(pointer: fine)` are both false and every `hover:` utility Tailwind
      // emits behind them is dead. Declaring the mouse restores the states a
      // desktop user actually sees.
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
    server.kill();
  }
}
