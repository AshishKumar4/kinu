/**
 * The living background behind the signed-in shell, in a real browser.
 *
 * The shipped `Layout` mounts it under `?frame=app&path=…`: a connectome on a
 * fixed canvas behind the rail and the page, invisible to the pointer, still
 * for a reduced-motion visitor and for a phone, absent where a transcript
 * would be, and following the overview read model through idle, working and
 * the attention a waiting decision earns.
 *
 * What it cannot see, it leaves to the unit tiers: the tissue's own numbers
 * (packages/core/tests/unit-connectome.test.ts) and the renderers' reads of
 * them (packages/cf-backend/tests/unit-connectome-renderers.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';
import type { JsonValue } from '@kinu.run/core';

import { withGallery, type Gallery } from './gallery-harness';

const SHOTS = '/home/mrwhite0racle/kinu-logs/app-background/ux';

mkdirSync(SHOTS, { recursive: true });

/** The five names the stock gallery roster displays, in card order. */
const DISPLAYED = ['checkout-fixes', 'perf-audit', 'email-triage', 'design-sys', 'handwrought-walnut-4166c321'];

interface BackgroundHandle {
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  time(): number;
  mode(): 'idle' | 'working' | 'attention';
}

declare global {
  interface Window {
    __kinuAppBackground?: BackgroundHandle;
  }
}

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light' | null = 'dark'): Promise<Page> {
  const page = await gallery.browser.newPage();

  if (theme !== null) {
    await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  }

  await page.goto(`${gallery.origin}/gallery.html?frame=app${query}`, { waitUntil: 'networkidle0' });

  return page;
}

/** The handle the shell leaves on window, once a renderer took the canvas. */
async function liveBackground(page: Page, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(
    () => window.__kinuAppBackground !== undefined && window.__kinuAppBackground.renderer() !== 'pending',
    { timeout: timeoutMs },
  );
}

/** One workspace's next overview answer, in the tagged shape the fixture expects. */
async function setOverview(page: Page, name: string, body: JsonValue): Promise<void> {
  await page.evaluate((target, value) => {
    window.dispatchEvent(new CustomEvent('gallery:overview', { detail: { name: target, outcome: { kind: 'body', body: value } } }));
  }, name, body);
}

/** An idle overview row at this instant. */
function idleBody(): JsonValue {
  return { observedAt: Date.now(), activity: 'idle', decisionsWaiting: 0, hasUpdates: false, latestRun: null };
}

/** The mode the tissue reports, with the read model's poll behind it. */
async function waitForMode(page: Page, mode: string, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(
    (wanted) => window.__kinuAppBackground?.mode() === wanted,
    { timeout: timeoutMs, polling: 100 },
    mode,
  );
}

/* The pauses below measure the page's own rAF clock over real wall time —
 *  the thing under test is that Chromium's loop stopped (or resumed) across
 *  an actual interval, and nothing a fake timer could reach lives in this
 *  process: the clock belongs to a real browser driven over CDP. */
function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);

  return promise;
}

describe('the living background', () => {
  test('sits behind the rail and the page, untouchable', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&path=/');

      try {
        await page.setViewport({ width: 1440, height: 900 });
        await liveBackground(page);

        const host = await page.evaluate(() => {
          const el = document.querySelector('[data-app-background]');

          if (el === null) return null;
          const style = getComputedStyle(el);
          const canvas = el.querySelector('canvas');
          const box = canvas?.getBoundingClientRect() ?? null;

          return {
            pointerEvents: style.pointerEvents,
            zIndex: style.zIndex,
            canvasBox: box === null ? null : { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
          };
        });

        if (host === null) throw new Error('no [data-app-background] host');
        expect(host.pointerEvents).toBe('none');
        expect(Number(host.zIndex)).toBeLessThan(0);
        expect(host.canvasBox).not.toBeNull();
        expect(host.canvasBox?.left ?? 1).toBeLessThanOrEqual(0);
        expect(host.canvasBox?.top ?? 1).toBeLessThanOrEqual(0);
        expect(host.canvasBox?.right ?? 0).toBeGreaterThanOrEqual(host.innerWidth);
        expect(host.canvasBox?.bottom ?? 0).toBeGreaterThanOrEqual(host.innerHeight);

        const hits = await page.evaluate(() => {
          const hostEl = document.querySelector('[data-app-background]');
          const canvasEl = hostEl?.querySelector('canvas') ?? null;
          const h1 = document.querySelector('main h1');
          const link = document.querySelector('aside a[href^="/workspace/"]');

          const at = (el: Element | null): Element | null => {
            if (el === null) return null;
            const rect = el.getBoundingClientRect();

            return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          };

          const under = (hit: Element | null, inside: Element | null): boolean =>
            hit !== null && inside !== null && (hit === inside || inside.contains(hit));

          const onHost = (hit: Element | null): boolean =>
            hit !== null && (hit === hostEl || hit === canvasEl || hostEl?.contains(hit) === true);

          const h1Hit = at(h1);
          const linkHit = at(link);

          return {
            h1Found: h1 !== null,
            h1Under: under(h1Hit, h1),
            h1OnHost: onHost(h1Hit),
            linkFound: link !== null,
            linkUnder: under(linkHit, link),
            linkOnHost: onHost(linkHit),
          };
        });

        expect(hits.h1Found).toBe(true);
        expect(hits.h1Under).toBe(true);
        expect(hits.h1OnHost).toBe(false);
        expect(hits.linkFound).toBe(true);
        expect(hits.linkUnder).toBe(true);
        expect(hits.linkOnHost).toBe(false);

        await page.screenshot({ path: join(SHOTS, 'behind-content.png'), fullPage: false });
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('stops its clock while the tab is hidden', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&path=/');

      try {
        await page.setViewport({ width: 1440, height: 900 });
        await liveBackground(page);

        const before = await page.evaluate(() => window.__kinuAppBackground?.time() ?? -1);

        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await pause(800);

        const hidden = await page.evaluate(() => window.__kinuAppBackground?.time() ?? -1);
        expect(hidden - before).toBeLessThanOrEqual(0.1);

        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await pause(800);

        const shown = await page.evaluate(() => window.__kinuAppBackground?.time() ?? -1);
        expect(shown - hidden).toBeGreaterThanOrEqual(0.4);
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('a reduced-motion visitor gets one still frame', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.browser.newPage();
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.evaluateOnNewDocument(() => localStorage.setItem('theme', 'dark'));

      try {
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`${gallery.origin}/gallery.html?frame=app&path=/`, { waitUntil: 'networkidle0' });
        await liveBackground(page);

        const renderer = await page.evaluate(() => window.__kinuAppBackground?.renderer());
        expect(renderer).toBe('static');

        const tagged = await page.evaluate(() =>
          document.querySelector('[data-app-background] canvas')?.getAttribute('data-renderer') ?? null);

        expect(tagged).toBe('static');

        const before = await page.evaluate(() => window.__kinuAppBackground?.time() ?? -1);
        await pause(1000);
        const after = await page.evaluate(() => window.__kinuAppBackground?.time() ?? -1);
        expect(after).toBe(before);

        await page.screenshot({ path: join(SHOTS, 'reduced-motion.png'), fullPage: false });
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('a phone gets the same still', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.browser.newPage();
      await page.evaluateOnNewDocument(() => localStorage.setItem('theme', 'dark'));

      try {
        await page.setViewport({ width: 390, height: 844 });
        await page.goto(`${gallery.origin}/gallery.html?frame=app&path=/`, { waitUntil: 'networkidle0' });
        await liveBackground(page);

        const renderer = await page.evaluate(() => window.__kinuAppBackground?.renderer());
        expect(renderer).toBe('static');

        await page.screenshot({ path: join(SHOTS, 'phone.png'), fullPage: false });
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('never mounts where a transcript would be', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&path=/workspace/checkout-fixes');

      try {
        await page.setViewport({ width: 1440, height: 900 });
        // Let the frame settle: the route's blank element is its content.
        await page.waitForSelector('[data-gallery-blank]', { timeout: 20_000 });
        await pause(300);

        const absent = await page.evaluate(() => ({
          host: document.querySelector('[data-app-background]') === null,
          handle: window.__kinuAppBackground === undefined,
        }));

        expect(absent.host).toBe(true);
        expect(absent.handle).toBe(true);
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('follows the overview read model through idle, working and attention', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&path=/');

      try {
        await page.setViewport({ width: 1440, height: 900 });
        await liveBackground(page);

        // Quiet every workspace; the 5s poll cadence carries it to the tissue.
        for (const name of DISPLAYED) await setOverview(page, name, idleBody());
        await waitForMode(page, 'idle');

        // Everyone working at once.
        for (const name of DISPLAYED) {
          await setOverview(page, name, {
            observedAt: Date.now(), activity: 'working', decisionsWaiting: 0, hasUpdates: false, latestRun: null,
          });
        }

        await waitForMode(page, 'working');

        // One decision waiting: a flash, then back under the working hum.
        await setOverview(page, 'checkout-fixes', {
          observedAt: Date.now(), activity: 'working', decisionsWaiting: 1, hasUpdates: false, latestRun: null,
        });
        await waitForMode(page, 'attention');
        await waitForMode(page, 'working', 3_000);

        await page.screenshot({ path: join(SHOTS, 'following.png'), fullPage: false });
      } finally {
        await page.close();
      }
    });
  }, 90_000);
});
