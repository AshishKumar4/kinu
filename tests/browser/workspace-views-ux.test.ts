/**
 * A workspace's own addresses draw what they name (rc29 walkthrough F2): the desktop's page went with D99, and its
 * address drew the overview in its place. The gallery's workspace shell mounts the app's workspace routes over the real
 * page, with the computer (`&env=computer`), and opens on `&view=`. The live app row `workspace-views` reads the same.
 */
import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';

const DRAWN = '[data-workspace-overview], [data-not-found], button.p-tool[aria-label="Environment"][aria-current="true"]';

async function openView(newPage: () => Promise<Page>, origin: string, view: string): Promise<Page> {
  const page = await newPage();

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${origin}/gallery.html?frame=workspaceshell&env=computer&view=${view}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(DRAWN);

  return page;
}

test("the desktop's old address opens the workspace's Environment on its desktop, never the overview", async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await openView(newPage, origin, 'desktop');

    try {
      // Read first, so the defect (the overview drawn in its place) fails here rather than waiting on a machine row.
      expect(await page.$('[data-workspace-overview]')).toBeNull();
      await page.waitForSelector('[data-env-card] [data-env-select][aria-pressed="true"]');

      // The chosen machine is the computer, whose Desktop is the tab shown.
      expect(await page.$eval('[data-env-card]:has([data-env-select][aria-pressed="true"])', (card) => card.getAttribute('data-env-card'))).toBe('computer');
      await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')]
        .some((tab) => (tab.textContent ?? '').trim() === 'Desktop' && tab.getAttribute('aria-selected') === 'true'));
    } finally {
      await page.close();
    }
  });
});

test('a view no page answers says so, and the overview still answers at its own address', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const unknown = await openView(newPage, origin, 'nonsense');

    try {
      expect(await unknown.$('[data-not-found]')).not.toBeNull();
      expect(await unknown.$('[data-workspace-overview]')).toBeNull();
    } finally {
      await unknown.close();
    }

    const overview = await openView(newPage, origin, 'overview');

    try {
      expect(await overview.$('[data-workspace-overview]')).not.toBeNull();
    } finally {
      await overview.close();
    }
  });
});
