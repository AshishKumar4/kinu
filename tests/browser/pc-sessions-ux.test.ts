/**
 * A PC's named terminal sessions in the Environment (1014-t): the computer's strip, unchanged, over the sessions the
 * PC's daemon keeps, and their rows saying what the computer's say (1019-aa). The gallery's PC answers its session calls
 * as a daemon does (`GALLERY_DEVICE_SESSIONS`).
 */
import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';
import { NEW_SESSION } from '../../scripts/browser-page';

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

      expect(await tabNames(page)).toEqual(['shell', 'build', 'deploy']);
      expect(await page.$eval('[role="tab"][aria-selected="true"]', (tab) => tab.getAttribute('data-session'))).toBe('pty-shell');

      // A deploy waiting for an answer marks the PC as a waiting computer session marks the computer.
      expect(await page.$eval('[data-env-status]', (status) => ({ word: status.textContent, tone: status.getAttribute('data-tone') })))
        .toEqual({ word: 'Needs input', tone: 'attention' });

      // The dev server's row names its port and branch, as the computer's rows do.
      await (await page.waitForSelector('[role="tab"][data-session="pty-build"]'))?.click();
      await page.waitForSelector('[data-session-port]');
      expect(await page.$$eval('[data-session-port]', (ports) => ports.map((port) => port.textContent?.trim()))).toEqual([':5173']);

      await (await page.waitForSelector(NEW_SESSION))?.click();
      await page.waitForSelector('[role="tab"][data-session="pty-4"]');

      expect(await tabNames(page)).toEqual(['shell', 'build', 'deploy', 'shell 4']);
    } finally {
      await page.close();
    }
  });
});
