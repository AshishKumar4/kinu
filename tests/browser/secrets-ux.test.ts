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
      await page.type('[data-add-secrets] input[placeholder="Choose workspaces…"]', 'Kinu');
      await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes('Kinu website')));
      await page.$$eval('[role="option"]', (options) => {
        const site = options.find((option) => option.textContent?.includes('Kinu website'));

        if (site instanceof HTMLElement) site.click();
      });
      await page.click('[data-add-secrets] button[type="submit"]');
      await page.waitForSelector('[data-secret="WEBHOOK_SECRET"]');

      const saved = v.parse(SavedSchema, JSON.parse(await page.$eval('html', (root) => root.dataset.gallerySecretsSaved ?? '[]')));
      expect(saved).toEqual([{ names: ['OPENAI_API_KEY', 'WEBHOOK_SECRET'], grantTo: ['design-sys'] }]);
      expect(await page.$eval('[data-secret="OPENAI_API_KEY"]', (row) => row.textContent ?? '')).toContain('In Kinu website');
      await page.close();
    });
  });

  test('the rows are the one copy of a pasted .env: a row edited keeps its edit when more lines are pasted', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=${SETTINGS}&secrets=empty`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-secrets-empty]');

      await page.click('[data-add-secrets] [role="tab"]:nth-child(2)');
      await page.type('textarea[aria-label="A .env file"]', 'WEBHOOK_SECRET=whsec-one\n');
      await page.waitForSelector('input[aria-label="Hosts WEBHOOK_SECRET may be sent to"]');
      await page.type('input[aria-label="Hosts WEBHOOK_SECRET may be sent to"]', 'hooks.example.dev');

      // A later line for the same name takes its value; the hosts typed into its row stay.
      await page.type('textarea[aria-label="A .env file"]', 'WEBHOOK_SECRET=whsec-two\nSENTRY_TOKEN=st\n');
      await page.waitForSelector('[data-secret-row="1"]');

      const value = (label: string) => page.$eval(`input[aria-label="${label}"]`, (input) => (input instanceof HTMLInputElement ? input.value : ''));

      expect(await page.$$eval('[data-secret-row] input[aria-label="Secret name"]', (inputs) => inputs.map((input) => (input instanceof HTMLInputElement ? input.value : ''))))
        .toEqual(['WEBHOOK_SECRET', 'SENTRY_TOKEN']);
      expect([await value('Value of WEBHOOK_SECRET'), await value('Hosts WEBHOOK_SECRET may be sent to')]).toEqual(['whsec-two', 'hooks.example.dev']);
      // Nothing is left behind in the box to overwrite the rows later.
      expect(await page.$eval('textarea[aria-label="A .env file"]', (box) => (box instanceof HTMLTextAreaElement ? box.value : ''))).toBe('');
      await page.close();
    });
  });

  test("letting a workspace's agents read a value asks first, and only the owner's yes turns it on", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=${SETTINGS}`, { waitUntil: 'networkidle0' });
      await page.click('[data-secret="CLOUDFLARE_API_TOKEN"] button');
      const reveal = '[data-secret-details="CLOUDFLARE_API_TOKEN"] [data-secret-reveal="design-sys"]';
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
      expect(saved).toEqual([{ names: ['GITHUB_TOKEN'], grantTo: ['email-triage'] }]);
      expect(await page.$eval('[data-composer-root] textarea', (box) => box instanceof HTMLTextAreaElement ? box.value : '')).toBe('label the new issues on kinu-run/kinu with this token $GITHUB_TOKEN');

      await page.click('[data-composer-root] textarea');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.documentElement.dataset.gallerySent !== undefined);
      expect(JSON.parse(await page.$eval('html', (root) => root.dataset.gallerySent ?? '[]'))).toEqual(['label the new issues on kinu-run/kinu with this token $GITHUB_TOKEN']);
      await page.close();
    });
  });

  test('a value edited in the move still takes the pasted token out of the draft, whole', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=secretpaste`, { waitUntil: 'networkidle0' });

      await page.click('[data-composer-root] textarea');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-secret-offer-move]');
      await page.click('[data-secret-offer-move]');
      await page.waitForSelector('input[aria-label="Value of GITHUB_TOKEN"]');

      // The owner trims the token's last character before saving it.
      await page.click('input[aria-label="Value of GITHUB_TOKEN"]');
      await page.keyboard.press('End');
      await page.keyboard.press('Backspace');
      await page.click('[data-secret-move-save]');
      await page.waitForFunction(() => document.querySelector('[data-secret-offer]') === null);

      const draft = await page.$eval('[data-composer-root] textarea', (box) => (box instanceof HTMLTextAreaElement ? box.value : ''));

      expect(draft).toBe('label the new issues on kinu-run/kinu with this token $GITHUB_TOKEN');
      expect(draft).not.toContain(GITHUB.slice(0, 12));
      await page.close();
    });
  });

  test('a draft edited while the offer waits is checked again, and sending anyway sends what it says now', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=secretpaste`, { waitUntil: 'networkidle0' });

      await page.click('[data-composer-root] textarea');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-secret-offer]');

      // At the end of the draft: a word typed against the token would hide it from the check, as any word joined to it does.
      await page.keyboard.press('End');
      await page.keyboard.type(' now');
      await page.waitForFunction(() => document.querySelector('[data-secret-offer]') === null);

      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-secret-offer-send]');
      await page.click('[data-secret-offer-send]');
      await page.waitForFunction(() => document.documentElement.dataset.gallerySent !== undefined);

      expect(JSON.parse(await page.$eval('html', (root) => root.dataset.gallerySent ?? '[]'))).toEqual([`label the new issues on kinu-run/kinu with this token ${GITHUB} now`]);
      await page.close();
    });
  });

  test("a new workspace's mission is held the same way before the workspace is made with it", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });

      await page.type('textarea', `triage the open issues with ${GITHUB}`);
      // The landing's card submits on Ctrl+Enter.
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForSelector('[data-secret-offer]');

      expect(await page.$eval('[data-secret-offer]', (offer) => offer.textContent ?? '')).toContain('GitHub credential');
      expect(page.url()).toContain('frame=home');
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

      expect(JSON.parse(await page.$eval('html', (root) => root.dataset.gallerySent ?? '[]'))).toEqual([`label the new issues on kinu-run/kinu with this token ${GITHUB}`]);
      expect(await page.$('[data-secret-offer]')).toBeNull();
      await page.close();
    });
  });
});
