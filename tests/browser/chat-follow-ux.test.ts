/**
 * Two chat behaviours a person relies on and no row watched (issue #33):
 *
 *   · A file dropped onto the chat goes out with the next message. The drop lands on the chat column of the real
 *     WorkspacePage (`?frame=workspacepage`), the composer shows it, and Send hands the transport the words and the
 *     file together.
 *   · The chat follows an answer as it streams while the reader is at the bottom, and keeps a reader who scrolled up
 *     where they are until they come back down. Measured on the real scroll hook over a growing transcript
 *     (`?frame=chathistory`, whose `gallery:stream` grows the last answer by a paragraph).
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery } from '../../scripts/gallery-harness';

const SCROLLER = '[data-testid="chat-scroll"]';

/** How far the scroller sits above its bottom, after the page has painted what it was given. */
async function gapBelow(page: Page, scroller = SCROLLER): Promise<number> {
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); }); }));

  return page.$eval(scroller, (node) => node.scrollHeight - node.scrollTop - node.clientHeight);
}

async function stream(page: Page, chunks: number): Promise<void> {
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    await page.evaluate(() => window.dispatchEvent(new Event('gallery:stream')));
    await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); }));
  }
}

describe('a dropped file goes out with the message', () => {
  test('dropped on the chat, it shows in the composer and leaves with the words on Send', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      const pane = '[data-agent-pane="api-worker/main"]';
      await page.waitForSelector(`${pane} textarea:not([disabled])`);

      await page.$eval(pane, (node) => {
        const files = new DataTransfer();
        files.items.add(new File(['route,status\nGET /api/health,500\n'], 'errors.csv', { type: 'text/csv' }));
        node.dispatchEvent(new DragEvent('dragover', { dataTransfer: files, bubbles: true, cancelable: true }));
        node.dispatchEvent(new DragEvent('drop', { dataTransfer: files, bubbles: true, cancelable: true }));
      });
      await page.waitForFunction((at) => (document.querySelector(`${at} [data-composer-root]`)?.textContent ?? '').includes('errors.csv'), {}, pane);

      await page.type(`${pane} textarea`, 'Check these errors');
      await page.click(`${pane} button[aria-label="Send"]`);
      await page.waitForFunction(() => document.documentElement.dataset.galleryChatSent !== undefined);

      expect(JSON.parse(await page.evaluate(() => document.documentElement.dataset.galleryChatSent ?? '[]'))).toEqual(['file:errors.csv', 'text:Check these errors']);
      await page.close();
    });
  });
});

// The owner, 2026-10-25: "when users type and enter something in the chat, it should auto scroll to latest/bottom
// right?" A send goes to the newest row from wherever the reader was, and the rows it brings follow there.
describe('sending brings the chat to its newest row and follows the reply', () => {
  test('scrolled up a long chat, Enter takes the view to the bottom, and the message and its reply land in view', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const pane = '[data-agent-pane="api-worker/main"]';
      const chat = `${pane} .p-thread-column.overflow-y-auto`;

      const below = (): Promise<number> => gapBelow(page, chat);

      // The socket's live window, moved to history rows as the server's transcript frame moves it.
      const window = async (rows: number[], edited?: number): Promise<void> => {
        await page.evaluate((detail) => { globalThis.dispatchEvent(new CustomEvent('gallery:live-window', { detail })); }, { rows, ...(edited !== undefined && { edited }) });
        await below();
      };

      const rows = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, offset) => from + offset);

      await page.setViewport({ width: 1280, height: 860 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&history=200`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(`${pane} textarea:not([disabled])`);
      await window(rows(170, 199));

      await page.$eval(chat, (node) => { node.scrollTop = Math.max(0, node.scrollTop - 1600); node.dispatchEvent(new Event('scroll')); });
      const scrolledUp = await below();

      await page.type(`${pane} textarea`, 'Ship the fix to staging.');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.documentElement.dataset.galleryChatSends === '1');
      const afterSend = await below();

      // The server's next frames: the owner's message, then the reply, then the reply growing.
      await window(rows(170, 200));
      const afterMessage = await below();
      await window(rows(170, 201));
      const afterReply = await below();
      await window(rows(170, 201), 201);
      const afterGrowth = await below();

      expect(scrolledUp).toBeGreaterThan(1000);
      expect(Math.max(afterSend, afterMessage, afterReply, afterGrowth)).toBeLessThanOrEqual(2);
      await page.close();
    });
  });
});

describe('the chat follows a streaming answer, and a reader who scrolled up stays put', () => {
  test('at the bottom it follows; scrolled up it holds; back at the bottom it follows again', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1100, height: 760 });
      await page.goto(`${origin}/gallery.html?frame=chathistory`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(`${SCROLLER} [data-msg]`);

      // An answer starts and grows while the reader sits at the bottom: every paint stays there.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('gallery:arrive', { detail: 'answer' })));
      await stream(page, 6);
      expect(await gapBelow(page)).toBeLessThanOrEqual(2);

      // The reader scrolls up to read; the answer keeps growing under them, and what they read does not move.
      await page.$eval(SCROLLER, (node) => { node.scrollTop -= 400; node.dispatchEvent(new Event('scroll')); });
      await gapBelow(page);
      const read = await page.$eval(SCROLLER, (node) => node.scrollTop);
      await stream(page, 6);
      expect(await page.$eval(SCROLLER, (node) => node.scrollTop)).toBe(read);
      expect(await gapBelow(page)).toBeGreaterThan(400);

      // Back at the bottom, it follows again.
      await page.$eval(SCROLLER, (node) => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
      await gapBelow(page);
      await stream(page, 4);
      expect(await gapBelow(page)).toBeLessThanOrEqual(2);
      await page.close();
    });
  });
});
