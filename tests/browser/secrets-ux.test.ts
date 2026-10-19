/**
 * Settings › Secrets and the chat's paste offer in a real browser, against the gallery's account: secrets added from a
 * pasted .env reach the account with their hosts and workspace; letting agents read a value asks first; a token pasted
 * into a draft is never sent until the owner moves it to Secrets or chooses to send it anyway.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { withGallery } from '../../scripts/gallery-harness';

const SETTINGS = 'usersettingsstate&section=secrets';

/** Assembled here, so this source matches no secret scanner. */
const GITHUB = ['ghp_', 'R8q2LmZx7KbV4nT1sWc9YdE3uHf6JpA0gN5o'].join('');

const OPENAI = ['sk-proj-', 'abcdefghijklmnopqrstuvwxyz012345'].join('');

const SavedSchema = v.array(v.object({ names: v.array(v.string()), grantTo: v.array(v.string()) }));

describe('Settings › Secrets', () => {
  test('a pasted .env becomes one row a line, a known key gets its own host, and the batch is saved to the workspace chosen', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=${SETTINGS}&secrets=empty`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-secrets-empty]');

      await page.click('[data-add-secrets] [role="tab"]:nth-child(2)');
      await page.type('textarea[aria-label="A .env file"]', `# staging\nOPENAI_API_KEY=${OPENAI}\nWEBHOOK_SECRET="whsec local"\n`);
      await page.waitForSelector('[data-secret-row="1"]');

      expect(await page.$$eval('[data-secret-row] input[aria-label="Secret name"]', (inputs) => inputs.map((input) => input instanceof HTMLInputElement ? input.value : ''))).toEqual(['OPENAI_API_KEY', 'WEBHOOK_SECRET']);
      expect(await page.$eval('input[aria-label="Hosts OPENAI_API_KEY may be sent to"]', (input) => input instanceof HTMLInputElement ? input.value : '')).toBe('api.openai.com');
      // A line with no known key has no host yet, so the batch waits for one.
      expect(await page.$eval('[data-add-secrets] button[type="submit"]', (button) => button instanceof HTMLButtonElement && button.disabled)).toBe(true);

      await page.type('input[aria-label="Hosts WEBHOOK_SECRET may be sent to"]', 'hooks.example.dev');
      await page.type('[data-add-secrets] input[placeholder="Choose workspaces…"]', 'Store');
      await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes('Storefront')));
      await page.$$eval('[role="option"]', (options) => {
        const storefront = options.find((option) => option.textContent?.includes('Storefront'));

        if (storefront instanceof HTMLElement) storefront.click();
      });
      await page.click('[data-add-secrets] button[type="submit"]');
      await page.waitForSelector('[data-secret="WEBHOOK_SECRET"]');

      const saved = v.parse(SavedSchema, JSON.parse(await page.$eval('html', (root) => root.dataset.gallerySecretsSaved ?? '[]')));
      expect(saved).toEqual([{ names: ['OPENAI_API_KEY', 'WEBHOOK_SECRET'], grantTo: ['checkout-fixes'] }]);
      expect(await page.$eval('[data-secret="OPENAI_API_KEY"]', (row) => row.textContent ?? '')).toContain('In Storefront');
      await page.close();
    });
  });

  test("letting a workspace's agents read a value asks first, and only the owner's yes turns it on", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=${SETTINGS}`, { waitUntil: 'networkidle0' });
      await page.click('[data-secret="STRIPE_SECRET_KEY"] button');
      const reveal = '[data-secret-details="STRIPE_SECRET_KEY"] [data-secret-reveal="checkout-fixes"]';
      await page.waitForSelector(reveal);

      await page.click(reveal);
      await page.waitForSelector('[role="dialog"]');
      await page.$$eval('[role="dialog"] button', (buttons) => buttons.find((button) => button.textContent === 'Cancel')?.click());
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      expect(await page.$eval(reveal, (toggle) => toggle.getAttribute('aria-checked'))).toBe('false');

      await page.click(reveal);
      await page.waitForSelector('[role="dialog"]');
      await page.$$eval('[role="dialog"] button', (buttons) => buttons.find((button) => button.textContent === 'Let them read it')?.click());
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-checked') === 'true', {}, reveal);
      await page.close();
    });
  });
});

describe("a computer's preview", () => {
  test('opens for its owner alone until they confirm making it a public link, and turns back off at once', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`${origin}/gallery.html?frame=computerpreview`, { waitUntil: 'networkidle0' });
      const toggle = '[data-preview-public-switch]';
      await page.waitForSelector(toggle);
      expect(await page.$eval(toggle, (button) => button.getAttribute('aria-checked'))).toBe('false');

      await page.click(toggle);
      await page.waitForSelector('[role="dialog"]');
      expect(await page.$eval('html', (root) => root.dataset.galleryPreviewPublic ?? null)).toBeNull();
      await page.$$eval('[role="dialog"] button', (buttons) => buttons.find((button) => button.textContent === 'Make it public')?.click());
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-checked') === 'true', {}, toggle);
      expect(await page.$eval('html', (root) => root.dataset.galleryPreviewPublic)).toBe('true');

      await page.click(toggle);
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-checked') === 'false', {}, toggle);
      expect(await page.$eval('html', (root) => root.dataset.galleryPreviewPublic)).toBe('false');
      await page.close();
    });
  });
});

describe('a secret pasted into the chat', () => {
  test('is not sent: moved to Secrets, the workspace gets it and the draft says $GITHUB_TOKEN, which then sends', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=secretpaste`, { waitUntil: 'networkidle0' });

      await page.click('[data-composer-root] textarea');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-secret-offer]');
      expect(await page.$eval('html', (root) => root.dataset.gallerySent ?? null)).toBeNull();

      await page.click('[data-secret-offer-move]');
      await page.waitForSelector('[data-secret-move-save]');
      await page.click('[data-secret-move-save]');
      await page.waitForFunction(() => document.querySelector('[data-secret-offer]') === null);

      const saved = v.parse(SavedSchema, JSON.parse(await page.$eval('html', (root) => root.dataset.gallerySecretsSaved ?? '[]')));
      expect(saved).toEqual([{ names: ['GITHUB_TOKEN'], grantTo: ['checkout-fixes'] }]);
      expect(await page.$eval('[data-composer-root] textarea', (box) => box instanceof HTMLTextAreaElement ? box.value : '')).toBe('push the fix with this token $GITHUB_TOKEN please');

      await page.click('[data-composer-root] textarea');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.documentElement.dataset.gallerySent !== undefined);
      expect(JSON.parse(await page.$eval('html', (root) => root.dataset.gallerySent ?? '[]'))).toEqual(['push the fix with this token $GITHUB_TOKEN please']);
      await page.close();
    });
  });

  test('sent anyway, it is sent as written, once, on the owner\'s word', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`${origin}/gallery.html?frame=secretpaste`, { waitUntil: 'networkidle0' });

      await page.click('[data-composer-root] textarea');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-secret-offer-send]');
      await page.click('[data-secret-offer-send]');
      await page.waitForFunction(() => document.documentElement.dataset.gallerySent !== undefined);

      expect(JSON.parse(await page.$eval('html', (root) => root.dataset.gallerySent ?? '[]'))).toEqual([`push the fix with this token ${GITHUB} please`]);
      expect(await page.$('[data-secret-offer]')).toBeNull();
      await page.close();
    });
  });
});
