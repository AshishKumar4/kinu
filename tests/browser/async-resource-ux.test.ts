/**
 * A read reloaded faster than it answers still shows its answers. While a turn runs, the server says the Work read
 * moved again and again, and each reload asked before the last answered: a page that kept only the newest asked
 * dropped every answer as stale and held its first (live-app-plans, rc15: an approved plan's card showed no tasks).
 */
import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';

declare global {
  interface Window {
    /** The reloads frame's loads waiting for an answer, oldest first (`ReloadsFrame` in gallery.tsx). */
    __reloads?: ((count: number) => void)[];
  }
}

const SHOWN = `document.querySelector('[data-reloads-shown]')?.textContent ?? ''`;

const ASKED = '(window.__reloads?.length ?? 0)';

/** Waits two frames, so what the page draws after an answer is on screen. */
async function drawn(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((done) => { requestAnimationFrame(() => { requestAnimationFrame(done); }); }));
}

/** Asks one more reload and waits for its load to be waiting on the test; answers its index among all loads asked. */
async function reload(page: Page): Promise<number> {
  const before = Number(await page.evaluate(ASKED));

  await page.click('button');
  await page.waitForFunction(`${ASKED} > ${String(before)}`);

  return before;
}

/** Answers load `index` with `tasks`, and reads what the page shows after it. */
async function answer(page: Page, index: number, tasks: number): Promise<string> {
  await page.evaluate((at: number, count: number) => window.__reloads?.[at]?.(count), index, tasks);
  await drawn(page);

  return String(await page.evaluate(SHOWN));
}

test('a reload answered while a newer one is out is shown, and an older answer never covers a newer', async () => {
  await withGallery(async (gallery) => {
    const page = await gallery.newPage();

    try {
      await page.goto(`${gallery.origin}/gallery.html?frame=reloads`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(`${ASKED} > 0`);
      await drawn(page);
      // The page's first load (asked twice in development, as React mounts it twice): each answered, the newest shown.
      const first = Number(await page.evaluate(ASKED));

      for (let index = 0; index < first; index++) await answer(page, index, 0);
      expect(String(await page.evaluate(SHOWN))).toBe('0');

      const one = await reload(page);
      const two = await reload(page);

      // The first reload's answer comes while the second is still out: it is newer than what is shown.
      expect(await answer(page, one, 1)).toBe('1');
      // The second answers: newer again.
      expect(await answer(page, two, 2)).toBe('2');

      const three = await reload(page);
      const four = await reload(page);

      // Out of order: the newer reload answers first, then the older one, which must not cover it.
      expect(await answer(page, four, 4)).toBe('4');
      expect(await answer(page, three, 3)).toBe('4');
    } finally {
      await page.close();
    }
  });
});
