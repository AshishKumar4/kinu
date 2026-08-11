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
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';

const REPO = join(import.meta.dir, '..');
const CF = join(REPO, 'packages', 'cf-backend');
const PORT = 5199;

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex === -1 ? join(REPO, 'docs', 'screenshots', 'gallery') : args[outIndex + 1]!;
const frames = args.filter((a, i) => !a.startsWith('--') && i !== outIndex + 1);
if (frames.length === 0) frames.push('views');

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

async function shoot(browser: Browser, frame: string, mode: 'dark' | 'light'): Promise<string> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100, deviceScaleFactor: 2 });
  const url = `http://127.0.0.1:${PORT}/gallery.html?frame=${frame}`;
  await page.evaluateOnNewDocument((m: string) => {
    localStorage.setItem('theme', m);
  }, mode);
  const failures: string[] = [];
  page.on('pageerror', (err) => failures.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') failures.push(msg.text()); });

  await page.goto(url, { waitUntil: 'networkidle0' });
  // React renders after the RPC stubs resolve; the mock is async.
  await new Promise((r) => setTimeout(r, 600));
  const path = join(outDir, `${frame}-${mode}.png`);
  await page.screenshot({ path: path as `${string}.png`, fullPage: true });
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
  const browser = await puppeteer.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    for (const frame of frames) {
      for (const mode of ['dark', 'light'] as const) {
        console.log(`wrote ${await shoot(browser, frame, mode)}`);
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
