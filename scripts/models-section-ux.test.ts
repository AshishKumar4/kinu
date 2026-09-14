/**
 * The models settings section, through the names assistive technology reads.
 *
 * The section was redesigned from one tall card into tiers + master/detail
 * roles, and a redesign is exactly when a control silently drops out: the DOM
 * still "has a picker" but the tier row no longer names it. Every assertion
 * below is by ACCESSIBLE NAME — `getByRole`-equivalent lookups over the
 * rendered document — so a refactor that keeps the controls and loses their
 * names fails here, and one that drops a control outright fails here too.
 */
import { describe, expect, test } from 'bun:test';
import type { Browser } from 'puppeteer';

import { withGallery } from './gallery-harness';

describe('the models section keeps every control reachable by name', () => {
  test('tier rows and the role editor expose their controls by accessible name', async () => {
    await withGallery(async ({ browser, origin }: { browser: Browser; origin: string }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="New tier id"]');

      const named = async (name: string): Promise<boolean> =>
        page.$$eval(`[aria-label="${name}"]`, (els) => els.length > 0);

      // Every built-in tier row carries its two controls, named for the tier:
      // the model combobox and the reasoning-effort select.
      for (const tier of ['fast', 'default', 'deep']) {
        expect(await named(`${tier} model`)).toBe(true);
        expect(await named(`${tier} reasoning effort`)).toBe(true);
      }

      // The role navigation and the selected role's editor fields.
      expect(await page.$('nav[aria-label="Agent roles"] [aria-current="true"]')).not.toBeNull();

      for (const field of ['Label', 'Description', 'Instructions', 'Default tier', 'Default swarm preset']) {
        expect(await named(field)).toBe(true);
      }

      // The tool and skill membership lists, as named checkboxes.
      expect(await named('Tools: file')).toBe(true);
      expect(await named('Skills: audit-implementation')).toBe(true);
      await page.close();
    });
  }, 120_000);
});
