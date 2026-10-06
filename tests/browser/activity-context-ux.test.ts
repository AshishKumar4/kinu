import { expect, test } from 'bun:test';
import { INSPECTOR_MIN_PX } from '@kinu.run/core/web/inspector-layout';
import { withGallery } from '../../scripts/gallery-harness';

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

// m1219: the cache rates read in order of weight, the EMA largest and the tail percentiles quieter than the rest.
test('the prompt-cache rates step down in size: EMA, then last and mean, then p95 and p99', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.goto(`${origin}/gallery.html?frame=activitycache`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('dl dt');

    // In order: EMA, Last, Mean, p95, p99. A rate the panel lost fails here rather than reading as size 0.
    const [ema, last, mean, p95, p99] = await page.evaluate(() => ['EMA', 'Last', 'Mean', 'p95', 'p99'].map((name) => {
      const label = [...document.querySelectorAll('dl dt')].find((node) => node.textContent?.trim() === name);
      const value = label?.nextElementSibling?.querySelector('span') ?? label?.nextElementSibling;

      if (value === null || value === undefined) throw new Error(`no ${name} rate on the panel`);

      return Number.parseFloat(getComputedStyle(value).fontSize);
    }));

    expect(ema).toBeGreaterThan(last ?? ema);
    expect(mean).toBe(last);
    expect(p95).toBeLessThan(mean ?? p95);
    expect(p99).toBe(p95);

    // Each rate stands under its own label: the fixture's EMA 0.91, last 0.94, mean 0.88, p95 0.97, p99 0.99.
    const rates = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('dl dt')]
      .map((label) => [label.textContent?.trim() ?? '', Number.parseFloat(label.nextElementSibling?.textContent ?? '')])));

    expect(rates).toMatchObject({ EMA: 91, Last: 94, Mean: 88, p95: 97, p99: 99 });

    // A provider that reports no cache counters shows no rate at all, never an invented 0%.
    await page.goto(`${origin}/gallery.html?frame=activitycache&cache=unreported`, { waitUntil: 'networkidle0' });
    expect(await page.evaluate(() => ({ rates: document.querySelectorAll('dl dt').length, percent: document.body.innerText.includes('%') }))).toEqual({ rates: 0, percent: false });
    await page.close();
  });
});

// The context map's shares are of what was measured: the areas add up to the whole, and a conversation nothing has
// measured yet shows no share at all, never a 0% that would claim a measurement.
test('the context areas share the whole measured prompt, and an unmeasured conversation shows no share', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const context = () => page.evaluate(() => {
      const section = [...document.querySelectorAll('section')].find((node) => node.querySelector('h3')?.textContent?.trim() === 'Context');
      const shares = [...(section?.querySelectorAll('tr') ?? [])].map((row) => Number.parseFloat(row.querySelectorAll('td')[2]?.textContent ?? ''));

      return { shares, percents: (section?.textContent ?? '').match(/\d%/g)?.length ?? 0 };
    });

    await page.goto(`${origin}/gallery.html?frame=activity`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('section table');
    const measured = await context();

    // Each area is listed once whole and once across its parts, so every share shown adds up to twice the prompt.
    expect(measured.shares.length).toBeGreaterThan(2);
    expect(Math.abs(measured.shares.reduce((sum, share) => sum + share, 0) - 200)).toBeLessThan(1);

    await page.goto(`${origin}/gallery.html?frame=activityempty`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => [...document.querySelectorAll('section h3')].some((title) => title.textContent?.trim() === 'Context'));
    expect(await context()).toEqual({ shares: [], percents: 0 });
    await page.close();
  });
});

// The log the snapshot fetched reaches the reader whole, newest first, as a log is read from the top.
test('every fetched log row is shown, newest first', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${origin}/gallery.html?frame=activity`, { waitUntil: 'networkidle0' });

    const events = await page.evaluate(() => {
      const section = [...document.querySelectorAll('section')].find((node) => node.querySelector('h3')?.textContent?.trim() === 'Activity log');

      return [...(section?.querySelectorAll('li') ?? [])].map((row) => row.textContent ?? '');
    });

    // The fixture's events in the order the read returns them, oldest first.
    const fetched = ['steer_queued', 'beforeturn', 'gettools_rebuilding', 'gettools_end', 'skills_active', 'compaction', 'response_complete'];
    const shownAt = fetched.map((event) => events.findIndex((row) => row.includes(event)));

    expect(events).toHaveLength(fetched.length);
    expect(shownAt).toEqual(fetched.map((_, at) => fetched.length - 1 - at));
    await page.close();
  });
});
