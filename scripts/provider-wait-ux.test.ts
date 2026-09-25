import { expect, test } from 'bun:test';
import { withGallery } from './gallery-harness';

/**
 * The `providerwait` frame pins a turn mid-wait: a model call is sleeping out
 * the provider's declared cooldown and the task indicator is what says so.
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

    // The task indicator is the header's status region. It names the provider and counts down the time
    // the provider set; a working turn names no provider and shows no time.
    const chip = await page.waitForSelector('.p-workbench [role="status"][aria-label="Task state"]');

    if (chip === null) throw new Error('no task indicator in the workspace header');

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
