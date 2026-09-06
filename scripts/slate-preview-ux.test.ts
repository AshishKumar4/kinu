import { describe, expect, test } from 'bun:test';
import { withGallery } from './gallery-harness';

describe('the Slate preview frame', () => {
  test('loads the preview URL in a sandbox without a host bridge', async () => {
    await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      try {
        await page.setViewport({ width: 720, height: 800 });
        await page.goto(`${origin}/gallery.html?frame=slate`, { waitUntil: 'networkidle0' });
        const frameElement = await page.waitForSelector('iframe');
        if (frameElement === null) throw new Error('Slate preview iframe did not mount');
        expect(await frameElement.evaluate((element) => element.getAttribute('sandbox'))).toBe('allow-scripts');
        const frame = await frameElement.contentFrame();
        if (!frame) throw new Error('the Slate preview did not create an iframe context');
        await frame.waitForSelector('[data-slate-preview]', { timeout: 30_000 });
        expect(await frame.$eval('[data-slate-preview]', (element) => element.textContent))
          .toBe('Rendered on the preview URL.');
      } finally {
        await page.close();
      }
    });
  }, 120_000);

  test('removing the selected Slate returns the work surface to Work', async () => {
    await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      try {
        await page.setViewport({ width: 720, height: 800 });
        await page.goto(`${origin}/gallery.html?frame=workslatefallback`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('button[title="Fallback Probe, written by Kinu"][aria-current="true"]');
        await page.evaluate(() => { window.dispatchEvent(new Event('gallery:slate-unpublish')); });
        await page.waitForSelector('button[aria-label="Work"][aria-current="true"]');
        expect(await page.$('button[title="Fallback Probe, written by Kinu"]')).toBeNull();
      } finally {
        await page.close();
      }
    });
  }, 120_000);
});
