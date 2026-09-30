/** The providers list in a real browser: Claude's sign-in, pasted code and all, against the gallery's account. */
import { describe, expect, test } from 'bun:test';

import { withGallery } from '../../scripts/gallery-harness';

const CLAUDE = '[data-provider="Claude"]';

const claudeText = () => document.querySelector('[data-provider="Claude"]')?.textContent ?? '';

describe('the providers list', () => {
  test('Claude connects from a pasted code, warns first, says why a code fails, and then offers Disconnect', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(CLAUDE);

      expect(await page.evaluate(claudeText)).toContain('Not connected');
      expect(await page.evaluate(claudeText)).toContain("Anthropic's terms");

      // Not connected, its one button is the sign-in.
      await page.click(`${CLAUDE} button`);
      const authorize = await page.waitForSelector(`${CLAUDE} a[href^="https://claude.ai/oauth/authorize"]`);
      expect(authorize).not.toBeNull();

      await page.type(`${CLAUDE} input[aria-label="Claude sign-in code"]`, 'stale-code');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (document.querySelector('[data-provider="Claude"]')?.textContent ?? '').includes('Invalid authorization code'));

      await page.click(`${CLAUDE} input[aria-label="Claude sign-in code"]`, { count: 3 });
      await page.type(`${CLAUDE} input[aria-label="Claude sign-in code"]`, 'good-code');
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${CLAUDE} button[aria-label="Disconnect Claude"]`);

      expect(await page.evaluate(claudeText)).toContain('Connected');
      await page.close();
    });
  });

  test('a ChatGPT plan connected on the page is in the model menus without a reload', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers&chatgpt=device`, { waitUntil: 'networkidle0' });
      // The fixture's Codex read fails until healed, for the sibling failure rig.
      await page.evaluate(() => { window.dispatchEvent(new Event('gallery:settings-heal')); });
      await page.click('[data-settings-resource="your ChatGPT connection"] button');
      await page.waitForSelector('[data-provider="ChatGPT"] button');

      // The sign-in opens its own tab; the page polls the machine until it reports the plan.
      await page.click('[data-provider="ChatGPT"] button');
      await page.waitForSelector('[data-provider="ChatGPT"] button[aria-label="Disconnect ChatGPT"]');

      // The sign-in's own tab took the front; a background tab draws no frames to click through.
      for (const other of await page.browser().pages()) if (other !== page) await other.close();

      await page.bringToFront();

      await page.click('[data-settings-section="models"]');
      await page.waitForSelector('[data-model-picker="default model"]');
      await page.click('[data-model-picker="default model"]');
      await page.waitForSelector('[role="option"]');

      expect(await page.$$eval('[role="option"]', (options) => options.map((option) => option.textContent ?? '').join(' | '))).toContain('GPT-5.5');
      await page.close();
    });
  });
});
