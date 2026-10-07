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

  test("a catalog provider's key brings its model into the menus as the default, and disconnecting takes both away", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => { window.dispatchEvent(new Event('gallery:settings-heal')); });

      // Groq from the catalog, by its name, and its key.
      await page.waitForSelector('input[placeholder^="Search providers"]');
      await page.type('input[placeholder^="Search providers"]', 'Groq');
      await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.trim() === 'Groq'));
      await page.$$eval('[role="option"]', (options) => {
        const groq = options.find((option) => option.textContent?.trim() === 'Groq');

        if (groq instanceof HTMLElement) groq.click();
      });
      await page.waitForSelector('input[aria-label="API key"]');
      await page.type('input[aria-label="API key"]', 'gsk_gallery');
      await page.click('input[aria-label="API key"] ~ button[type="submit"]');
      await page.waitForSelector('[data-provider="Groq"] button[aria-label="Disconnect Groq"]');

      // Its model is offered, and chosen as the account's default it is saved as such.
      const menu = async () => {
        await page.click('[data-settings-section="models"]');
        await page.waitForSelector('[data-model-picker="default model"]');
        await page.click('[data-model-picker="default model"]');
        await page.waitForSelector('[role="option"]');

        return page.$$eval('[role="option"]', (options) => options.map((option) => option.textContent?.trim() ?? ''));
      };

      // Each option also carries its own Test control; the model is the name it starts with.
      const offersLlama = (labels: readonly string[]) => labels.some((label) => label.startsWith('Llama 3.3 70B'));

      expect(offersLlama(await menu())).toBe(true);
      await page.$$eval('[role="option"]', (options) => {
        const llama = options.find((option) => option.textContent?.trim().startsWith('Llama 3.3 70B') === true);

        if (llama instanceof HTMLElement) llama.click();
      });
      // The tier is a draft until saved; saved, the button reads Save again, with nothing left to save.
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => /^Save (tiers|roles and tiers)$/u.test(button.textContent?.trim() ?? '') && !button.disabled));
      await page.$$eval('button', (buttons) => {
        const save = buttons.find((button) => /^Save (tiers|roles and tiers)$/u.test(button.textContent?.trim() ?? ''));

        if (save instanceof HTMLElement) save.click();
      });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => /^Save (tiers|roles and tiers)$/u.test(button.textContent?.trim() ?? '') && button.disabled));
      expect(await page.evaluate(async () => JSON.stringify(await (await fetch('/api/user/profile-catalog')).json())))
        .toContain('"default":{"model":"groq/llama-3.3-70b-versatile"');

      // Disconnected after its warning, the key and the model go together.
      await page.keyboard.press('Escape');
      await page.click('[data-settings-section="providers"]');
      await page.click('[data-provider="Groq"] button[aria-label="Disconnect Groq"]');
      await page.waitForSelector('[role="dialog"]');
      await page.$$eval('[role="dialog"] button', (buttons) => {
        const confirm = buttons.find((button) => button.textContent?.trim() === 'Disconnect');

        if (confirm instanceof HTMLElement) confirm.click();
      });
      await page.waitForFunction(() => document.querySelector('[data-provider="Groq"] button[aria-label="Disconnect Groq"]') === null);
      expect(offersLlama(await menu())).toBe(false);
      await page.close();
    });
  });
});
