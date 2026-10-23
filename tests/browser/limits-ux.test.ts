/**
 * The free tier's screens (core limits/) on the gallery's fixed accounts: Settings › Usage, the bar above every page,
 * each refusal's dialog with its ways on, the turn the day's models stopped, and the operators' accounts. Shots in
 * light, dark and on a phone land in kinu-logs/limits for review against the owner's boards.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';
import { evidenceDir } from '@kinu.run/test-utils';
import { withGallery, type Gallery } from '../../scripts/gallery-harness';

async function open(gallery: Gallery, query: string, view: { readonly width: number; readonly theme: string } = { width: 1280, theme: 'light' }): Promise<Page> {
  const page = await gallery.newPage();

  await page.setViewport({ width: view.width, height: 900 });
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), view.theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=limits${query}`, { waitUntil: 'networkidle0' });

  return page;
}

const text = (page: Page, selector: string) => page.$eval(selector, (node) => (node instanceof HTMLElement ? node.innerText : ''));

/** The open dialog's buttons and links, in order, by their words. */
/** Presses the button `scope` holds whose words are `words`; whether one was there to press. */
const press = (page: Page, scope: string, words: string) => page.$$eval(`${scope} button`, (buttons, wanted) => {
  const button = buttons.find((each) => each.textContent?.trim() === wanted);

  button?.click();

  return button !== undefined;
}, words);

/** Every wait ends: a page that never draws what is awaited fails the test at this bound, never holds it. */
const WAIT = { timeout: 15_000 } as const;

const dialogActions = (page: Page) => page.$$eval('[role="dialog"] button, [role="dialog"] a', (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));

describe('the free tier', () => {
  test('Settings › Usage draws a row per limit, and an invited account one line of none', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&state=normal');

      await page.waitForSelector('[data-account-limits="free"]', WAIT);
      expect(await page.$$eval('[data-account-limits] [data-limit]', (rows) => rows.map((row) => row.getAttribute('data-limit')))).toEqual(['workspaces', 'computer_hours', 'stored_bytes', 'model_tokens']);
      expect(await text(page, '[data-limit="workspaces"]')).toContain('2 of 3');
      // Below 80% nothing is near: no bar.
      expect(await page.$('[data-limit-banner]')).toBeNull();

      const invited = await open(gallery, '&state=invited');

      await invited.waitForSelector('[data-account-limits="invited"]', WAIT);
      expect(await text(invited, '[data-account-limits="invited"]')).toContain('no limits');
    });
  });

  test('a limit near its end is one bar above the page until dismissed, and the next near one shows then', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&state=near');

      await page.waitForSelector('[data-limit-banner]', WAIT);
      expect(await page.$eval('[data-limit-banner]', (bar) => bar.getAttribute('data-limit-banner'))).toBe('computer_hours');
      await page.click('[data-limit-banner] button[aria-label="Dismiss"]');
      await page.waitForFunction(() => document.querySelector('[data-limit-banner]')?.getAttribute('data-limit-banner') === 'stored_bytes', WAIT);
    });
  });

  test('each refusal is its own dialog: what is full, then Not now, its own way on, Move my data and Run your own Kinu', async () => {
    await withGallery(async (gallery) => {
      const cases = [
        { dialog: 'workspaces', title: 'You have 3 workspaces, the most a free account holds', actions: ['Not now', 'Manage workspaces', 'Move my data', 'Run your own Kinu'] },
        { dialog: 'storage', title: 'report.zip would take you past 2 GB', actions: ['Not now', 'Open Drive', 'Move my data', 'Run your own Kinu'] },
        { dialog: 'computer', title: "This month's 20 computer hours are used", actions: ['Not now', 'Move my data', 'Run your own Kinu'] },
        { dialog: 'elsewhere', title: 'Your free computer is running in release-notes', actions: ['Not now', 'Open release-notes', 'Move my data', 'Run your own Kinu'] },
      ];

      for (const { dialog, title, actions } of cases) {
        const page = await open(gallery, `&state=full&dialog=${dialog}`);

        await page.waitForSelector('[role="dialog"]', WAIT);
        expect(await text(page, '[role="dialog"]')).toContain(title);
        // The dialog's own close control comes first; the footer's ways on follow it in order.
        expect((await dialogActions(page)).filter((words) => words !== '')).toEqual(expect.arrayContaining(actions));
        await page.close();
      }
    });
  });

  test("the day's models stopping a turn says so where its answer would have gone, with the own-key way on", async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&state=full');

      await page.waitForSelector('[data-turn-limit="model_tokens"]', WAIT);
      expect(await text(page, '[data-turn-limit="model_tokens"]')).toContain('Use your own key');
    });
  });

  test("the operators' accounts filter by where each stands, and Invite makes a link", async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&state=normal');

      await page.waitForSelector('[data-accounts] table', WAIT);
      const shown = () => page.$$eval('[data-accounts] tbody tr', (rows) => rows.map((row) => row.getAttribute('data-account')));

      expect(await shown()).toHaveLength(5);
      expect(await press(page, '[data-accounts]', 'At a limit 1')).toBe(true);
      await page.waitForFunction(() => document.querySelectorAll('[data-accounts] tbody tr').length === 1, WAIT);
      expect(await shown()).toEqual(['ada@example.com']);

      expect(await press(page, '[data-accounts]', 'Invite')).toBe(true);
      await page.waitForSelector('[role="dialog"]', WAIT);
      expect(await press(page, '[role="dialog"]', 'Make a link instead')).toBe(true);
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes('/invite/7f3a9c') === true, WAIT);
    });
  });

  test('shots: light, dark and phone', async () => {
    const dir = evidenceDir('limits');

    mkdirSync(dir, { recursive: true });

    await withGallery(async (gallery) => {
      const views = [
        { width: 1280, theme: 'light', states: ['near', 'full', 'invited'], dialogs: ['workspaces', 'storage', 'computer', 'elsewhere'] },
        { width: 1280, theme: 'dark', states: ['near', 'full', 'invited'], dialogs: ['workspaces', 'storage', 'computer', 'elsewhere'] },
        { width: 390, theme: 'light', states: ['near', 'full', 'invited'], dialogs: ['workspaces', 'storage', 'computer', 'elsewhere'] },
        { width: 390, theme: 'dark', states: ['near', 'full'], dialogs: ['storage'] },
      ];

      for (const view of views) {
        const name = `${view.theme}-${String(view.width)}`;

        for (const state of view.states) {
          const page = await open(gallery, `&state=${state}`, view);

          await page.waitForSelector('[data-account-limits]', WAIT);
          await page.screenshot({ path: join(dir, `${name}-${state}.png`), fullPage: true });
          await page.close();
        }

        for (const dialog of view.dialogs) {
          const page = await open(gallery, `&state=full&dialog=${dialog}`, view);

          await page.waitForSelector('[role="dialog"]', WAIT);
          await page.screenshot({ path: join(dir, `${name}-dialog-${dialog}.png`) });
          await page.close();
        }
      }
    });
  });
});
