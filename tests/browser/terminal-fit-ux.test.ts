/**
 * A terminal fits its pane (production walkthrough rc30 F7): xterm's fit sizes the screen from its host's width, and a
 * host that carried the pane's inset as its own padding was counted as room, so the screen ran past the inspector's
 * edge by a pixel or two and clipped the last column. Swept across phone widths, since the overrun is the part of a
 * column the width leaves over.
 */
import { describe, expect, test } from 'bun:test';

import { withGallery } from '../../scripts/gallery-harness';

describe("the computer's terminal", () => {
  test('keeps its screen inside its pane at every width', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const overruns: string[] = [];

      await page.setViewport({ width: 380, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(`${origin}/gallery.html?frame=environment`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.xterm-screen');

      for (let width = 380; width <= 410; width += 1) {
        await page.setViewport({ width, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await page.evaluate(() => new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); }));

        const edge = await page.$eval('.xterm-screen', (screen) => {
          const host = screen.closest('.xterm')?.parentElement;

          return { screen: screen.getBoundingClientRect().right, host: host?.getBoundingClientRect().right ?? Number.NaN };
        });

        if (!(edge.screen <= edge.host + 0.5)) overruns.push(`${String(width)}: ${String(edge.screen)} past ${String(edge.host)}`);
      }

      expect(overruns).toEqual([]);
    });
  });
});
