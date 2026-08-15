#!/usr/bin/env bun
/**
 * Screenshot gallery frames in both themes.
 *
 * The gallery (`packages/cf-backend/gallery.html`) renders the real signed-in
 * components against mock data with no worker and no auth, which makes it the
 * only place a work surface can be photographed deterministically. This boots
 * its vite server, visits each frame twice — once per `data-mode` — and writes
 * PNGs.
 *
 * The theme is an attribute on <html> set pre-paint from localStorage, so
 * emulating `prefers-color-scheme` is not enough; the mode is seeded into
 * localStorage before the document loads.
 *
 *   bun run scripts/screenshot-gallery.ts views viewblocks
 *   bun run scripts/screenshot-gallery.ts --out /tmp/shots views
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer';

const REPO = join(import.meta.dir, '..');
const CF = join(REPO, 'packages', 'cf-backend');

/** A free port, starting at the usual one.
 *
 *  Not a nicety: several worktrees of this repo are normally checked out at
 *  once, and a fixed port means the second run's vite fails to bind, `waitForServer`
 *  succeeds against the FIRST worktree's server, and the shots are of somebody
 *  else's code — silently, with the frame names you asked for. */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 50; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`no free port in ${from}..${from + 50}`);
}

const PORT = await freePort(5199);

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex === -1 ? join(REPO, 'docs', 'screenshots', 'gallery') : args[outIndex + 1]!;
const frames = args.filter((a, i) => !a.startsWith('--') && i !== outIndex + 1);
if (frames.length === 0) frames.push('views');
/** Both widths unless `--desktop`: a three-column shell and a phone are
 *  different designs, and only one of them is ever looked at by default. */
const WIDTHS = args.includes('--desktop')
  ? ([{ name: 'desktop', width: 1280, height: 1100 }] as const)
  : ([{ name: 'desktop', width: 1280, height: 1100 }, { name: 'mobile', width: 390, height: 844 }] as const);

function chromePath(): string | undefined {
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`gallery server never came up at ${url}`);
}

async function shoot(
  browser: Browser,
  frame: string,
  mode: 'dark' | 'light',
  size: (typeof WIDTHS)[number],
): Promise<string> {
  const page = await browser.newPage();
  await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 2 });
  const url = `http://127.0.0.1:${PORT}/gallery.html?frame=${frame}`;
  await page.evaluateOnNewDocument((m: string) => {
    localStorage.setItem('theme', m);
    // The mocks date themselves off the clock ("9:07 PM", "Active 2h ago"), so
    // two runs minutes apart differ in text that has nothing to do with the
    // change under review, and a before/after diff of the gallery is unreadable
    // noise. Pinning the clock makes a frame a pure function of the code.
    const FIXED = 1_770_000_000_000;
    const pinnedDate = new Proxy(Date, {
      construct: (target, args, newTarget) =>
        Reflect.construct(target, args.length === 0 ? [FIXED] : args, newTarget),
    });
    Object.defineProperty(pinnedDate, 'now', { value: () => FIXED });
    globalThis.Date = pinnedDate;
  }, mode);
  const failures: string[] = [];
  page.on('pageerror', (err) => failures.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') failures.push(msg.text()); });

  await page.goto(url, { waitUntil: 'networkidle0' });
  // React renders after the RPC stubs resolve; the mock is async.
  await new Promise((r) => setTimeout(r, 600));
  const path: `${string}.png` = `${join(outDir, `${frame}-${size.name}-${mode}`)}.png`;
  await page.screenshot({ path, fullPage: true });
  await page.close();
  if (failures.length > 0) console.warn(`  ! ${frame}/${mode} console errors:\n    ${failures.join('\n    ')}`);
  return path;
}

const server = spawn(
  'bunx', ['vite', 'dev', '--config', 'gallery.vite.config.ts', '--port', String(PORT)],
  { cwd: CF, stdio: 'ignore' },
);

try {
  mkdirSync(outDir, { recursive: true });
  await waitForServer(`http://127.0.0.1:${PORT}/gallery.html`);
  const executablePath = chromePath();
  const launchOptions: LaunchOptions = {
    // Headless Chrome reports no pointing device, so `(hover: hover)` and
    // `(pointer: fine)` are both false and every `hover:` utility Tailwind
    // emits behind them is dead in a capture. Declaring the mouse restores
    // the states a desktop user actually sees.
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2',
    ],
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await puppeteer.launch(launchOptions);
  try {
    for (const frame of frames) {
      for (const size of WIDTHS) {
        for (const mode of ['dark', 'light'] as const) {
          console.log(`wrote ${await shoot(browser, frame, mode, size)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
