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
  await withGallery(async ({ browser, origin }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${origin}/gallery.html?frame=providerwait`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.p-workbench');

    // The one identity row the workspace shares. `providerwait` is the only
    // frame that passes a wait, so the word exists nowhere else to be found.
    const indicator = await page.$eval(
      '.p-workbench main > div > div:first-child',
      (el) => el.textContent ?? '',
    );

    expect(indicator).toContain('waiting on anthropic');
    expect(indicator).toContain('45s');
    expect(indicator).not.toContain('working');

    // The chip also carries its own title: a hover answers when the retry is
    // due, which the word alone cannot.
    const chipTitle = await page.$eval(
      '.p-workbench [title^="Retry in"]',
      (el) => el.getAttribute('title'),
    );

    expect(chipTitle).toBe('Retry in 45s');

    await page.close();
  });
}, 120_000);
