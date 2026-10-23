/**
 * The living background behind the signed-in shell, in a real browser.
 *
 * The shipped `Layout` mounts it under `?frame=app&path=…`: a neural mesh on
 * a fixed canvas behind the rail and the new-workspace page, invisible to the
 * pointer, still for a reduced-motion visitor and for a phone, absent behind
 * any chat (Home is the assistant's), and following the overview read model
 * through idle, working and the attention a waiting decision earns. Quiet
 * (`&background=quiet`), it draws nothing while nothing moves.
 *
 * What it cannot see, it leaves to the unit tier: the tissue's own numbers
 * (packages/core/tests/unit-neural-mesh.test.ts) and the renderer keeping its
 * rest (packages/core/tests/unit-hero-canvas.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';
import type { JsonValue } from '@kinu.run/core';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';
import { evidenceDir } from '@kinu.run/test-utils';

const SHOTS = evidenceDir('app-background/ux');

mkdirSync(SHOTS, { recursive: true });

/** The five names the stock gallery roster displays, in card order. */
const DISPLAYED = ['api-worker', 'perf-audit', 'email-triage', 'design-sys', 'handwrought-walnut-4166c321'];

interface BackgroundHandle {
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  renders(): number;
  settled(): boolean;
  time(): number;
  mode(): 'idle' | 'working' | 'attention';
  pointer(): number;
  /** The stepping controls the GALLERY page attaches (`__kinuGalleryStepping`);
   *  the shipped shell's handle carries none, so these are optional here. */
  advance?(dt: number): void;
}

declare global {
  interface Window {
    __kinuAppBackground?: BackgroundHandle;
    /** Set before the shell mounts: the picture starts frozen at its seed
     *  (`AppBackground.tsx`), so a readback is a pure function of the test's
     *  own steps. */
    __kinuGalleryFrozen?: true;
  }
}

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light' | null = 'dark', frozen = false): Promise<Page> {
  const page = await gallery.newPage();
  // Before the document: a resize after it also switches touch emulation off,
  // which drops the launch's mouse and remounts the picture without a pointer.
  await page.setViewport({ width: 1440, height: 900 });

  if (frozen) {
    await page.evaluateOnNewDocument(() => { window.__kinuGalleryFrozen = true; });
  }

  if (theme !== null) {
    await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  }

  await page.goto(`${gallery.origin}/gallery.html?frame=app${query}`, { waitUntil: 'networkidle0' });

  return page;
}

/** The handle the shell leaves on window, once a renderer took the canvas. */
async function liveBackground(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__kinuAppBackground !== undefined && window.__kinuAppBackground.renderer() !== 'pending',
  );
}

/** One workspace's tile changes, and the roster socket carries it as the owner's object would. */
async function setOverview(page: Page, name: string, overview: JsonValue): Promise<void> {
  await page.evaluate((target, value) => {
    window.dispatchEvent(new CustomEvent('gallery:overview', { detail: { name: target, overview: value } }));
  }, name, overview);
}

/** A quiet tile. */
function idleBody(): JsonValue {
  return { activity: 'idle', awaitsSettings: false, decisionsWaiting: 0, hasUpdates: false, latestRun: null, slates: [], shares: [] };
}

/** The mode the tissue reports once the roster's frames reach it. A frozen
 *  picture ages only by the `step` of tissue seconds each check advances it. */
async function waitForMode(page: Page, mode: string, step = 0): Promise<void> {
  await page.waitForFunction(
    (wanted: string, dt: number) => {
      if (dt > 0) window.__kinuAppBackground?.advance?.(dt);

      return window.__kinuAppBackground?.mode() === wanted;
    },
    { polling: 100 },
    mode, step,
  );
}

/** What the page reports for `document.hidden`, and the event the clock
 *  listens for. */
async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** The pointer hold half a second of frames after the pointer last moved. The
 *  gallery page owns the stepping, so the picture moves only where a test
 *  advances it. */
function holdAfterFrames(page: Page): Promise<number> {
  return page.evaluate(() => {
    const handle = window.__kinuAppBackground;

    for (let i = 0; i < 30; i += 1) handle?.advance?.(1 / 60);

    return handle?.pointer() ?? 0;
  });
}

/** The picture's clock, read once in each of the next `frames` rendered frames:
 *  the frames are the end condition, never a duration. A running loop's own
 *  callback runs before this one in every frame, so it reads higher each time.
 *  `stir`: a pointer moves across the page before the first frame and in each,
 *  so a field that rests once nothing moves is kept moving while it is read. */
function clockOverFrames(page: Page, frames: number, stir = false): Promise<number[]> {
  return page.evaluate((count: number, stirring: boolean) => {
    const { promise, resolve } = Promise.withResolvers<number[]>();
    const seen: number[] = [];

    const move = (): void => {
      if (stirring) window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1100 + seen.length * 4, clientY: 120, pointerType: 'mouse' }));
    };

    const read = (): void => {
      seen.push(window.__kinuAppBackground?.time() ?? -1);
      move();

      if (seen.length === count) resolve(seen);
      else requestAnimationFrame(read);
    };

    move();
    requestAnimationFrame(read);

    return promise;
  }, frames, stir);
}

/** How far the clock moved from each reading to the next. */
function stepsOf(readings: readonly number[]): number[] {
  return readings.slice(1).map((time, index) => time - (readings[index] ?? time));
}

describe('the living background', () => {
  test('sits behind the rail and the page, untouchable', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&path=/new');

      try {
        await liveBackground(page);

        const host = await page.evaluate(() => {
          const el = document.querySelector('[data-app-background]');

          if (el === null) return null;
          const canvas = el.querySelector('canvas');
          const box = canvas?.getBoundingClientRect() ?? null;

          return {
            coversViewport: box !== null && box.left <= 0 && box.top <= 0 && box.right >= innerWidth && box.bottom >= innerHeight,
          };
        });

        if (host === null) throw new Error('no [data-app-background] host');
        expect(host.coversViewport).toBe(true);

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
  });

  test('stops its clock while the tab is hidden', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&path=/new');

      try {
        await liveBackground(page);

        // Stirred all along: a resting field's clock stands still whether or not the tab is hidden.
        await setTabHidden(page, true);
        const hidden = await clockOverFrames(page, 30, true);
        expect(stepsOf(hidden).filter((step) => step !== 0)).toEqual([]);

        await setTabHidden(page, false);
        const shown = await clockOverFrames(page, 30, true);
        expect(stepsOf([...hidden.slice(-1), ...shown]).filter((step) => step <= 0)).toEqual([]);
      } finally {
        await page.close();
      }
    });
  });

  test('a reduced-motion visitor gets one still frame', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.evaluateOnNewDocument(() => localStorage.setItem('theme', 'dark'));

      try {
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`${gallery.origin}/gallery.html?frame=app&path=/new`, { waitUntil: 'networkidle0' });
        await liveBackground(page);

        const renderer = await page.evaluate(() => window.__kinuAppBackground?.renderer());
        expect(renderer).toBe('static');

        const tagged = await page.evaluate(() =>
          document.querySelector('[data-app-background] canvas')?.getAttribute('data-renderer') ?? null);

        expect(tagged).toBe('static');

        const readings = await clockOverFrames(page, 30);
        expect(stepsOf(readings).filter((step) => step !== 0)).toEqual([]);

        await page.screenshot({ path: join(SHOTS, 'reduced-motion.png'), fullPage: false });
      } finally {
        await page.close();
      }
    });
  });

  test('a phone gets the same still', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();
      await page.evaluateOnNewDocument(() => localStorage.setItem('theme', 'dark'));

      try {
        await page.setViewport({ width: 390, height: 844 });
        await page.goto(`${gallery.origin}/gallery.html?frame=app&path=/new`, { waitUntil: 'networkidle0' });
        await liveBackground(page);

        const renderer = await page.evaluate(() => window.__kinuAppBackground?.renderer());
        expect(renderer).toBe('static');

        await page.screenshot({ path: join(SHOTS, 'phone.png'), fullPage: false });
      } finally {
        await page.close();
      }
    });
  });

  test('is not drawn behind Home, the assistant\'s chat', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&path=/');

      try {
        await page.waitForSelector('main');
        expect(await page.$('[data-app-background]')).toBeNull();
      } finally {
        await page.close();
      }
    });
  });

  // 2026-10-20, the owner: "more subtle, and more interactive to the cursor", and no idle CPU; 2026-10-23, as it ships too.
  test.each([['as it ships', ''], ['quiet', '&background=quiet']])('%s, it draws nothing while nothing moves, lights under the moving pointer, and rests again', async (_name, background) => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, `&path=/new${background}`, 'light');

      try {
        await liveBackground(page);
        const drawn = () => page.evaluate(() => window.__kinuAppBackground?.renders() ?? -1);

        const frames = (count: number) => page.evaluate((n) => new Promise<void>((done) => {
          let left = n;

          const next = () => {
            left -= 1;

            if (left <= 0) done();
            else requestAnimationFrame(next);
          };

          requestAnimationFrame(next);
        }), count);

        // Once anything the page's opening set moving has died out, two seconds of the page's own frames add none.
        await page.waitForFunction(() => window.__kinuAppBackground?.settled() === true);
        await frames(2);
        const resting = await drawn();
        await frames(120);
        expect(await drawn() - resting).toBe(0);

        for (let step = 0; step < 12; step += 1) await page.mouse.move(80 + step * 6, 120 + step * 4);
        await frames(10);
        const moved = await drawn();
        expect(moved).toBeGreaterThan(resting);

        // The pointer at rest lets go and the field settles; then it costs nothing again.
        await page.waitForFunction(() => window.__kinuAppBackground?.settled() === true);
        await frames(2);
        const after = await drawn();
        await frames(120);
        expect(await drawn() - after).toBe(0);
      } finally {
        await page.close();
      }
    });
  });

  test('never mounts where a transcript would be', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&path=/workspace/api-worker');

      try {
        // The route's blank element is its content; a background would have
        // committed with it, and its handle two frames later at the latest.
        await page.waitForSelector('[data-gallery-blank]');
        expect(await page.$('[data-app-background]')).toBeNull();
        expect(await clockOverFrames(page, 2)).toEqual([-1, -1]);
      } finally {
        await page.close();
      }
    });
  });

  test('follows the roster through idle, working and attention', async () => {
    await withGallery(async (gallery) => {
      // Frozen: the flash ages by the steps below, never by the frames a loaded
      // machine delivers late (each frame advances at most 0.05 s of tissue time).
      const page = await freshPage(gallery, '&path=/new', 'dark', true);

      try {
        await liveBackground(page);

        // Quiet every workspace; each change reaches the tissue as a frame.
        for (const name of DISPLAYED) await setOverview(page, name, idleBody());
        await waitForMode(page, 'idle');

        // Everyone working at once.
        for (const name of DISPLAYED) {
          await setOverview(page, name, { activity: 'working', awaitsSettings: false, decisionsWaiting: 0, hasUpdates: false, latestRun: null, slates: [], shares: [] });
        }

        await waitForMode(page, 'working');

        // One decision waiting: a flash, then back to working.
        await setOverview(page, 'api-worker', { activity: 'working', awaitsSettings: false, decisionsWaiting: 1, hasUpdates: false, latestRun: null, slates: [], shares: [] });
        await waitForMode(page, 'attention', 1 / 60);

        const afterFlash = await page.evaluate(() => {
          const handle = window.__kinuAppBackground;

          for (let i = 0; i < 120; i += 1) handle?.advance?.(1 / 60);

          return handle?.mode();
        });

        expect(afterFlash).toBe('working');
        await page.screenshot({ path: join(SHOTS, 'following.png'), fullPage: false });
      } finally {
        await page.close();
      }
    });
  });

  test('the mouse reaches the mesh across page elements and releases on leaving', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&path=/new', 'light', true);

      try {
        await liveBackground(page);
        await page.mouse.move(0.8 * 1440, 0.3 * 900);

        const cardHold = await holdAfterFrames(page);

        expect(cardHold).toBeGreaterThan(0);
        await page.mouse.move(0.94 * 1440, 0.2 * 900);

        const backgroundHold = await holdAfterFrames(page);

        expect(backgroundHold).toBeGreaterThan(0);
        await page.mouse.move(-50, -50);

        const releasedHold = await holdAfterFrames(page);

        expect(releasedHold).toBeLessThan(backgroundHold);
      } finally {
        await page.close();
      }
    });
  });

  test('a hoverless visitor sees the undisturbed picture', async () => {
    // Touch input must not arm mouse interaction. Measured 2026-09-22 on Chrome
    // 151.0.7922.173: `Emulation.setEmulatedMedia` answers `{}` for `hover`, as
    // for an unknown name, and moves no `matchMedia` answer. Touch emulation
    // gives `(hover: none)` before the first script, but under the launch's mouse
    // a settings-portal `color-scheme` answer landing after it turned it false
    // for good (the deploy red at d054a5ff2). So this browser declares no mouse.
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();
      await page.evaluateOnNewDocument(() => localStorage.setItem('theme', 'light'));

      try {
        await page.setViewport({ width: 1440, height: 900, hasTouch: true, isMobile: false });
        await page.goto(`${gallery.origin}/gallery.html?frame=app&path=/new`, { waitUntil: 'networkidle0' });
        expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
        await liveBackground(page);

        for (const name of DISPLAYED) await setOverview(page, name, idleBody());
        await waitForMode(page, 'idle');

        await page.touchscreen.touchStart(0.8 * 1440, 0.3 * 900);
        await page.touchscreen.touchMove(0.85 * 1440, 0.35 * 900);
        await page.touchscreen.touchEnd();
        const hold = await page.evaluate(() => window.__kinuAppBackground?.pointer() ?? -1);
        expect(hold).toBe(0);
      } finally {
        await page.close();
      }
    }, { mouse: false });
  });
});
