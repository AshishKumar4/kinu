#!/usr/bin/env bun
/**
 * Screenshot gallery frames in every theme.
 *
 * The gallery (`packages/cf-backend/gallery.html`) renders the real signed-in
 * components against mock data with no worker and no auth, which makes it the
 * only place a work surface can be photographed deterministically. This boots
 * its vite server, visits each frame once per theme, and writes PNGs.
 *
 * The theme is two attributes on <html> set pre-paint from localStorage, so
 * emulating `prefers-color-scheme` is not enough; both axes are seeded into
 * localStorage before the document loads.
 *
 *   bun run scripts/screenshot-gallery.ts views viewblocks
 *   bun run scripts/screenshot-gallery.ts --out /tmp/shots views
 *   bun run scripts/screenshot-gallery.ts --palette silk --desktop forks chat
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'puppeteer';

import { withGallery } from './gallery-harness';

const REPO = join(import.meta.dir, '..');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex === -1 ? join(REPO, 'docs', 'screenshots', 'gallery') : args[outIndex + 1]!;
const frames = args.filter((a, i) => !a.startsWith('--') && i !== outIndex + 1 && args[i - 1] !== '--palette');
if (frames.length === 0) frames.push('views');
/** Both widths unless `--desktop`: a three-column shell and a phone are
 *  different designs, and only one of them is ever looked at by default. */
const WIDTHS = args.includes('--desktop')
  ? ([{ name: 'desktop', width: 1280, height: 1100 }] as const)
  : ([{ name: 'desktop', width: 1280, height: 1100 }, { name: 'mobile', width: 390, height: 844 }] as const);
/** Both palettes unless `--palette` names one. A frame is a different design in
 *  each, not a recolour of the same one, so the default is both. */
const PALETTES = (['umber', 'silk'] as const).filter((p) => {
  const named = args[args.indexOf('--palette') + 1];
  return !args.includes('--palette') || named === p;
});
if (PALETTES.length === 0) throw new Error(`--palette must be umber or silk`);

async function shoot(
  browser: Browser,
  origin: string,
  frame: string,
  theme: { mode: 'dark' | 'light'; palette: 'umber' | 'silk' },
  size: (typeof WIDTHS)[number],
): Promise<string> {
  const page = await browser.newPage();
  await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument((t: { mode: string; palette: string }) => {
    localStorage.setItem('theme', t.mode);
    localStorage.setItem('palette', t.palette);
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
  }, theme);
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
  const label = `${theme.palette}-${theme.mode}`;
  const path: `${string}.png` = `${join(outDir, `${frame}-${size.name}-${label}`)}.png`;
  await page.screenshot({ path, fullPage: true });
  const applied = await page.evaluate(() => ({
    mode: document.documentElement.dataset.mode,
    palette: document.documentElement.dataset.palette,
  }));
  await page.close();
  // A shot named for a theme it is not in is worse than no shot: it is evidence
  // for the wrong claim.
  if (applied.mode !== theme.mode || applied.palette !== theme.palette) {
    throw new Error(`${frame}: asked for ${label}, page rendered ${applied.palette}-${applied.mode}`);
  }
  if (failures.length > 0) console.warn(`  ! ${frame}/${label} console errors:\n    ${failures.join('\n    ')}`);
  return path;
}

mkdirSync(outDir, { recursive: true });
await withGallery(async ({ browser, origin }) => {
  for (const frame of frames) {
    for (const size of WIDTHS) {
      for (const palette of PALETTES) {
        for (const mode of ['dark', 'light'] as const) {
          console.log(`wrote ${await shoot(browser, origin, frame, { mode, palette }, size)}`);
        }
      }
    }
  }
});
