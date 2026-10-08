/**
 * An answer's page in the chat as the runner serves it: opened with the runner's own head and `kinu:slate`'s real client,
 * on a preview origin the browser reaches. It is as tall as what it holds, reads in the chat's theme, and can be kept as
 * a slate of the workspace.
 */
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import type { Frame, Page } from 'puppeteer';
import { SLATE_PAGE_PREAMBLE } from '@kinu.run/core';
import { SLATE_CLIENT_MODULE } from '@kinu.run/core/slates';
import { detach } from '@kinu.run/core/obs';
import { contrast, rgba, withGallery } from '../../scripts/gallery-harness';
import { TEST_REQUIREMENTS } from '../../scripts/test-requirements';

/** The answer's page as its author wrote it: a title, a heading, rows, and a paragraph that sets no colour. */
const PAGE = `<!doctype html><html><head><title>Coupon redemptions</title></head><body>
<h1>Redemptions</h1><p id="plain">SAVE20 leads this week.</p><ul id="rows">${'<li>SAVE20</li>'.repeat(12)}</ul>
</body></html>`;

/** The vendor modules the page imports beside `kinu:slate`: only what the client module names, none of it run here. */
const VENDOR = new Map([
  ['/__kinu/react.js', 'export const createElement = () => null; export const useMemo = (make) => make(); '
    + 'export const useSyncExternalStore = (_subscribe, read) => read(); export const createRoot = () => ({ render() {} });'],
  ['/__kinu/capnweb.js', 'export const newWebSocketRpcSession = () => ({ onRpcBroken() {} });'],
]);

/** The preview origin, answered as the runner answers it: the page opened with its head, and the modules it imports. */
async function servePage(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request) => detach(Effect.promise(async () => {
    const url = new URL(request.url());

    if (!url.hostname.endsWith('.preview.example.test')) {
      await request.continue();

      return;
    }

    if (url.pathname === '/__kinu/slate.js') {
      await request.respond({ status: 200, contentType: 'text/javascript', body: SLATE_CLIENT_MODULE });

      return;
    }

    const vendor = VENDOR.get(url.pathname);

    if (vendor !== undefined) {
      await request.respond({ status: 200, contentType: 'text/javascript', body: vendor });

      return;
    }

    await request.respond({ status: 200, contentType: 'text/html', body: PAGE.replace('<html>', `<html>${SLATE_PAGE_PREAMBLE}`) });
  })));
}

const CARD = '[data-slate-inline="pg-a1/redemptions"]';

/** The answer's page in a workspace's chat, once it has said its height and is drawn. */
async function openPage(page: Page, origin: string, theme: 'dark' | 'light', viewport: { width: number; height: number }): Promise<Frame> {
  await servePage(page);
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=page`, { waitUntil: 'networkidle0' });
  await page.waitForFunction((card) => (document.querySelector(`${card} iframe`)?.getBoundingClientRect().height ?? 0) > 0, {}, CARD);
  const frame = await (await page.$(`${CARD} iframe`))?.contentFrame();

  if (frame === undefined || frame === null) throw new Error('the answer page drew no frame');

  return frame;
}

const frameHeight = (page: Page): Promise<number> => page.$eval(`${CARD} iframe`, (frame) => frame.getBoundingClientRect().height);

/** How far the page inside the frame moved when asked to scroll: nothing, when it shows all it holds. */
const innerScroll = (frame: Frame): Promise<number> => frame.evaluate(() => {
  window.scrollTo(0, 400);

  return window.scrollY;
});

describe('an answer\'s page in the chat', () => {
  test('is as tall as what it holds: it scrolls nothing of its own, and grows and shrinks with its rows', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        const frame = await openPage(page, origin, 'dark', { width: 1280, height: 860 });

        expect(await innerScroll(frame)).toBe(0);

        const before = await frameHeight(page);
        await frame.evaluate(() => { document.getElementById('rows')?.insertAdjacentHTML('beforeend', '<li>WELCOME10</li>'.repeat(20)); });
        await page.waitForFunction((card, was) => (document.querySelector(`${card} iframe`)?.getBoundingClientRect().height ?? 0) > was, {}, CARD, before);
        expect(await innerScroll(frame)).toBe(0);

        const grown = await frameHeight(page);
        await frame.evaluate(() => { document.getElementById('rows')?.replaceChildren(); });
        await page.waitForFunction((card, was) => (document.querySelector(`${card} iframe`)?.getBoundingClientRect().height ?? 0) < was, {}, CARD, grown);
        expect(await innerScroll(frame)).toBe(0);
        expect(await frameHeight(page)).toBeLessThan(before);
      } finally { await page.close(); }
    });
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`reads in the chat's theme, ${theme}: its text is the chat's, in the chat's face, over the chat's own surface`, async () => {
      await withGallery(async ({ newPage, origin }) => {
        const page = await newPage();

        try {
          const frame = await openPage(page, origin, theme, { width: 1280, height: 860 });

          const host = await page.$eval(CARD, (card) => {
            let ground: Element | null = card;

            while (ground !== null && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(ground).backgroundColor)) ground = ground.parentElement;

            // The answer's own words around the page: what the page's text should read as.
            const prose = [...document.querySelectorAll('p')].find((paragraph) => paragraph.textContent?.trim() === 'SAVE20 leads.') ?? document.body;

            return { text: getComputedStyle(prose).color, face: getComputedStyle(prose).fontFamily, ground: getComputedStyle(ground ?? document.body).backgroundColor };
          });

          const inner = await frame.$eval('#plain', (plain) => ({
            text: getComputedStyle(plain).color, face: getComputedStyle(plain).fontFamily, ground: getComputedStyle(document.documentElement).backgroundColor,
          }));

          expect(inner.text).toBe(host.text);
          expect(inner.face).toBe(host.face);
          // Nothing of its own behind the text: the chat's surface shows through, and the text reads on it.
          expect(rgba(inner.ground).a).toBe(0);
          expect(contrast(rgba(inner.text), rgba(host.ground))).toBeGreaterThanOrEqual(TEST_REQUIREMENTS.wcagTextContrast.values.normal);
        } finally { await page.close(); }
      });
    });
  }

  test('is kept as a slate of the workspace under its title, which the work surface then opens', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await openPage(page, origin, 'dark', { width: 1280, height: 860 });
        await page.hover(CARD);
        await page.click(`${CARD} button[aria-label="Save redemptions as a slate"]`);
        await page.waitForSelector(`${CARD} [data-slate-saved="coupon-redemptions"]`);
        await page.waitForSelector('.p-tabstrip button[aria-label="Coupon redemptions"]');

        await page.hover(CARD);
        await page.click(`${CARD} [data-slate-saved="coupon-redemptions"]`);
        await page.waitForSelector('.p-tabstrip button[aria-label="Coupon redemptions"][aria-current="true"]');
      } finally { await page.close(); }
    });
  });
});
