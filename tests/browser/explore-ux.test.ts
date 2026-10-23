/**
 * Explore (`explore`, `explore-workspace`): the real pages over the gallery's Explore fixture (gallery-explore.tsx),
 * which answers `/api/explore` in the feed's own order. Kinu's own lead an unfiltered page and leave the feed below;
 * a kind or words show the feed alone. A blueprint's Install sends what its dialog chose, and the assistant goes Home;
 * once it is theirs, the sidebar lists it nowhere and its own address opens Home.
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

/** What a visitor's page asked of an account (gallery-explore.tsx `data-explore-account-reads`): nothing, read rightly. */
const accountReads = async (page: Page): Promise<readonly string[]> => v.parse(v.array(v.string()), JSON.parse(await page.$eval('html', (root) => root.dataset.exploreAccountReads ?? '[]')));

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
        await page.click('[data-explore-filters] [data-segment="workspace"]');
        await page.waitForFunction(() => document.querySelector('[data-explore-hero]') === null, SOON);
        expect(await feedBecomes(page, ['personal-assistant', 'worker-on-call', 'release-manager', 'research-desk', 'issue-triage', 'firmware-lab']))
          .toEqual(['personal-assistant', 'worker-on-call', 'release-manager', 'research-desk', 'issue-triage', 'firmware-lab']);

        // Words narrow it again.
        await page.type('[data-explore-search]', 'firmware');
        expect(await feedBecomes(page, ['firmware-lab'])).toEqual(['firmware-lab']);
        await page.close();
      }
    });
  });

  // The owner, 2026-10-23: the assistant's picture is Kinu's chat, so it is shown in the page's mode; a slate's picture
  // is the slate's own look whatever the page's mode.
  test("the assistant's picture follows the page's light or dark, on Explore and its own page; a slate's keeps its look", async () => {
    await withGallery(async (gallery) => {
      for (const theme of ['light', 'dark'] as const) {
        const page = await freshPage(gallery, 'explore', theme, 'desktop');
        const assistant = theme === 'light' ? 'assistant-light' : 'assistant';

        await page.waitForSelector('[data-explore-hero="personal-assistant"] img[data-blueprint-picture]', SOON);
        expect(await page.$eval('[data-explore-hero="personal-assistant"] img[data-blueprint-picture]', (img) => img.getAttribute('data-blueprint-picture'))).toBe(assistant);
        expect(await page.$$eval('[data-explore-also] img[data-blueprint-picture]', (images) => images.map((img) => img.getAttribute('data-blueprint-picture'))))
          .toEqual(['deploys', 'release', 'report']);

        // Its file is there to load, in either mode.
        await page.waitForFunction(() => {
          const img = document.querySelector('[data-explore-hero="personal-assistant"] img');

          return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
        }, SOON);

        await page.goto(`${gallery.origin}/gallery.html?frame=explore-workspace&id=personal-assistant`, { waitUntil: 'load' });
        await page.waitForSelector('[data-blueprint-page] img[data-blueprint-picture]', SOON);
        expect(await page.$eval('[data-blueprint-page] img[data-blueprint-picture]', (img) => img.getAttribute('data-blueprint-picture'))).toBe(assistant);
        await page.close();
      }
    });
  });

  test("a blueprint's Install sends what its dialog chose; the assistant becomes Home", async () => {
    await withGallery(async (gallery) => {
      const assistant = await freshPage(gallery, 'explore-workspace&id=personal-assistant', 'dark', 'desktop');

      await assistant.waitForSelector('[data-blueprint-install]', SOON);
      await assistant.click('[data-blueprint-install]');
      await assistant.waitForSelector('[data-install-dialog="personal-assistant"]', SOON);
      expect(await assistant.$eval('input[aria-label="Its name"]', (input) => (input instanceof HTMLInputElement ? input.value : null))).toBe('Kinu');
      await assistant.click('[data-install-confirm]');

      const asked = await installed(assistant);

      // The workspace takes its assistant's name, so the roster calls Home what Home's bar does.
      expect(asked).toEqual({ id: 'personal-assistant', body: { displayName: 'Kinu', agent: 'Kinu', brief: '08:00', home: true, timeZone: expect.any(String) } });
      // Home: the fixture marks it, and draws no Home of its own.
      await assistant.waitForSelector('[data-gallery-home]', SOON);
      await assistant.close();

      const release = await freshPage(gallery, 'explore-workspace&id=release-manager&install=1', 'light', 'mobile');

      await release.waitForSelector('[data-install-dialog="release-manager"]', SOON);
      await release.click('input[aria-label="Workspace name"]', { count: 3 });
      await release.type('input[aria-label="Workspace name"]', 'API Worker v2 release');
      await release.click('[data-install-confirm]');
      expect(await installed(release)).toEqual({ id: 'release-manager', body: { displayName: 'API Worker v2 release', timeZone: expect.any(String) } });
    });
  });

  test("a blueprint's Star stars it as the person; the assistant they have opens on Home", async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'explore-workspace&id=release-manager', 'light', 'desktop');

      await page.waitForSelector('[data-blueprint-star]', SOON);
      const before = await page.$eval('[data-blueprint-star]', (button) => [button.getAttribute('aria-pressed'), button.textContent]);

      expect(before).toEqual(['false', 'Star702']);
      await page.click('[data-blueprint-star]');
      await page.waitForFunction(() => document.querySelector('[data-blueprint-star]')?.getAttribute('aria-pressed') === 'true', SOON);
      expect(await page.$eval('[data-blueprint-star]', (button) => button.textContent)).toBe('Starred703');
      expect(JSON.parse(await page.$eval('html', (root) => root.dataset.exploreStarred ?? 'null'))).toEqual({ id: 'release-manager', body: { on: true } });
      await page.close();

      const had = await freshPage(gallery, 'explore-workspace&id=personal-assistant&assistant=1', 'dark', 'mobile');

      await had.waitForSelector('[data-blueprint-open]', SOON);
      expect(await had.$('[data-blueprint-install]')).toBeNull();
      expect(await had.$eval('[data-blueprint-open]', (link) => link.getAttribute('href'))).toBe('/');
      await had.close();

      const feed = await freshPage(gallery, 'explore&assistant=1', 'light', 'desktop');

      await feed.waitForSelector('[data-explore-hero="personal-assistant"] [data-explore-installed]', SOON);
    });
  });

  test('the assistant they have is Home: the sidebar lists it nowhere, and its own address opens Home, never a workbench', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'explore&assistant=1', 'light', 'desktop');
      const listed = () => page.$$eval('a[href^="/workspace/"]', (links) => links.map((link) => link.getAttribute('href')));

      await page.waitForSelector('a[href^="/workspace/"]', SOON);
      expect((await listed()).length).toBeGreaterThan(0);
      expect(await listed()).not.toContain('/workspace/personal-assistant-4f2a');
      await page.close();

      const opened = await gallery.newPage();

      // The workbench's bar is the one with no layout named; the bare bar waits for the roster, held here 1.5 s.
      await opened.evaluateOnNewDocument(() => {
        const drawn: string[] = [];

        new MutationObserver(() => {
          const bar = document.querySelector('[data-workspace-bar]');
          const layout = bar?.getAttribute('data-layout') ?? 'workbench';

          if (bar === null || drawn.at(-1) === layout) return;
          drawn.push(layout);
          document.documentElement.dataset.barsDrawn = drawn.join(' ');
        }).observe(document, { childList: true, subtree: true, attributeFilter: ['data-layout'] });
      });
      await opened.goto(`${gallery.origin}/gallery.html?frame=explore&assistant=1&at=assistant`, { waitUntil: 'load' });
      await opened.waitForSelector('[data-gallery-home]', SOON);
      const drawn = (await opened.$eval('html', (root) => root.dataset.barsDrawn ?? '')).split(' ').filter((bar) => bar !== '');

      expect(drawn).toContain('pending');
      expect(drawn).not.toContain('workbench');
    });
  });

  test('with the assistant as Home, New workspace still makes one: the pencil opens the mission and its words become the workspace', async () => {
    await withGallery(async (gallery) => {
      for (const viewport of ['desktop', 'mobile'] as const) {
        const page = await freshPage(gallery, 'explore&assistant=1', 'light', viewport);

        // The sidebar's pencil on a desktop, the header's on a phone: whichever New workspace is on screen.
        const pencil = 'a[aria-label="New workspace"]';

        await page.waitForFunction((selector) => [...document.querySelectorAll(selector)].some((link) => link instanceof HTMLElement && link.offsetParent !== null), SOON, pencil);
        await page.$$eval(pencil, (links) => {
          const shown = links.find((link) => link instanceof HTMLElement && link.offsetParent !== null);

          if (shown instanceof HTMLElement) shown.click();
        });
        await page.waitForSelector('#workspace-mission', SOON);
        await page.type('#workspace-mission', 'Keep the api Worker deployed and healthy.');
        await page.click('form:has(#workspace-mission) button[type="submit"]');
        await page.waitForSelector('[data-gallery-blank]', SOON);
        expect(JSON.parse(await page.$eval('html', (root) => root.dataset.exploreCreated ?? 'null'))).toMatchObject({ purpose: 'Keep the api Worker deployed and healthy.' });
        await page.close();
      }
    });
  });

  // rc28 walkthrough: Explore's API was public, its pages were not; a visitor was sent to sign in before seeing anything.
  test('signed out: Explore and a blueprint draw under the public bar and read nothing of an account; Install and Star sign in first', async () => {
    await withGallery(async (gallery) => {
      for (const [theme, viewport] of [['dark', 'desktop'], ['light', 'mobile']] as const) {
        const feed = await freshPage(gallery, 'explore&signed=out', theme, viewport);

        try {
          await feed.waitForSelector('[data-gallery-public] [data-explore-hero="personal-assistant"]', SOON);
          expect(await feed.$('nav[aria-label="Primary"]')).toBeNull();
          expect(await accountReads(feed)).toEqual([]);
        } finally {
          await feed.close();
        }

        for (const [control, intent] of [['[data-blueprint-install]', '1'], ['[data-blueprint-star]', null]] as const) {
          const page = await freshPage(gallery, 'explore-workspace&id=personal-assistant&signed=out', theme, viewport);

          try {
            await page.waitForSelector('[data-gallery-public] [data-blueprint-page="personal-assistant"]', SOON);
            // Read while the page is still the blueprint's: the press below leaves it for sign-in, and a read racing that
            // navigation finds its context gone (armada 20261020213324-3ed3be10).
            expect(await accountReads(page)).toEqual([]);

            const signIns: string[] = [];

            page.on('request', (sent) => {
              if (sent.isNavigationRequest() && new URL(sent.url()).pathname === '/login') signIns.push(sent.url());
            });

            // The press and the navigation it causes, awaited together: nothing reads the page it leaves.
            const [login] = await Promise.all([
              page.waitForRequest((sent) => new URL(sent.url()).pathname === '/login', SOON),
              page.waitForNavigation({ waitUntil: 'domcontentloaded', ...SOON }),
              page.click(control),
            ]);

            const back = new URL(new URL(login.url()).searchParams.get('return_to') ?? '', gallery.origin);

            expect([back.searchParams.get('id'), back.searchParams.get('install')]).toEqual(['personal-assistant', intent]);
            // One press, one trip to sign-in: the page is left once.
            expect(signIns).toHaveLength(1);
          } finally {
            await page.close();
          }
        }
      }
    });
  });
});
