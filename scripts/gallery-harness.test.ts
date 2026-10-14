import { expect, test } from 'bun:test';

import { contrast, rgba, withGallery } from './gallery-harness';

test('a contrast just below WCAG AA does not pass by rounding', () => {
  // WCAG 2.2 SC 1.4.3 forbids rounding its threshold; this pair's ratio is 4.499795462746351:1.
  const ratio = contrast(rgba('rgb(112, 121, 114)'), rgba('rgb(255, 255, 255)'));

  expect(ratio).toBeLessThan(4.5);
  expect(ratio).toBeGreaterThan(4.499);
});

test('fractional sRGB channels below the WCAG 2.2 cutoff stay on its linear branch', () => {
  expect(contrast(rgba('rgb(10.3, 10.3, 10.3)'), rgba('rgb(255, 255, 255)')))
    .toBeCloseTo(19.764211849397245, 10);
});

test('teardown rejects a gallery selector when the native browser cannot answer', async () => {
  const selector = '[data-absent-on-native-gallery-close]';

  const pending = await withGallery(async (gallery) => {
    const page = await gallery.newPage();
    await page.goto('data:text/html,<h1>owned gallery</h1>');
    const waiting = page.waitForSelector(selector).then(() => false, (...failure: [unknown]) => failure[0] instanceof Error);
    const child = page.browser().process();

    if (!child?.pid) throw new Error('gallery browser has no native process');
    process.kill(child.pid, 'SIGSTOP');

    return { waiting };
  });

  expect(await pending.waiting).toBe(true);
});

