/**
 * The Gallery (sharing v7 `gallery`, `gallery-slate`): the real pages over the gallery's listings fixture
 * (gallery-listings.tsx), which answers `/api/gallery` as the Gallery's contract says (room-api.ts). Sort, category and
 * search ask the server again; a listed slate opens by its link, forks with its key, stars, and can be reported. Every
 * card and hero shows the slate's picture where it has one. Signed out, the same pages sit in a bar with Sign in.
 */
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { detach } from '@kinu.run/core/obs';
import type { Page } from 'puppeteer';
import * as v from 'valibot';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

const SOON = { timeout: 15_000 } as const;

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A listed slate's picture, through the Gallery's own read: `/api/gallery/<ws>/<slate>/picture/<digest>`. */
const PICTURE = /^\/api\/gallery\/[^/]+\/[^/]+\/picture\/[a-f0-9]{64}$/u;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();

  // The gallery serves no pictures: each picture read is answered here.
  await page.setRequestInterception(true);
  page.on('request', (request) => detach(Effect.promise(async () => {
    if (PICTURE.test(new URL(request.url()).pathname)) await request.respond({ status: 200, contentType: 'image/png', body: PIXEL });
    else await request.continue();
  })));
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'load' });

  return page;
}

const listed = (page: Page, within = '') => page.$$eval(`${within} [data-gallery-listing]`, (tiles) => tiles.map((tile) => tile.getAttribute('data-gallery-listing')));

/** The fixture's record of what the page asked the Gallery (gallery-listings.tsx): its fetches never reach the network. */
const AskedSchema = v.array(v.object({ path: v.string(), search: v.string(), body: v.nullable(v.string()) }));

type Asked = v.InferOutput<typeof AskedSchema>[number];

const askedSoFar = async (page: Page) => {
  const text = await page.$eval('html', (root) => root.getAttribute('data-gallery-asked'));

  return v.parse(AskedSchema, JSON.parse(text ?? '[]'));
};

/** The first thing the page asked of `path` once `act` ran. */
async function askedAfter(page: Page, path: string, act: () => Promise<void>): Promise<Asked> {
  const before = (await askedSoFar(page)).length;

  await act();
  await page.waitForFunction((from, wanted) => (document.documentElement.getAttribute('data-gallery-asked-paths') ?? '').split('\n').slice(from).includes(wanted),
    SOON, before, path);

  const found = (await askedSoFar(page)).slice(before).find((each) => each.path === path);

  if (found === undefined) throw new Error(`nothing asked of ${path}`);

  return found;
}

const searched = async (page: Page, act: () => Promise<void>) => new URLSearchParams((await askedAfter(page, '/api/gallery', act)).search);

describe('the Gallery', () => {
  test('lists what people listed; sort, category and search ask again; a next page appends', async () => {
    await withGallery(async (gallery) => {
      for (const [theme, viewport] of [['dark', 'desktop'], ['light', 'mobile']] as const) {
        const page = await freshPage(gallery, 'gallery-list', theme, viewport);

        try {
          await page.waitForSelector('[data-gallery-listing]', SOON);
          // This week's top two lead the unfiltered page.
          expect(await page.$$eval('[data-gallery-featured]', (cards) => cards.map((card) => card.getAttribute('data-gallery-featured')))).toEqual(['pr-board', 'trip']);
          expect(await page.$eval('[data-gallery-sort="trending"]', (chip) => chip.getAttribute('aria-pressed'))).toBe('true');

          // Each card shows its slate's picture through the Gallery's read.
          expect(await page.$eval('[data-gallery-listing="pr-board"] img[data-slate-picture]', (img) => new URL(img.getAttribute('src') ?? '', location.origin).pathname)).toMatch(PICTURE);
          expect(await page.$('[data-gallery-featured="trip"] img[data-slate-picture]')).not.toBeNull();

          // A page at a time: the next one joins it.
          expect(await listed(page)).toHaveLength(6);
          expect((await searched(page, () => page.click('[data-gallery-more]'))).get('page')).toBe('1');
          await page.waitForFunction(() => document.querySelectorAll('[data-gallery-listing]').length === 7, SOON);
          expect(await page.$('[data-gallery-more]')).toBeNull();
          // A slate with no picture yet keeps its letter.
          expect(await page.$('[data-gallery-listing="poll"] img[data-slate-picture]')).toBeNull();

          const bySort = await searched(page, () => page.click('[data-gallery-sort="stars"]'));

          expect([bySort.get('sort'), bySort.get('page')]).toEqual(['stars', '0']);
          await page.waitForSelector('[data-gallery-sort="stars"][aria-pressed="true"]', SOON);

          const byCategory = await searched(page, () => page.click('[data-gallery-category="home"]'));

          expect(byCategory.get('category')).toBe('home');
          await page.waitForFunction(() => document.querySelectorAll('[data-gallery-listing]').length === 2, SOON);
          expect(await listed(page)).toEqual(['habits', 'recipe']);
          expect(await page.$('[data-gallery-featured]')).toBeNull();

          await page.click('[data-gallery-category="all"]');
          await page.waitForFunction(() => document.querySelectorAll('[data-gallery-listing]').length === 6, SOON);

          const bySearch = await searched(page, () => page.type('[data-gallery-search]', 'scale'));

          expect(bySearch.get('q')).toContain('s');
          await page.waitForFunction(() => document.querySelectorAll('[data-gallery-listing]').length === 1, SOON);
          expect(await listed(page)).toEqual(['recipe']);

          await page.type('[data-gallery-search]', 'zzz');
          await page.waitForSelector('[data-gallery-no-match]', SOON);

          // A card opens its slate's own page.
          await page.click('[data-gallery-search]', { count: 3 });
          await page.keyboard.press('Backspace');
          await page.waitForSelector('[data-gallery-listing="trip"] a', SOON);
          await page.click('[data-gallery-listing="trip"] a');
          await page.waitForSelector('[data-gallery-slate="trip"]', SOON);
        } finally {
          await page.close();
        }
      }
    });
  });

  test("a listed slate's page: Open by its link, Fork with its key, Star, what it uses, the files, Report", async () => {
    await withGallery(async (gallery) => {
      for (const [theme, viewport] of [['light', 'desktop'], ['dark', 'mobile']] as const) {
        const page = await freshPage(gallery, 'gallery-slate&slate=pr-board', theme, viewport);

        try {
          await page.waitForSelector('[data-gallery-slate="pr-board"]', SOON);
          expect(await page.$('[data-gallery-hero] img[data-slate-picture]')).not.toBeNull();
          expect(await page.$eval('[data-gallery-open]', (link) => link.getAttribute('href'))).toBe('/s/ravi/pr-board?k=p8x2');
          expect(await page.$$eval('[data-gallery-need]', (rows) => rows.map((row) => row.getAttribute('data-gallery-need')))).toEqual(['github']);
          expect(await page.$eval('[data-gallery-reads-author]', (row) => row.getAttribute('data-gallery-reads-author'))).toBe('false');
          expect(await page.$$eval('[data-gallery-file]', (rows) => rows.map((row) => row.textContent))).toEqual(['package.json', 'server.ts', 'board.tsx', 'github.ts', 'README.md']);
          expect(await page.$('[data-gallery-people]')).not.toBeNull();
          expect(await page.$('[data-gallery-forks]')).not.toBeNull();
          // More like it: the same category, never itself.
          expect(await listed(page, '[data-gallery-like]')).not.toContain('pr-board');

          // Star, then take it back: each is asked of the Gallery, and the count follows.
          const stars = await page.$eval('[data-gallery-star]', (button) => Number(button.getAttribute('data-gallery-stars')));
          const star = await askedAfter(page, '/api/gallery/star', () => page.click('[data-gallery-star]'));

          expect(JSON.parse(star.body ?? '{}')).toEqual({ workspace: 'ravi', slate: 'pr-board', on: true });
          await page.waitForSelector(`[data-gallery-star][aria-pressed="true"][data-gallery-stars="${String(stars + 1)}"]`, SOON);
          await page.click('[data-gallery-star]');
          await page.waitForSelector(`[data-gallery-star][aria-pressed="false"][data-gallery-stars="${String(stars)}"]`, SOON);

          // Fork admits them by the link's key, as opening it does.
          await page.click('[data-gallery-fork]');
          await page.waitForSelector('[data-fork-needs]', SOON);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => document.querySelector('input[name="fork-target"]') === null, SOON);

          await page.click('[data-gallery-report]');
          await page.type('[data-gallery-report-reason]', 'It asks for a token in its first screen.');
          const report = await askedAfter(page, '/api/gallery/report', () => page.click('[data-gallery-report-send]'));

          expect(JSON.parse(report.body ?? '{}')).toEqual({ workspace: 'ravi', slate: 'pr-board', reason: 'It asks for a token in its first screen.' });
          await page.waitForSelector('[data-gallery-reported]', SOON);
        } finally {
          await page.close();
        }
      }

      // Back from signing in to fork: the picker is open.
      const back = await freshPage(gallery, 'gallery-slate&slate=pr-board&fork=1', 'light', 'desktop');

      try {
        await back.waitForSelector('input[name="fork-target"]', SOON);
      } finally {
        await back.close();
      }

      // A slate run with its author's own lend says so; one with no counts yet draws none.
      const lent = await freshPage(gallery, 'gallery-slate&slate=digest', 'dark', 'desktop');

      try {
        await lent.waitForSelector('[data-gallery-slate="digest"]', SOON);
        expect(await lent.$eval('[data-gallery-reads-author]', (row) => row.getAttribute('data-gallery-reads-author'))).toBe('true');
        expect(await lent.$('[data-gallery-people]')).toBeNull();
        expect(await lent.$('[data-gallery-forks]')).toBeNull();
      } finally {
        await lent.close();
      }
    });
  });

  test('signed out: the same pages under a bar with Sign in; Open is the link, and Fork, Star and Report sign in first', async () => {
    await withGallery(async (gallery) => {
      for (const [theme, viewport] of [['dark', 'desktop'], ['light', 'mobile']] as const) {
        const list = await freshPage(gallery, 'gallery-list&signed=out', theme, viewport);

        try {
          await list.waitForSelector('[data-gallery-public] [data-gallery-listing]', SOON);
          expect(await list.$('nav[aria-label="Primary"]')).toBeNull();
          expect(await list.$('[data-gallery-sign-in]')).not.toBeNull();
        } finally {
          await list.close();
        }

        for (const [control, forking] of [['[data-gallery-star]', null], ['[data-gallery-report]', null], ['[data-gallery-fork]', '1']] as const) {
          const slate = await freshPage(gallery, 'gallery-slate&slate=pr-board&signed=out', theme, viewport);

          try {
            await slate.waitForSelector('[data-gallery-public] [data-gallery-slate="pr-board"]', SOON);
            expect(await slate.$eval('[data-gallery-open]', (link) => link.getAttribute('href'))).toBe('/s/ravi/pr-board?k=p8x2');

            const [login] = await Promise.all([
              slate.waitForRequest((sent) => new URL(sent.url()).pathname === '/login', SOON),
              slate.click(control),
            ]);

            const back = new URL(new URL(login.url()).searchParams.get('return_to') ?? '', gallery.origin);

            expect([back.searchParams.get('slate'), back.searchParams.get('fork')]).toEqual(['pr-board', forking]);
          } finally {
            await slate.close();
          }
        }
      }
    });
  });
});
