/**
 * Explore (`explore`, `explore-workspace`): the real pages over the gallery's Explore fixture (gallery-explore.tsx),
 * which answers `/api/explore` in the feed's own order. Kinu's own lead an unfiltered page and leave the feed below;
 * a kind or words show the feed alone. A blueprint's Install sends what its dialog chose, and the assistant goes Home.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import * as v from 'valibot';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

const SOON = { timeout: 15_000 } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();

  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'load' });

  return page;
}

const feedOf = (page: Page) => page.$$eval('[data-explore-item]', (cards) => cards.map((card) => card.getAttribute('data-explore-item')));

/** Waits until the feed is exactly `ids`, then answers it; a feed that never gets there is named in the failure. */
async function feedBecomes(page: Page, ids: readonly string[]): Promise<readonly (string | null)[]> {
  try {
    await page.waitForFunction((wanted) => JSON.stringify([...document.querySelectorAll('[data-explore-item]')].map((card) => card.getAttribute('data-explore-item'))) === wanted,
      SOON, JSON.stringify(ids));
  } catch (cause) {
    throw new Error(`the feed stayed ${JSON.stringify(await feedOf(page))}, never ${JSON.stringify(ids)}`, { cause });
  }

  return feedOf(page);
}

/** What the fixture was asked to install (gallery-explore.tsx `data-explore-installed`). */
const InstalledSchema = v.object({ id: v.string(), body: v.record(v.string(), v.unknown()) });

async function installed(page: Page): Promise<v.InferOutput<typeof InstalledSchema>> {
  await page.waitForFunction(() => document.documentElement.dataset.exploreInstalled !== undefined, SOON);

  return v.parse(InstalledSchema, JSON.parse(await page.$eval('html', (root) => root.dataset.exploreInstalled ?? 'null')));
}

describe('Explore', () => {
  test("Kinu's own lead an unfiltered page; a kind or words show the feed alone", async () => {
    await withGallery(async (gallery) => {
      for (const [theme, viewport] of [['dark', 'desktop'], ['light', 'mobile']] as const) {
        const page = await freshPage(gallery, 'explore', theme, viewport);

        await page.waitForSelector('[data-explore-hero="personal-assistant"]', SOON);
        expect(await page.$$eval('[data-explore-also]', (rows) => rows.map((row) => row.getAttribute('data-explore-also'))))
          .toEqual(['worker-on-call', 'release-manager', 'research-desk']);
        // The feed below holds everything else, Kinu's own not twice.
        expect(await feedBecomes(page, ['pr-board', 'issue-triage', 'worker-logs', 'firmware-lab', 'workers-health', 'do-sqlite-notes']))
          .toEqual(['pr-board', 'issue-triage', 'worker-logs', 'firmware-lab', 'workers-health', 'do-sqlite-notes']);

        // A kind shows the feed alone, Kinu's own in it.
        await page.click('[data-explore-kind-filter="workspace"]');
        await page.waitForFunction(() => document.querySelector('[data-explore-hero]') === null, SOON);
        expect(await feedBecomes(page, ['personal-assistant', 'worker-on-call', 'release-manager', 'research-desk', 'issue-triage', 'firmware-lab']))
          .toEqual(['personal-assistant', 'worker-on-call', 'release-manager', 'research-desk', 'issue-triage', 'firmware-lab']);

        // Words narrow it again.
        await page.type('[data-explore-search]', 'firmware');
        expect(await feedBecomes(page, ['firmware-lab'])).toEqual(['firmware-lab']);
        await page.close();
      }
    });
  }, 120_000);

  test("a blueprint's Install sends what its dialog chose; the assistant becomes Home", async () => {
    await withGallery(async (gallery) => {
      const assistant = await freshPage(gallery, 'explore-workspace&id=personal-assistant', 'dark', 'desktop');

      await assistant.waitForSelector('[data-blueprint-install]', SOON);
      await assistant.click('[data-blueprint-install]');
      await assistant.waitForSelector('[data-install-dialog="personal-assistant"]', SOON);
      expect(await assistant.$eval('input[aria-label="Its name"]', (input) => (input instanceof HTMLInputElement ? input.value : null))).toBe('Kinu');
      await assistant.click('[data-install-confirm]');

      const asked = await installed(assistant);

      expect(asked).toEqual({ id: 'personal-assistant', body: { agent: 'Kinu', brief: '08:00', home: true, utcOffsetMinutes: expect.any(Number) } });
      // Home: no route of Explore's draws it here.
      await assistant.waitForSelector('[data-gallery-blank]', SOON);
      await assistant.close();

      const release = await freshPage(gallery, 'explore-workspace&id=release-manager&install=1', 'light', 'mobile');

      await release.waitForSelector('[data-install-dialog="release-manager"]', SOON);
      await release.click('input[aria-label="Workspace name"]', { count: 3 });
      await release.type('input[aria-label="Workspace name"]', 'API Worker v2 release');
      await release.click('[data-install-confirm]');
      expect(await installed(release)).toEqual({ id: 'release-manager', body: { displayName: 'API Worker v2 release', utcOffsetMinutes: expect.any(Number) } });
    });
  }, 120_000);
});
