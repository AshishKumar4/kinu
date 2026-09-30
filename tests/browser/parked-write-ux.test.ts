/** A parked write's preview settles: its diff, or why there is none, never a spinner with nothing pending. */
import { expect, test } from 'bun:test';

import { withGallery } from '../../scripts/gallery-harness';

test('a parked write decided elsewhere says so, with a retry, instead of loading forever', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.goto(`${origin}/gallery.html?frame=approvals&parked=gone`, { waitUntil: 'networkidle0' });
    await page.click('[data-parked-write] button[aria-expanded]');
    await page.waitForFunction(() => document.querySelector('[data-parked-write]')?.textContent?.includes('no longer waiting'));

    expect(await page.$('[data-parked-write] [aria-label="Retry"], [data-parked-write] button:not([aria-expanded])')).not.toBeNull();
    await page.close();
  });
});
