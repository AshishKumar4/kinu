import { expect, test } from 'bun:test';
import { withGallery } from '../../scripts/gallery-harness';

/**
 * The `providerwait` frame pins a turn mid-wait: a model call is sleeping out
 * the provider's declared cooldown, and the notice above the composer says so.
 *
 * What this guards: a rate-limited turn used to read `working` the whole time
 * it was asleep, indistinguishable from a slow one. The chip naming the
 * provider and its retry window is the difference between "thinking" and
 * "told to wait" — and only `provider_wait` carries it.
 */
test('a turn sleeping out a provider wait says who it is waiting on, not working', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${origin}/gallery.html?frame=providerwait`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.p-workbench');

    // The notice names the provider and counts down the time the provider set; a working turn shows none.
    await page.waitForFunction(() => [...document.querySelectorAll('[data-composer-root] [role="status"]')].some((notice) => notice.textContent?.includes('Waiting on') === true));
    const notices = await page.$$('[data-composer-root] [role="status"]');
    const texts = await Promise.all(notices.map((notice) => notice.evaluate((el) => el.textContent ?? '')));
    const chip = notices[texts.findIndex((text) => text.includes('Waiting on'))];

    if (chip === undefined) throw new Error('no provider wait above the composer');

    const secondsIn = (text: string): number => Number(/\d+/u.exec(text)?.[0] ?? Number.NaN);
    const before = await chip.evaluate((el) => el.textContent ?? '');

    // The next tick of the countdown: the indicator's text changes on its own.
    const after = await chip.evaluate((el, seen) => new Promise<string>((resolve) => {
      const observer = new MutationObserver(() => {
        if ((el.textContent ?? '') === seen) return;

        observer.disconnect();
        resolve(el.textContent ?? '');
      });

      observer.observe(el, { subtree: true, childList: true, characterData: true });
    }), before);

    expect(before).toContain('anthropic');
    expect(secondsIn(before)).toBeGreaterThan(0);
    expect(secondsIn(before)).toBeLessThanOrEqual(45);
    expect(secondsIn(after)).toBeLessThan(secondsIn(before));

    await page.close();
  });
});
