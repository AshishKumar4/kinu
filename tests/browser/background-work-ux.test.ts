/**
 * What works out of sight, over the composer (the owner, 2026-10-24: "show the user some good indication on the chat
 * interface that subagents are working in the background … nice and isn't distracting"). One quiet pill counts the
 * workspace's other agents and Main's jobs, and opens a sheet of each with a way to it; nothing at work, no pill.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const PILL = '[data-background-pill]';

const SHEET = '[data-background-sheet]';

async function workspace(gallery: Gallery, query: string, viewport = { width: 1280, height: 860 }): Promise<Page> {
  const page = await gallery.newPage();

  await page.setViewport(viewport);
  await page.goto(`${gallery.origin}/gallery.html?frame=workspaceshell${query}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-composer-root]');

  return page;
}

/** What the pill counts, by its own attributes. */
const counted = (page: Page) => page.$eval(PILL, (pill) => Object.fromEntries(
  ['needs', 'failed', 'working', 'finished', 'jobs'].map((name) => [name, Number(pill.getAttribute(`data-${name}`))]),
));

describe('work in the background', () => {
  test('a workspace with nothing at work shows no pill', async () => {
    await withGallery(async (gallery) => {
      const page = await workspace(gallery, '');

      try {
        expect(await page.$(PILL)).toBeNull();
      } finally { await page.close(); }
    });
  });

  test('counts the agents at work, the ones that need the person or failed, and Main\'s jobs, and lists each', async () => {
    await withGallery(async (gallery) => {
      const page = await workspace(gallery, '&agents=panel&jobs=running');

      try {
        await page.waitForSelector(PILL);
        const counts = await counted(page);

        await page.click(PILL);
        await page.waitForSelector(SHEET);
        const rows = await page.$$eval('[data-background-agent]', (list) => list.map((row) => `${row.getAttribute('data-background-agent') ?? ''}:${row.getAttribute('data-shown') ?? ''}`));
        const jobs = await page.$$eval('[data-background-job]', (list) => list.length);

        // Main is the chat itself and never a row; those that need the person come first.
        expect(rows.some((row) => row.startsWith('main:'))).toBe(false);
        expect(rows[0]?.endsWith(':waiting')).toBe(true);
        expect(rows.filter((row) => row.endsWith(':waiting')).length).toBe(counts.needs);
        expect(rows.filter((row) => row.endsWith(':failed')).length).toBe(counts.failed);
        expect(rows.filter((row) => row.endsWith(':working')).length).toBe(counts.working);
        expect({ needs: counts.needs > 0, failed: counts.failed > 0, working: counts.working > 0, jobs: counts.jobs, listed: jobs }).toEqual({ needs: true, failed: true, working: true, jobs: 1, listed: 1 });
      } finally { await page.close(); }
    });
  });

  test("a row goes to that agent's chat, and a job to the Work tab", async () => {
    await withGallery(async (gallery) => {
      const page = await workspace(gallery, '&agents=panel&jobs=running');

      try {
        await page.waitForSelector(PILL);
        await page.click(PILL);
        await page.click('[data-background-job]');
        await page.waitForSelector('nav[aria-label="Workspace"] button[aria-label="Work"][aria-current="true"]');
        // Kumo's popover animates out (`data-ending-style`) and stays mounted until it has: a look the frame the tab
        // switched found it still closing (UI gate, 2026-10-26, twice). Still red if it never closes.
        await page.waitForFunction((sheet) => document.querySelector(sheet) === null, {}, SHEET);

        await page.click(PILL);
        await page.click('[data-background-agent="actor-docs"]');
        await page.waitForSelector('[data-agent-pane="api-worker/agents/docs"]');
      } finally { await page.close(); }
    });
  });

  test('opens from the keyboard into its rows, and Escape gives focus back to the pill', async () => {
    await withGallery(async (gallery) => {
      const page = await workspace(gallery, '&agents=panel&jobs=running');

      try {
        await page.waitForSelector(PILL);
        await page.focus(PILL);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement?.closest('[data-background-sheet], [role="dialog"]') !== null);
        await page.keyboard.press('Tab');
        const inSheet = await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);

        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('[data-background-sheet]') === null);

        expect({ inSheet, back: await page.evaluate(() => document.activeElement?.hasAttribute('data-background-pill') ?? false) }).toEqual({ inSheet: true, back: true });
      } finally { await page.close(); }
    });
  });

  test('a helper that needs the person lifts its whole branch to the top', async () => {
    await withGallery(async (gallery) => {
      const page = await workspace(gallery, '&agents=panel&jobs=running');

      try {
        await page.waitForSelector(PILL);
        await page.click(PILL);
        await page.waitForSelector(SHEET);
        const shown = await page.$$eval('[data-background-agent]', (list) => list.map((row) => row.getAttribute('data-shown')));
        const lastNeed = shown.lastIndexOf('waiting');

        // Every row before the last that needs the person is one that does, or the branch it stands in.
        expect(shown.slice(0, lastNeed + 1).every((state) => state === 'waiting' || state === 'working')).toBe(true);
        expect(shown.slice(lastNeed + 1).includes('waiting')).toBe(false);
      } finally { await page.close(); }
    });
  });

  test('closes with the last thing it listed, so work that comes after opens a closed pill', async () => {
    await withGallery(async (gallery) => {
      const page = await workspace(gallery, '&jobs=running');

      try {
        await page.waitForSelector(PILL);
        await page.click(PILL);
        await page.waitForSelector(SHEET);
        await page.evaluate(() => { window.dispatchEvent(new CustomEvent('gallery:jobs', { detail: { running: false } })); });
        await page.waitForFunction(() => document.querySelector('[data-background-pill]') === null);
        await page.evaluate(() => { window.dispatchEvent(new CustomEvent('gallery:jobs', { detail: { running: true } })); });
        await page.waitForSelector(PILL);

        expect(await page.$(SHEET)).toBeNull();
      } finally { await page.close(); }
    });
  });

  // A short phone with a grown message: the room above the pill is less than any fixed share of the window.
  test('on a short phone the sheet keeps to the room above its pill', async () => {
    await withGallery(async (gallery) => {
      const page = await workspace(gallery, '&agents=panel&jobs=running', { width: 390, height: 420 });

      try {
        await page.waitForSelector(PILL);
        await page.type('[data-composer-root] textarea', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten');
        await page.click(PILL);
        await page.waitForSelector(SHEET);

        const room = await page.evaluate(() => {
          const sheet = document.querySelector('[data-background-sheet]')?.closest('[role="dialog"]')?.getBoundingClientRect();
          const pill = document.querySelector('[data-background-pill]')?.getBoundingClientRect();

          return { top: Math.round(sheet?.top ?? -1), bottom: Math.round(sheet?.bottom ?? 1e9), pill: Math.round(pill?.top ?? 0) };
        });

        expect(room.top >= 0 && room.bottom <= room.pill).toBe(true);
      } finally { await page.close(); }
    });
  });

  test('an agent that came to rest out of sight shows as finished until the person has seen the sheet', async () => {
    await withGallery(async (gallery) => {
      const page = await workspace(gallery, '&agents=panel');

      try {
        await page.waitForSelector(PILL);
        const before = await counted(page);

        await page.evaluate(() => { window.dispatchEvent(new CustomEvent('gallery:agent-rested', { detail: { key: 'actor-review' } })); });
        await page.waitForFunction((working) => Number(document.querySelector('[data-background-pill]')?.getAttribute('data-working')) === working - 1, {}, before.working);
        const rested = await counted(page);

        await page.click(PILL);
        const shown = await page.$eval('[data-background-agent="actor-review"]', (row) => row.getAttribute('data-shown'));

        await page.click(PILL);
        const after = await counted(page);

        expect({ finished: rested.finished, shown, cleared: after.finished }).toEqual({ finished: 1, shown: 'finished', cleared: 0 });
      } finally { await page.close(); }
    });
  });
});
