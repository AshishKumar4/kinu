/**
 * A listed slate's page (sharing v7 `gallery-slate`): the real page over the gallery's listings fixture
 * (gallery-listings.tsx), which answers `/api/gallery` as the Gallery's contract says (room-api.ts). A listed slate opens
 * by its link, forks with its key, stars, and can be reported; its hero shows its picture, and More like it is Explore's
 * apps of its category. Signed out, the same page sits in a bar with Sign in.
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

const liked = (page: Page) => page.$$eval('[data-gallery-like] [data-explore-item]', (cards) => cards.map((card) => card.getAttribute('data-explore-item')));

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

describe("a listed slate's page", () => {
  test("a listed slate's page: Open by its link, Fork, Star, its counts, Report", async () => {
    await withGallery(async (gallery) => {
      for (const [theme, viewport] of [['light', 'desktop'], ['dark', 'mobile']] as const) {
        const page = await freshPage(gallery, 'gallery-slate&slate=pr-board', theme, viewport);

        try {
          await page.waitForSelector('[data-gallery-slate="pr-board"]', SOON);
          expect(await page.$('[data-gallery-hero] img[data-slate-picture]')).not.toBeNull();
          expect(await page.$eval('[data-gallery-open]', (link) => link.getAttribute('href'))).toBe('/s/ravi/pr-board?k=p8x2');
          expect(await page.$('[data-gallery-people]')).not.toBeNull();
          expect(await page.$('[data-gallery-forks]')).not.toBeNull();

          // Star, then take it back: each is asked of the Gallery, and the count follows.
          expect(await page.$eval('[data-gallery-viewers]', (line) => line.textContent ?? '')).toMatch(/^Opened by [\d,]+ people$/);
          const stars = await page.$eval('[data-gallery-star]', (button) => Number(button.getAttribute('data-gallery-stars')));
          const star = await askedAfter(page, '/api/gallery/star', () => page.click('[data-gallery-star]'));

          expect(JSON.parse(star.body ?? '{}')).toEqual({ workspace: 'ravi', slate: 'pr-board', on: true });
          await page.waitForSelector(`[data-gallery-star][aria-pressed="true"][data-gallery-stars="${String(stars + 1)}"]`, SOON);
          await page.click('[data-gallery-star]');
          await page.waitForSelector(`[data-gallery-star][aria-pressed="false"][data-gallery-stars="${String(stars)}"]`, SOON);

          // What of a visitor's own it uses, each asking before it reads.
          expect(await page.$$eval('[data-gallery-need]', (rows) => rows.map((row) => row.getAttribute('data-gallery-need')))).toEqual(['github', 'ai']);

          // Fork picks a workspace for the copy of its code.
          await page.click('[data-gallery-fork]');
          await page.waitForSelector('[data-fork-target]', SOON);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => document.querySelector('[data-fork-target]') === null, SOON);

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
        await back.waitForSelector('[data-fork-target]', SOON);
      } finally {
        await back.close();
      }

      // One with no counts yet draws none.
      const lent = await freshPage(gallery, 'gallery-slate&slate=digest', 'dark', 'desktop');

      try {
        await lent.waitForSelector('[data-gallery-slate="digest"]', SOON);
        expect(await lent.$('[data-gallery-people]')).toBeNull();
        // One that uses nothing of a visitor's says so.
        expect(await lent.$('[data-gallery-needs]')).not.toBeNull();
        expect(await lent.$('[data-gallery-need]')).toBeNull();
        expect(await lent.$('[data-gallery-forks]')).toBeNull();
        // More like it: Explore's apps of its category, never itself.
        await lent.waitForSelector('[data-gallery-like] [data-explore-item]', SOON);
        expect(await liked(lent)).toEqual(['standup']);
      } finally {
        await lent.close();
      }
    });
  });

  test('signed out: the same page under a bar with Sign in; Open is the link, and Fork, Star and Report sign in first', async () => {
    await withGallery(async (gallery) => {
      for (const [theme, viewport] of [['dark', 'desktop'], ['light', 'mobile']] as const) {
        for (const [control, forking] of [['[data-gallery-star]', null], ['[data-gallery-report]', null], ['[data-gallery-fork]', '1']] as const) {
          const slate = await freshPage(gallery, 'gallery-slate&slate=pr-board&signed=out', theme, viewport);

          try {
            await slate.waitForSelector('[data-gallery-public] [data-gallery-slate="pr-board"]', SOON);
            expect(await slate.$('nav[aria-label="Primary"]')).toBeNull();
            expect(await slate.$('[data-gallery-sign-in]')).not.toBeNull();
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
