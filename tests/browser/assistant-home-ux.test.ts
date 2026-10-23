/**
 * Home's bar says what the assistant does now (docs/HOME-EXPLORE.md §2; 1018-xao, held to Muse's status line and its
 * Upcoming): at rest, how many things it watches and the next one due, from its own triggers (`listTriggers`), not a
 * line a caller hands it. The gallery's assistant lists four watches, the GitHub check due first.
 */
import { describe, expect, test } from 'bun:test';

import { withGallery } from '../../scripts/gallery-harness';

describe("Home's bar", () => {
  test('at rest it counts what the assistant watches and names the next one due', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await page.setViewport({ width: 1280, height: 860 });
      await page.goto(`${origin}/gallery.html?frame=assistant-home`, { waitUntil: 'networkidle0' });
      // Its four watches counted: then the line says what it has read of them.
      await page.waitForFunction(() => (document.querySelector('[data-focus-line]')?.textContent ?? '').includes('4'));

      const line = await page.$eval('[data-focus-line]', (said) => said.textContent ?? '');

      expect([line.includes('4'), line.includes('GitHub check'), line.includes('Daily brief')]).toEqual([true, true, false]);
    });
  });
});
