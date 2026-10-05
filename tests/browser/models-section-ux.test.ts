/** Model controls through keyboard interaction and accessible names. */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const THINKING = '[aria-label="Thinking level"]';

async function composerPage(gallery: Gallery, theme: 'dark' | 'light', width: number): Promise<Page> {
  const page = await gallery.newPage();
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.setViewport({ width, height: 1100 });
  await page.goto(`${gallery.origin}/gallery.html?frame=composer`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(THINKING);

  return page;
}

describe('the models section keeps every control reachable by name', () => {
  test('a tier\'s model is tested from the keyboard, and the result is announced on its row', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-model-picker="deep model"]');

      await page.click('[data-model-picker="deep model"]');
      await page.waitForSelector('input[aria-label="Search deep model"]');
      await page.keyboard.press('ArrowDown');
      const highlighted = await page.$eval('[role="option"][data-highlighted]', (row) => row.textContent ?? '');
      await page.keyboard.down('Alt');
      await page.keyboard.press('KeyT');
      await page.keyboard.up('Alt');
      await page.waitForFunction(() => document.querySelector('[role="option"][data-highlighted] [role="status"]')?.textContent?.includes('Works'));

      expect(await page.$eval('[role="option"][data-highlighted]', (row) => row.textContent ?? '')).toContain(highlighted.slice(0, 8));
      // Testing never picks: the search is still open.
      expect(await page.$('input[aria-label="Search deep model"]')).not.toBeNull();
      await page.close();
    });
  });

  test('the selected model has its own Test button, which answers beside it and opens no menu', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      const row = '[data-tier="default"]';
      await page.waitForSelector(`${row} button[aria-label^="Test "]`);

      // From the keyboard: focus the button by its name, press Enter.
      await page.focus(`${row} button[aria-label^="Test "]`);
      await page.keyboard.press('Enter');
      await page.waitForFunction((tier) => document.querySelector(`${tier} [role="status"]`)?.textContent?.includes('Works'), {}, row);

      expect(await page.$('[role="listbox"]')).toBeNull();
      await page.close();
    });
  });

  test('the selected model\'s Test runs on the account the tier names, not the default one', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      const row = '[data-tier="default"]';
      await page.click(`${row} [data-model-picker="default model"]`);
      await page.waitForSelector('input[aria-label="Search default model"]');
      await page.type('input[aria-label="Search default model"]', 'Claude Opus');
      await page.keyboard.press('Enter');
      await page.click(`${row} [aria-label="default model account"]`);
      await page.waitForSelector('[role="option"]');
      const options = await page.$$('[role="option"]');
      const labels = await Promise.all(options.map((option) => option.evaluate((node) => node.textContent)));
      await options[labels.indexOf('work')]?.click();
      await page.waitForSelector(`${row} button[aria-label="Test anthropic@work/claude-opus-4-7"]`);

      await page.click(`${row} button[aria-label="Test anthropic@work/claude-opus-4-7"]`);
      await page.waitForFunction((tier) => document.querySelector(`${tier} [role="status"]`)?.textContent?.includes('Works'), {}, row);
      await page.close();
    });
  });

  test('tier rows and the role editor expose their controls by accessible name', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="New tier id"]');

      const named = async (name: string): Promise<boolean> =>
        page.$$eval(`[aria-label="${name}"]`, (els) => els.length > 0);

      // Every built-in tier row carries its two controls, named for the tier:
      // the model combobox and the reasoning-effort select.
      // The model trigger is a button whose spoken name starts with the tier's label.
      const pickerNamed = async (name: string): Promise<boolean> =>
        page.$$eval('button', (buttons, wanted) => buttons.some((button) => button.textContent?.startsWith(`${wanted}: `) === true), name);

      for (const tier of ['fast', 'default', 'deep']) {
        expect(await pickerNamed(`${tier} model`)).toBe(true);
        expect(await named(`${tier} reasoning effort`)).toBe(true);
      }

      // The role navigation and the selected role's editor fields.
      expect(await page.$('nav[aria-label="Agent roles"] [aria-current="true"]')).not.toBeNull();

      // "Default swarm preset" waits on "Beta: swarms", below.
      for (const field of ['Label', 'Description', 'Instructions', 'Default tier']) {
        expect(await named(field)).toBe(true);
      }

      // The tool and skill membership lists, as named checkboxes.
      expect(await named('Tools: file')).toBe(true);
      expect(await named('Skills: audit-implementation')).toBe(true);
      await page.close();
    });
  });
});

describe('the composer reasoning control', () => {
  test('the thinking menu keeps its levels and opens from the keyboard', async () => {
    await withGallery(async (gallery) => {
      const page = await composerPage(gallery, 'dark', 1280);

      // The label the trigger carries is the level's own name, not its id.
      expect(await page.$eval(THINKING, (element) => element.textContent?.trim())).toBe('Default');

      await page.focus(THINKING);
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="option"]');

      // The stub model declares low, medium and high, so the menu offers
      // exactly those plus the tier's default — `offeredReasoningEfforts`.
      expect(await page.$$eval('[role="option"]', (options) => options.map((o) => o.textContent?.trim())))
        .toEqual(['Default', 'Low', 'Medium', 'High']);

      await page.keyboard.press('Escape');
      await page.close();
    });
  });
});

describe('Beta: swarms in account Settings', () => {
  test('off by default, with no swarm preset to choose; turned on, it saves and the preset is offered', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      const presetChoice = () => page.evaluate(() => document.body.textContent?.includes('Default swarm preset') === true);

      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Description"]');
      expect(await presetChoice()).toBe(false);

      await page.click('a[href$="#beta"]');
      await page.waitForSelector('[data-beta-swarms][aria-checked="false"]');
      await page.click('[data-beta-swarms]');
      await page.waitForSelector('[data-beta-swarms][aria-checked="true"]:not([disabled])');

      await page.click('a[href$="#models"]');
      await page.waitForSelector('[aria-label="Description"]');
      expect(await presetChoice()).toBe(true);
      await page.close();
    });
  });
});

