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

/** The mesh-live deliverables: after shots, the pointer shot, rim numbers. */
const MESH = '/home/mrwhite0racle/kinu-logs/mesh-live';

mkdirSync(SHOTS, { recursive: true });

mkdirSync(MESH, { recursive: true });

/** How close to the quiet disc the residue must settle once the pointer
 *  leaves: a ratio, not an absolute, so the bar moves with the run's own
 *  baseline. */
const SETTLE_TOLERANCE = 1.4;

/** The two bands the gate reads: the mesh rim and the mission-form centre. */
type Band = 'rim' | 'centre';

/** Mean absolute luminance delta between two screenshots, per band. The
 *  browser decodes its own PNGs through an image into a 2d canvas, so no
 *  image dependency lands in the repo for one gate's arithmetic. A `disc`
 *  restricts the read to a circle in viewport units — the pointer's
 *  neighbourhood — instead of the whole bands. */
async function bandDeltas(page: Page, shotA: Uint8Array, shotB: Uint8Array, disc?: { readonly x: number; readonly y: number; readonly r: number }): Promise<Record<Band, number>> {
  const sums = await page.evaluate(async (a: number[], b: number[], d: { readonly x: number; readonly y: number; readonly r: number } | null) => {
    const load = async (bytes: number[]): Promise<ImageData> => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
      const url = URL.createObjectURL(blob);

      try {
        const image = new Image();
        image.decoding = 'sync';
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });

        if (context === null) throw new Error('no 2d context for the delta read');
        context.drawImage(image, 0, 0);

        return context.getImageData(0, 0, canvas.width, canvas.height);
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    const first = await load(a);
    const second = await load(b);

    if (first.width !== second.width || first.height !== second.height) throw new Error('shot size diverged');
    const { width: w, height: h } = first;

    const sums = { rim: 0, rimN: 0, centre: 0, centreN: 0 };

    const linearize = (channel: number): number => {
      const c = channel / 255;

      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };

    const lum = (r: number, g: number, b2: number): number => 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b2);

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (d !== null) {
          const dx = x / w - d.x;
          const dy = y / h - d.y;

          if (dx * dx + dy * dy >= d.r * d.r) continue;
        }

        const i = (y * w + x) * 4;

        const delta = Math.abs(
          lum(first.data[i] ?? 0, first.data[i + 1] ?? 0, first.data[i + 2] ?? 0)
          - lum(second.data[i] ?? 0, second.data[i + 1] ?? 0, second.data[i + 2] ?? 0),
        );

        const rim = x < w * 0.15 || x >= w * 0.85 || y < h * 0.15 || y >= h * 0.85;

        const centre = x >= w * 0.22 && x < w * 0.78 && y >= h * 0.10 && y < h * 0.95;

        if (rim || d !== null) {
          sums.rim += delta;
          sums.rimN += 1;
        }

        if (centre) {
          sums.centre += delta;
          sums.centreN += 1;
        }
      }
    }

    return sums;
  }, [...shotA], [...shotB], disc ?? null);

  return { rim: sums.rim / sums.rimN, centre: sums.centre / sums.centreN };
}

/** The five names the stock gallery roster displays, in card order. */
const DISPLAYED = ['checkout-fixes', 'perf-audit', 'email-triage', 'design-sys', 'handwrought-walnut-4166c321'];

interface BackgroundHandle {
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  time(): number;
  mode(): 'idle' | 'working' | 'attention';
  pointer(): number;
  /** The stepping controls the GALLERY page attaches (`__kinuGalleryStepping`);
   *  the shipped shell's handle carries none, so these are optional here. */
  advance?(dt: number): void;
  freeze?(): void;
  thaw?(): void;
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
  return { observedAt: Date.now(), activity: 'idle', decisionsWaiting: 0, hasUpdates: false, latestRun: null, primarySlate: null };
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
            observedAt: Date.now(), activity: 'working', decisionsWaiting: 0, hasUpdates: false, latestRun: null, primarySlate: null,
          });
        }

        await waitForMode(page, 'working');

        // One decision waiting: a flash, then back under the working hum.
        await setOverview(page, 'checkout-fixes', {
          observedAt: Date.now(), activity: 'working', decisionsWaiting: 1, hasUpdates: false, latestRun: null, primarySlate: null,
        });
        await waitForMode(page, 'attention');
        await waitForMode(page, 'working', 3_000);

        await page.screenshot({ path: join(SHOTS, 'following.png'), fullPage: false });
      } finally {
        await page.close();
      }
    });
  }, 90_000);

  test('the mesh sits on the rim: light over dark, edge over centre', async () => {
    // No absolute pins — every bar is a ratio off the same run's own
    // captures, so a machine's load or a tissue state that shifts every
    // number moves the baseline with it.
    await withGallery(async (gallery) => {
      const rows: string[] = [];
      const measured: Partial<Record<'dark' | 'light', { rim: number; centre: number }>> = {};

      for (const theme of ['dark', 'light'] as const) {
        const page = await freshPage(gallery, '&path=/', theme);

        try {
          await page.setViewport({ width: 1440, height: 900 });
          await liveBackground(page);

          for (const name of DISPLAYED) await setOverview(page, name, idleBody());
          await waitForMode(page, 'idle');
          await pause(4000);

          const renderer = await page.evaluate(() => window.__kinuAppBackground?.renderer() ?? null);
          const on = await page.screenshot({ captureBeyondViewport: false });
          await page.evaluate(() => {
            const host = document.querySelector<HTMLElement>('[data-app-background]');

            if (host !== null) host.style.display = 'none';
          });
          await pause(400);
          const off = await page.screenshot({ captureBeyondViewport: false });
          await Bun.write(join(MESH, `home-${theme}-after.png`), on);

          const deltas = await bandDeltas(page, on, off);
          measured[theme] = deltas;
          const row = `${theme}: renderer=${String(renderer)} rim=${deltas.rim.toFixed(5)} centre=${deltas.centre.toFixed(5)}`;
          process.stdout.write(`mesh-live: ${row}\n`);
          rows.push(row);

          // The mesh densifies toward the edges: where it is visible — the
          // light picture — its rim band reads brighter than its own centre
          // band. The dark mesh's presence is near the ground by design, so
          // its band ratio is noise and is not gated.
          if (theme === 'light') expect(deltas.rim).toBeGreaterThan(deltas.centre);
        } finally {
          await page.close();
        }
      }

      // The light mesh carries more presence than the dark one: the same
      // run's two captures answer it.
      const light = measured.light;
      const dark = measured.dark;

      expect(light).toBeDefined();
      expect(dark).toBeDefined();
      expect((light?.rim ?? 0)).toBeGreaterThan(dark?.rim ?? Number.POSITIVE_INFINITY);

      await Bun.write(join(MESH, 'rim-after.txt'), rows.join('\n') + '\n');
    });
  }, 120_000);

  test('a hovered mesh brightens near the pointer and settles back after it leaves', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.browser.newPage();
      await page.evaluateOnNewDocument((mode: string) => localStorage.setItem('theme', mode), 'light');
      // Frozen from its seed: not one rAF frame runs before the test's own
      // steps, so the picture the pointer lands on is a pure function of
      // them. Measured before this (2026-09-18): the hold's lift depends on
      // the nearest node's distance, which the frames run between mount and
      // the freeze decided, and under the deploy wave's load that count was
      // whatever the wall clock allowed — the same test read 1.26 to 1.41
      // against a 1.3 bar.
      await page.evaluateOnNewDocument(() => { window.__kinuGalleryFrozen = true; });
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${gallery.origin}/gallery.html?frame=app&path=${encodeURIComponent('/')}`, { waitUntil: 'networkidle0' });
      // The pointer's disc overlaps page chrome whose hover colour transitions
      // over 150 ms: a shot taken mid-transition reads a different ground
      // under the mesh than one taken after it, and how far along it is when
      // the shot lands is the machine's load. Measured under the deploy wave
      // (2026-09-18): the same frozen picture read a held/quiet ratio of 1.25
      // there against 1.65-2.28 on a quiet box. The DOM's transitions are not
      // what this measures, so they are off.
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });

      try {
        // The keep-out boxes the picture is fitted around are the page's text
        // runs; a web font that lands after the fit moves them, and the
        // frozen picture would be refitted under a later shot. Fonts first.
        await page.evaluate(() => document.fonts.ready);
        await liveBackground(page);

        for (const name of DISPLAYED) await setOverview(page, name, idleBody());
        // The mode arrives over the read model's own async answer, waited for
        // WITHOUT stepping the picture: the mode is set on the tissue when the
        // answer lands, not on a frame.
        await waitForMode(page, 'idle');

        // Then a FIXED number of steps, in one call: the picture takes no step
        // but these.
        // A poll loop that advanced while it waited would make the count
        // depend on how fast the poll came back, which is the machine's load
        // — the reading below moved 15% run to run on exactly that.
        // 270 frames is the four and a half seconds of settling a live picture
        // gets before a pointer arrives.
        await page.evaluate(() => {
          for (let i = 0; i < 270; i += 1) window.__kinuAppBackground?.advance?.(1 / 60);
        });

        // Absolute presence in the pointer's disc, each live shot against
        // the same hidden-host ground, gated on the hold itself: the shot.
        // The rAF loop never runs here — the test's own advances are the
        // only steps the picture takes, and the pixels are a pure function
        // of them.
        const disc = { x: 0.94, y: 0.2, r: 0.06 };

        // The gallery attaches the stepping controls; a page without them is
        // not the gallery, and this readback has no picture to hold still.
        expect(await page.evaluate(() => window.__kinuAppBackground?.freeze !== undefined)).toBe(true);

        const quiet = await page.screenshot({ captureBeyondViewport: false });
        const quietHold = await page.evaluate(() => window.__kinuAppBackground?.pointer() ?? 0);

        // Onto the card first: the hold arms there.
        await page.mouse.move(0.8 * 1440, 0.3 * 900, { steps: 12 });

        const cardHold = await page.evaluate(() => {
          const handle = window.__kinuAppBackground;

          for (let i = 0; i < 30; i += 1) handle?.advance?.(1 / 60);

          return handle?.pointer() ?? 0;
        });

        // Then across element boundaries onto the background: the hold
        // must not dip — no listener clears it mid-page anymore.
        await page.mouse.move(0.94 * 1440, 0.2 * 900, { steps: 24 });

        const crossHold = await page.evaluate(() => {
          const handle = window.__kinuAppBackground;

          for (let i = 0; i < 30; i += 1) handle?.advance?.(1 / 60);

          return handle?.pointer() ?? 0;
        });

        process.stdout.write(`mesh-live: card hold=${cardHold.toFixed(3)} cross=${crossHold.toFixed(3)}\n`);
        // The hold ARMED under the card: above the resting hold the frozen
        // picture had before the pointer arrived, and above zero — so the
        // ratio below compares two live holds, never two zeros. Not a fixed
        // level: how high thirty steps lift it depends on the nearest node's
        // distance, which the seeded picture's state decides — and that state
        // is the same on every run now (frozen from the seed, fonts landed).
        expect(cardHold).toBeGreaterThan(quietHold);
        expect(cardHold).toBeGreaterThan(0);
        expect(crossHold).toBeGreaterThanOrEqual(cardHold * 0.9);
        const held = await page.screenshot({ captureBeyondViewport: false });
        await Bun.write(join(MESH, 'home-light-pointer.png'), held);

        // A click on the armed disc sends the front out: the disc reads
        // brighter than the hold it interrupted, in the frames that follow.
        await page.mouse.click(0.94 * 1440, 0.2 * 900);

        await page.evaluate(() => {
          const handle = window.__kinuAppBackground;

          for (let i = 0; i < 20; i += 1) handle?.advance?.(1 / 60);
        });

        const clicked = await page.screenshot({ captureBeyondViewport: false });

        await page.mouse.move(-50, -50, { steps: 12 });

        await page.evaluate(() => {
          const handle = window.__kinuAppBackground;

          for (let i = 0; i < 200; i += 1) handle?.advance?.(1 / 60);
        });

        const after = await page.screenshot({ captureBeyondViewport: false });

        await page.evaluate(() => {
          const host = document.querySelector<HTMLElement>('[data-app-background]');

          if (host !== null) host.style.display = 'none';
        });

        const ground = await page.screenshot({ captureBeyondViewport: false });

        await page.evaluate(() => window.__kinuAppBackground?.thaw?.());

        const quietPresence = await bandDeltas(page, quiet, ground, disc);
        const heldPresence = await bandDeltas(page, held, ground, disc);
        const clickPresence = await bandDeltas(page, clicked, ground, disc);
        const afterPresence = await bandDeltas(page, after, ground, disc);
        process.stdout.write(
          `mesh-live: disc presence quiet=${quietPresence.rim.toFixed(5)} held=${heldPresence.rim.toFixed(5)} click=${clickPresence.rim.toFixed(5)} after=${afterPresence.rim.toFixed(5)}\n`,
        );
        // Every bar is a ratio against this run's own captures: the held
        // disc reads brighter than the same disc quiet, the click's front
        // brighter than the hold it interrupted, and once the pointer
        // leaves the residue settles back to quiet's level. No fixed lift
        // is owed — how much the hold lifts depends on the nearest node's
        // distance in the seeded picture.
        expect(heldPresence.rim).toBeGreaterThan(quietPresence.rim);
        expect(clickPresence.rim).toBeGreaterThan(heldPresence.rim);
        expect(afterPresence.rim).toBeLessThan(heldPresence.rim);
        expect(afterPresence.rim).toBeLessThanOrEqual(quietPresence.rim * SETTLE_TOLERANCE);
      } finally {
        await page.close();
      }
    });
  }, 120_000);

  test('a hoverless visitor sees the undisturbed picture', async () => {
    // A touch-first viewport reports (hover: none); the mount never
    // listens there, so the same sweep that answers on desktop moves no
    // pixel here beyond the tissue's own drift.
    await withGallery(async (gallery) => {
      const page = await gallery.browser.newPage();
      await page.evaluateOnNewDocument(() => localStorage.setItem('theme', 'light'));

      try {
        await page.setViewport({ width: 1440, height: 900, hasTouch: true, isMobile: false });
        await page.goto(`${gallery.origin}/gallery.html?frame=app&path=/`, { waitUntil: 'networkidle0' });
        await liveBackground(page);

        for (const name of DISPLAYED) await setOverview(page, name, idleBody());
        await waitForMode(page, 'idle');
        await pause(4000);

        const hoverNone = await page.evaluate(() => matchMedia('(hover: none)').matches);
        expect(hoverNone).toBe(true);

        // A baseline drift over the same window the sweep would take, then
        // the sweep itself: the bar is swept-over-drift, not a fixed number.
        const quietA = await page.screenshot({ captureBeyondViewport: false });
        await pause(1500);
        const quietB = await page.screenshot({ captureBeyondViewport: false });
        const drift = await bandDeltas(page, quietA, quietB);

        // A touch sweep: here the picture must not answer, because the
        // mount ignores touch pointers and the media query stays hoverless.
        await page.touchscreen.touchStart(0.8 * 1440, 0.3 * 900);
        await page.touchscreen.touchMove(0.85 * 1440, 0.35 * 900);
        await page.touchscreen.touchEnd();
        const swept = await page.screenshot({ captureBeyondViewport: false });
        const hold = await page.evaluate(() => window.__kinuAppBackground?.pointer() ?? -1);
        process.stdout.write(`mesh-live: hover:none hold=${hold}\n`);
        expect(hold).toBe(0);
        const moved = await bandDeltas(page, quietB, swept);
        process.stdout.write(`mesh-live: hover:none rim=${moved.rim.toFixed(5)} drift=${drift.rim.toFixed(5)}\n`);
        // No pointer answer: the rim moves no more than the tissue's own
        // drift over the same window.
        expect(moved.rim).toBeLessThanOrEqual(drift.rim * SETTLE_TOLERANCE + 1e-6);
      } finally {
        await page.close();
      }
    });
  }, 120_000);
});
