import { describe, expect, test } from 'bun:test';
import { withGallery } from '../../scripts/gallery-harness';

describe.each(['dark', 'light'])('the standalone pages on the %s theme', (mode) => {
  test.each(['login', 'loginfail', 'install', 'approve'])('%s applies the preference and serves its own resources', async (frame) => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const failed: string[] = [];
      const external: string[] = [];
      page.on('requestfailed', (request) => { failed.push(`${request.url()}: ${request.failure()?.errorText}`); });
      page.on('response', (response) => {
        if (!response.ok()) failed.push(`${response.url()}: ${response.status()}`);
      });
      page.on('request', (request) => {
        const url = new URL(request.url());

        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) external.push(url.href);
      });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
      await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });

      const painted = await page.evaluate(async () => {
        const unloaded: string[] = [];

        for (const face of document.fonts) {
          try { await face.load(); }
          catch (cause) { unloaded.push(`${face.family}: ${String(cause)}`); }
        }

        return {
          mode: document.documentElement.dataset.mode,
          scheme: getComputedStyle(document.documentElement).colorScheme,
          lang: document.documentElement.lang,
          unloaded,
        };
      });

      expect(painted).toEqual({ mode, scheme: mode, lang: 'en', unloaded: [] });
      expect(failed).toEqual([]);
      expect(external).toEqual([]);
      await page.close();
    });
  });
});

test.each([
  { stored: 'dark', system: 'light', expected: 'dark' },
  { stored: 'light', system: 'dark', expected: 'light' },
  { stored: 'sepia', system: 'dark', expected: 'dark' },
  { stored: 'sepia', system: 'light', expected: 'light' },
])('stored $stored with system $system applies $expected', async ({ stored, system, expected }) => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.evaluateOnNewDocument((value) => localStorage.setItem('theme', value), stored);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: system }]);
    await page.goto(origin + '/gallery.html?frame=login', { waitUntil: 'networkidle0' });
    expect(await page.evaluate(() => ({
      mode: document.documentElement.dataset.mode,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }))).toEqual({ mode: expected, scheme: expected });
    await page.close();
  });
});

