import { expect, test } from 'bun:test';
import { INSPECTOR_MIN_PX } from '@kinu.run/core/web/inspector-layout';
import { withGallery } from './gallery-harness';

/**
 * The Activity tab's context map: every area of the prompt with its characters and its share. The inspector opens
 * at 340 px and the reader can drag it down to its minimum, so the map is read there. A share laid out past the
 * column's edge is one the reader never sees: at the default width every share of a live prompt stood outside the
 * inspector, behind a sideways scroll, and half the character counts broke over two lines (#27).
 */
test("every context area's share of the prompt stands inside the inspector at its narrowest", async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${origin}/gallery.html?frame=activity`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('section table');

    const verdict = await page.evaluate((width: number) => {
      const surface = document.querySelector('button[aria-label="Activity"]')?.closest('.\\@container');
      const column = surface?.parentElement;

      if (!(column instanceof HTMLElement)) throw new Error('no inspector column around the Activity surface');
      column.style.width = `${String(width)}px`;

      const section = [...document.querySelectorAll('section')]
        .find((node) => node.querySelector('h3')?.textContent?.trim() === 'Context');

      let scroller = section?.parentElement ?? null;

      while (scroller !== null && getComputedStyle(scroller).overflowX === 'visible') scroller = scroller.parentElement;

      if (section === undefined || scroller === null) throw new Error('no Context block in a scrolling column');
      const edge = scroller.getBoundingClientRect().left + scroller.clientWidth;
      const rows = [...section.querySelectorAll('tr')];
      const label = (row: Element): string => row.querySelector('td')?.textContent?.trim() ?? '?';

      // A count's text nodes each get a box; more than one line top is a count broken over two lines.
      const lines = (cell: Element | undefined): number =>
        new Set([...(cell?.querySelector('span')?.getClientRects() ?? [])].map((box) => Math.round(box.top))).size;

      return {
        column: column.getBoundingClientRect().width,
        rows: rows.length,
        sharesOutside: rows.filter((row) => (row.querySelectorAll('td')[2]?.getBoundingClientRect().right ?? Infinity) > edge + 0.5).map(label),
        countsBroken: rows.filter((row) => lines(row.querySelectorAll('td')[1]) > 1).map(label),
      };
    }, INSPECTOR_MIN_PX);

    expect(verdict.column).toBe(INSPECTOR_MIN_PX);
    expect(verdict.rows).toBeGreaterThan(0);
    expect(verdict.sharesOutside).toEqual([]);
    expect(verdict.countsBroken).toEqual([]);

    await page.close();
  });
});
