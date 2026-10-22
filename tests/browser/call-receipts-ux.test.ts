/**
 * A program's receipt beside its call (WEB-3): what it changed, as the host recorded it while it ran and bound to the
 * call's own id (core `execution/call-effects.ts`). The chat shows it under the call's row and whole in the opened call;
 * a record the program's own result claims is no receipt, and a program that failed after changing something still
 * shows what it changed.
 */
import { describe, expect, test } from 'bun:test';

import type { Page } from 'puppeteer';

import { withGallery } from '../../scripts/gallery-harness';

/** Each call's row in order: whether its receipt line shows. */
function receiptsShown(page: Page): Promise<boolean[]> {
  return page.$$eval('[data-tool-state]', (rows) => rows.map((row) => row.querySelector('[data-tool-receipt]') !== null));
}

/** The opened call's record, as its receipt lists it. */
function receiptListed(page: Page, index: number): Promise<{ files: string[]; commands: string[]; operations: string[] } | null> {
  return page.$$eval('[data-tool-state]', (rows, at) => {
    const panel = rows[at]?.parentElement?.querySelector('[data-receipt]') ?? null;

    if (panel === null) return null;

    return {
      files: [...panel.querySelectorAll('[data-receipt-file]')].map((file) => `${file.getAttribute('data-receipt-file') ?? ''} ${file.getAttribute('data-change') ?? ''}`),
      commands: [...panel.querySelectorAll('[data-receipt-command]')].map((command) => `${command.getAttribute('data-receipt-command') ?? ''} ${command.getAttribute('data-exit') ?? ''}`),
      operations: [...panel.querySelectorAll('[data-receipt-operation]')].map((operation) => operation.getAttribute('data-receipt-operation') ?? ''),
    };
  }, index);
}

async function open(page: Page, index: number): Promise<void> {
  await page.$$eval('[data-tool-state]', (rows, at) => {
    const row = rows[at];

    if (!(row instanceof HTMLElement)) throw new Error(`no call ${String(at)}`);
    row.click();
  }, index);
  await page.waitForFunction((at) => document.querySelectorAll('[data-tool-state]')[at]?.getAttribute('aria-expanded') === 'true', {}, index);
}

describe("a program's receipt", () => {
  test("shows the host's record beside its call, never a record its own result claims", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=toolcalls&calls=programs`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-tool-state]');

      expect(await receiptsShown(page)).toEqual([true, false, true]);

      for (const index of [0, 1, 2]) await open(page, index);

      expect(await receiptListed(page, 0)).toEqual({
        files: ['workers/api/src/routes/webhooks.ts edited', 'workers/api/src/db.ts edited'],
        commands: ['bun test workers/api/src/routes 0', 'bunx wrangler deploy --dry-run 1'],
        operations: ['kv.put'],
      });
      expect(await receiptListed(page, 1)).toBeNull();
      expect(await receiptListed(page, 2)).toEqual({ files: ['workers/api/migrations/0008_sessions.sql created'], commands: [], operations: [] });
    });
  });
});
