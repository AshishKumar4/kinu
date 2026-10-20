/**
 * A PC's named terminal sessions in the Environment (1014-t): the computer's strip, unchanged, over the sessions the
 * PC's daemon keeps. The gallery's PC answers its session calls as a daemon does (`GALLERY_DEVICE_SESSIONS`).
 */
import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';

/** The names on the PC's strip, in order. */
function tabNames(page: Page): Promise<string[]> {
  return page.$$eval('[role="tablist"] [role="tab"]', (tabs) => tabs.map((tab) => tab.textContent?.trim() ?? ''));
}

test("a PC's sessions are tabs on its strip, as the computer's are: its daemon's names, and a new one from +", async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    try {
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspaceshell&env=computer&pc=granted`, { waitUntil: 'networkidle0' });
      await (await page.waitForSelector('button[aria-label="Environment"]'))?.click();
      await (await page.waitForSelector('[data-env-card="device"] button'))?.click();
      await page.waitForSelector('[role="tab"][data-session="pty-build"]');

      expect(await tabNames(page)).toEqual(['shell', 'build']);
      expect(await page.$eval('[role="tab"][aria-selected="true"]', (tab) => tab.getAttribute('data-session'))).toBe('pty-shell');

      await (await page.waitForSelector('button[aria-label="New session"]'))?.click();
      await page.waitForSelector('[role="tab"][data-session="pty-3"]');

      expect(await tabNames(page)).toEqual(['shell', 'build', 'shell 3']);
    } finally {
      await page.close();
    }
  });
});
