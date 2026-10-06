/** Real WorkspacePage over position-addressed pages separated by unloaded reserves. */
import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const CHAT = '.p-thread-column.overflow-y-auto';

async function paint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); }));
  }));
}

async function release(page: Page): Promise<void> {
  await page.evaluate(() => { window.dispatchEvent(new Event('gallery:release-page')); });
}

async function asks(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.documentElement.dataset.historyAsks ?? 0));
}

async function openSparse({ newPage, origin }: Gallery): Promise<Page> {
  const page = await newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=slates&slates=2&history=5000&historyHold=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(CHAT);
  await page.waitForFunction(() => Number(document.documentElement.dataset.historyAsks ?? 0) > 0);
  await release(page);
  await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes('Answer 4999.'), {}, CHAT);
  const before = await asks(page);
  await page.$eval(CHAT, (el) => { el.scrollTop = 0; });
  await page.waitForFunction((count) => Number(document.documentElement.dataset.historyAsks ?? 0) > count, {}, before);
  await release(page);
  await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes('Question 0:'), {}, CHAT);
  await paint(page);

  return page;
}

test('a middle history failure offers a visible Retry at its gap and waits for it', async () => {
  await withGallery(async (gallery) => {
    const page = await openSparse(gallery);
    const before = await asks(page);
    await page.$eval(CHAT, (el) => {
      const gap = el.querySelector<HTMLElement>('[data-history-reserve]');

      if (gap === null) throw new Error('the sparse conversation has no gap');
      document.documentElement.dataset.historyFault = '1';
      el.scrollTop += gap.getBoundingClientRect().top - el.getBoundingClientRect().top + gap.offsetHeight / 2;
    });
    await page.waitForFunction((count) => Number(document.documentElement.dataset.historyAsks ?? 0) > count, {}, before);
    const failedRead = await page.evaluate(() => document.documentElement.dataset.historyReads?.trim().split(' ').at(-1) ?? '');
    await release(page);
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes('Could not load earlier messages'), {}, CHAT);
    await paint(page);

    const visibleRetry = await page.$eval(CHAT, (el) => {
      const view = el.getBoundingClientRect();

      return [...el.querySelectorAll('button')].some((button) => {
        const box = button.getBoundingClientRect();

        return button.textContent === 'Retry' && button.closest('[aria-hidden="true"]') === null
          && box.top >= view.top && box.bottom <= view.bottom;
      });
    });

    expect(visibleRetry).toBe(true);
    const failedAsks = await asks(page);
    await page.$eval(CHAT, (el) => { el.scrollTop += 30; el.dispatchEvent(new Event('scroll')); });
    await paint(page);
    expect(await asks(page)).toBe(failedAsks);

    await page.$eval(CHAT, (el) => {
      document.documentElement.dataset.historyFault = '0';
      const retry = [...el.querySelectorAll('button')].find((button) => button.textContent === 'Retry');

      if (retry === undefined) throw new Error('the failed history has no Retry');
      retry.click();
    });
    await page.waitForFunction((count) => Number(document.documentElement.dataset.historyAsks ?? 0) > count, {}, failedAsks);
    expect(await page.evaluate(() => document.documentElement.dataset.historyReads?.trim().split(' ').at(-1))).toBe(failedRead);
    await release(page);
    await page.waitForFunction((selector) => !document.querySelector(selector)?.textContent?.includes('Could not load earlier messages'), {}, CHAT);
    const first = Number(failedRead.split('-')[0]);
    const recovered = await page.$eval(CHAT, (el, position) => el.textContent?.includes(`${position % 2 === 0 ? 'Question' : 'Answer'} ${position}`) ?? false, first);
    expect(recovered).toBe(true);
    console.log('sparse history: visible Retry=' + String(visibleRetry) + ', no scroll retry, recovered ' + failedRead);
    await page.close();
  });
});

test('a fork counts the canonical rows through a message after an unloaded gap', async () => {
  await withGallery(async (gallery) => {
    const page = await openSparse(gallery);
    await page.$eval(CHAT, (el) => {
      const row = [...el.children].find((child) => child.textContent?.includes('Question 4900:'));
      const fork = row?.querySelector<HTMLButtonElement>('button[title="Fork the workspace from here"]');

      if (fork === null || fork === undefined) throw new Error('row 4900 has no Fork action');
      row?.scrollIntoView({ block: 'center' });
      fork.click();
    });
    await page.waitForSelector('[role="dialog"]');
    const count = await page.$eval('[role="dialog"]', (el) => Number(/Conversation: the (\d+) /u.exec(el.textContent ?? '')?.[1]));
    expect(count).toBe(4901);
    console.log('sparse fork: row 4900 copies ' + String(count) + ' messages');
    await page.close();
  });
});

/** The row numbers the column shows, top to bottom, each fixture row once per time it is drawn. */
async function shownRows(page: Page): Promise<number[]> {
  return page.$eval(CHAT, (el) => [...(el.textContent ?? '').matchAll(/(?:Question (\d+):|Answer (\d+)\.)/gu)].map((match) => Number(match[1] ?? match[2])));
}

/** Moves the socket's live window to those history rows, as the server's transcript frame does. */
async function liveWindow(page: Page, detail: { rows: number[]; edited?: number; cleared?: boolean }): Promise<void> {
  await page.evaluate((window_) => { window.dispatchEvent(new CustomEvent('gallery:live-window', { detail: window_ })); }, detail);
  await paint(page);
}

test('the live window slides without losing or repeating a row, pages older rows only at the top, and a clear empties both', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto(`${origin}/gallery.html?frame=workspacepage&history=2000`, { waitUntil: 'networkidle0' });
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes('Answer 1999.'), {}, CHAT);
    await paint(page);

    // The newest page only.
    const newest = await shownRows(page);
    expect(newest.at(-1)).toBe(1999);
    expect(newest[0]).toBeGreaterThan(0);

    // A stored row the live window holds too is drawn once, as the live copy.
    await liveWindow(page, { rows: [1999, 2000], edited: 1999 });
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes('Edited live.'), {}, CHAT);
    expect((await shownRows(page)).filter((row) => row === 1999)).toHaveLength(1);

    // The window moves forward, repeats a frame, and moves again: what left its front stays, oldest first, once.
    for (const rows of [[2000, 2001, 2002], [2001, 2002, 2003], [2001, 2002, 2003], [2003, 2004, 2005]]) await liveWindow(page, { rows });
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes('Answer 2005.'), {}, CHAT);
    expect((await shownRows(page)).slice(-8)).toEqual([1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005]);
    // Five frames drawn at the bottom, and nothing older was read.
    expect(await asks(page)).toBe(1);

    // At the top, the walk reads rows older than any drawn.
    await page.$eval(CHAT, (el) => { el.scrollTop = 0; });
    await page.waitForFunction((first, selector) => [...(document.querySelector(selector)?.textContent ?? '').matchAll(/Question (\d+):/gu)]
      .some((match) => Number(match[1]) < first), {}, newest[0] ?? 0, CHAT);
    expect(await asks(page)).toBeGreaterThan(1);

    // A window sharing no row with the last one is a gap: the rows kept from the old window go.
    await liveWindow(page, { rows: [2090, 2091] });
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes('Answer 2091.'), {}, CHAT);
    expect((await shownRows(page)).filter((row) => row >= 2000 && row < 2090)).toEqual([]);

    // Another tab cleared the conversation: no stored or kept row survives, and the next message stands alone.
    await liveWindow(page, { rows: [], cleared: true });
    await page.waitForFunction((selector) => !/Question \d+:|Answer \d+\./u.test(document.querySelector(selector)?.textContent ?? ''), {}, CHAT);
    await liveWindow(page, { rows: [2500] });
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes('Question 2500:'), {}, CHAT);
    expect(await shownRows(page)).toEqual([2500]);
    await page.close();
  });
});
