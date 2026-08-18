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

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'puppeteer';

import { withGallery } from './gallery-harness';

const REPO = join(import.meta.dir, '..');

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


async function shoot(
  browser: Browser,
  origin: string,
  frame: string,
  mode: 'dark' | 'light',
  size: (typeof WIDTHS)[number],
): Promise<string> {
  const page = await browser.newPage();
  await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 2 });
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

  await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
  // React renders after the RPC stubs resolve; the mock is async.
  await Bun.sleep(600);
  // The wall clock is pinned above; the ANIMATION clock was not, so a blinking
  // streaming caret is simply absent from half of all captures and a shimmer
  // lands at a random phase. Rewinding every running animation to its first
  // frame makes a shot a pure function of the code here too — and for a caret
  // the first frame is the on-phase, which is the state worth photographing.
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      animation.currentTime = 0;
      animation.pause();
    }
  });
  const path: `${string}.png` = `${join(outDir, `${frame}-${size.name}-${mode}`)}.png`;
  await page.screenshot({ path, fullPage: true });
  await page.close();
  if (failures.length > 0) console.warn(`  ! ${frame}/${mode} console errors:\n    ${failures.join('\n    ')}`);
  return path;
}

mkdirSync(outDir, { recursive: true });
await withGallery(async ({ browser, origin }) => {
  for (const frame of frames) {
    for (const size of WIDTHS) {
      for (const mode of ['dark', 'light'] as const) {
        console.log(`wrote ${await shoot(browser, origin, frame, mode, size)}`);
      }
    }
  }
});
