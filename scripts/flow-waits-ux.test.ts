/**
 * What ends a harness wait before its condition holds: a failure the page shows, named beside what the wait was
 * for. On 2026-09-24 a sweep's Drive row waited 36 minutes on a Drive whose listing had failed, while the page said
 * why the whole time. Which words each failure display marks is the product's side, held by
 * packages/cf-backend/tests/unit-failure-marks.test.ts.
 */
import { expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { withBrowser } from './live-app-harness';
import { until, waitOn } from './product-flows';

/** The wait's condition, counting every poll of it, so a test can hold a failure in front of the wait first. */
const ANSWERED = '(window.__polls = (window.__polls ?? 0) + 1, window.__answered === true)';

const UNCONFIGURED = 'This deployment is not configured to serve signed-in users: CREDENTIAL_ENCRYPTION_KEY is not set.';

const OFFLINE = '<div class="p-notice-danger">Could not send to the turn: offline</div>';

/** A load that failed, as LoadFailure draws one. */
const LOAD_FAILED = `<div class="p-danger"><span data-failure>Could not load this folder: ${UNCONFIGURED}</span><button>Retry</button></div>`;

async function blankPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();

  page.setDefaultTimeout(0);
  await page.setContent('<main></main>');

  return page;
}

async function show(page: Page, markup: string, shown = true): Promise<void> {
  await page.evaluate((html, visible) => {
    const holder = document.createElement('div');

    holder.innerHTML = html;

    if (!visible) holder.style.display = 'none';
    document.body.append(holder);
  }, markup, shown);
}

/** Settles once two polls of the wait have read the page as it is now. */
async function polledTwice(page: Page): Promise<void> {
  const from = Number(await page.evaluate('window.__polls ?? 0'));

  await page.waitForFunction(`window.__polls >= ${String(from + 2)}`);
}

/** The wait for the answer, with `arrange` run while it is open and the answer given after: it settles as the
 *  wait did. */
async function answerWait(arrange: (page: Page) => Promise<void>): Promise<void> {
  return withBrowser(async (browser) => {
    const page = await blankPage(browser);
    const waited = until(page, 'the answer', ANSWERED);

    // A wait that ended stops polling, so `arrange` could wait on it forever: its end ends this too.
    await Promise.race([arrange(page), waited]);
    await page.evaluate('window.__answered = true');

    return waited;
  });
}

test('a failure the page shows ends the wait, naming what it waited for and the failure', async () => {
  await expect(answerWait(async (page) => {
    await show(page, LOAD_FAILED);
    await polledTwice(page);
  })).rejects.toThrow(`waiting for the answer, the page showed a notice: Could not load this folder: ${UNCONFIGURED}`);
});

test('a failure the page hides leaves the wait running', async () => {
  await answerWait(async (page) => {
    await show(page, OFFLINE, false);
    await polledTwice(page);
  });
});

test('a wait on a turn\'s socket ends on the failure its page shows', async () => {
  await withBrowser(async (browser) => {
    const page = await blankPage(browser);

    await show(page, OFFLINE);

    await expect(waitOn(page, 'the turn to close', new Promise<never>(() => undefined)))
      .rejects.toThrow('waiting for the turn to close, the page showed a notice: Could not send to the turn: offline');
  });
});
