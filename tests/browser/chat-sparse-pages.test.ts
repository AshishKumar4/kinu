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
