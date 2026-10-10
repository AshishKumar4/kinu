/**
 * A workspace's agents live in the left sidebar, reached from its All agents row: the person's chats, each with the
 * agents it started nested under it, then swarms and helpers in folded groups. A row opens that agent's chat in the
 * main area, a swarm worker opens view only, and Back returns the workspace list and focus. On a phone the sidebar is
 * the drawer.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const LIST = '[data-sidebar-agents="checkout-fixes"]';

async function shell(gallery: Gallery, width: number): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport({ width, height: 900 });
  await page.goto(`${gallery.origin}/gallery.html?frame=workspaceshell&agents=panel`, { waitUntil: 'networkidle0' });

  return page;
}

/** The sidebar has come to rest: its slide and any fold have finished moving, so a row is where a pointer finds it. */
async function still(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== 'running'));
}

/** Whether the agents list is the view a reader can reach: drawn and not inert. */
function listShown(page: Page): Promise<boolean> {
  return page.evaluate((list) => {
    const node = document.querySelector(list);

    return node !== null && node.closest('[inert]') === null;
  }, LIST);
}

describe('the sidebar drills into a workspace\'s agents', () => {
  test('chats lead, each with the agents it started under it; groups fold at the bottom; Back returns', async () => {
    await withGallery(async (gallery) => {
      const page = await shell(gallery, 1280);
      await page.waitForSelector('[data-agents-counter]');
      await page.click('[data-agents-counter]');
      await page.waitForFunction((list) => document.querySelector(list)?.closest('[inert]') === null, {}, LIST);
      await still(page);

      const top = await page.$$eval(`${LIST} nav > ul > li > [data-agent-row]`, (rows) => rows.map((row) => row.textContent));
      expect(top).toEqual(['Main', 'Fix SAVE20 coupon 500s', 'Should checkout support gift cards?', 'Speed up cart render', 'Review: payments refactor']);

      // A hire sits under the chat or agent that hired it, never beside the person's chats.
      const parentOf = (key: string) => page.$eval(`${LIST} [data-agent-row="${key}"]`, (row) => row.parentElement?.parentElement?.closest('li')?.querySelector('[data-agent-row]')?.getAttribute('data-agent-row'));
      expect(await parentOf('a-scout')).toBe('main');
      expect(await parentOf('a-check')).toBe('a-scout');
      expect(await parentOf('a-copy')).toBe('actor-docs');

      // Swarms and helpers are their own groups, folded until asked for; a helper's own hires nest under it there.
      const groups = await page.$$eval(`${LIST} section`, (all) => all.map((section) => [section.getAttribute('aria-label'), section.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')]));
      expect(groups).toEqual([['Swarms', 'false'], ['Background', 'false']]);
      expect(await parentOf('a-sampler')).toBe('a-refine');

      await page.click(`${LIST} [data-agent-row="a-scout"]`);
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/coupon-auditor"]');
      await page.waitForFunction((list) => document.querySelector(`${list} [data-agent-row="a-scout"]`)?.getAttribute('aria-current') === 'page', {}, LIST);

      await page.click(`${LIST} [data-agents-back]`);
      await page.waitForFunction((list) => document.querySelector(list)?.closest('[inert]') !== null, {}, LIST);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-agents-counter'))).toBe(true);
      await page.close();
    });
  });

  // 26244c765: the nested column's loader was a fresh closure each render, and the read it keyed re-ran on every answer.
  test('an agent nested under another opens on one read of its roster, which stays read', async () => {
    await withGallery(async (gallery) => {
      const page = await shell(gallery, 1280);
      await page.waitForSelector('[data-agents-counter]');
      await page.click('[data-agents-counter]');
      await page.waitForFunction((list) => document.querySelector(list)?.closest('[inert]') === null, {}, LIST);
      await still(page);
      await page.click(`${LIST} [data-agent-row="a-check"]`);
      await page.waitForFunction(() => Number(document.documentElement.dataset.galleryChildrenReads ?? '0') > 0);

      const frames = () => page.evaluate(() => new Promise<number>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(Number(document.documentElement.dataset.galleryChildrenReads ?? '0'))));
      }));

      const settled = await frames();

      // One lookup reads its live parent's roster, and the kept one its hirer's: at most two reads, and then none.
      expect(settled).toBeLessThanOrEqual(2);
      expect(await frames()).toBe(settled);
      await page.close();
    });
  });

  test('the bar\'s agents button opens the same list', async () => {
    await withGallery(async (gallery) => {
      const page = await shell(gallery, 1280);
      await page.waitForSelector('.p-bar button[aria-label="All agents"]');
      await page.click('.p-bar button[aria-label="All agents"]');
      await page.waitForFunction(() => document.querySelector('[data-sidebar-agents]')?.closest('[inert]') === null);
      await page.close();
    });
  });

  test('a swarm worker opens view only, and leaving the workspace ends the agents list', async () => {
    await withGallery(async (gallery) => {
      const page = await shell(gallery, 1280);
      await page.waitForSelector('[data-agents-counter]');
      await page.click('[data-agents-counter]');
      await page.waitForFunction((list) => document.querySelector(list)?.closest('[inert]') === null, {}, LIST);
      await still(page);

      await page.click(`${LIST} section[aria-label="Swarms"] [aria-expanded]`);
      await page.waitForFunction((list) => document.querySelector(`${list} section[aria-label="Swarms"] [inert]`) === null, {}, LIST);
      await still(page);
      await page.click(`${LIST} [data-agent-row="root-merge-1/root-merge-1-h0"]`);
      await page.waitForSelector('[data-view-only]');
      expect(await page.$('[data-agent-pane] textarea')).toBeNull();
      expect(await listShown(page)).toBe(true);

      await page.click('[data-rail] a[aria-label="Kinu home"]');
      await page.waitForSelector('[data-gallery-blank]');
      expect(await page.$(LIST)).toBeNull();
      await page.close();
    });
  });

  test('on a phone the drawer reaches the list, and a row closes it onto that chat', async () => {
    await withGallery(async (gallery) => {
      const page = await shell(gallery, 390);
      const drawn = `[data-drawer] ${LIST}`;
      await page.waitForSelector('.p-bar-menu button');
      await page.click('.p-bar-menu button');
      await page.waitForSelector('[data-drawer] [data-agents-counter]');
      await still(page);
      await page.click('[data-drawer] [data-agents-counter]');
      await page.waitForFunction((list) => document.querySelector(list)?.closest('[inert]') === null, {}, drawn);
      await still(page);

      await page.click(`${drawn} [data-agent-row="actor-docs"]`);
      await page.waitForFunction(() => document.querySelector('[data-drawer]') === null);
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/docs"]');
      await page.close();
    });
  });
});

// Before its first read answers, the sidebar says nothing about the account's workspaces: "No workspaces yet." then
// would be a false statement, and to a reader indistinguishable from an account that has none.
describe('the sidebar before the roster answers', () => {
  test('it is drawn busy, never empty, and then shows what the read answered', async () => {
    await withGallery(async (gallery) => {
      for (const roster of ['held', 'empty'] as const) {
        const page = await gallery.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(`${gallery.origin}/gallery.html?frame=workspaceshell&roster=${roster}`, { waitUntil: 'load' });
        await page.waitForSelector('nav[aria-label="Primary"]');

        const list = () => page.evaluate(() => ({
          busy: document.querySelector('[aria-busy="true"]') !== null,
          empty: document.body.innerText.includes('No workspaces yet.'),
          storefront: [...document.querySelectorAll('[data-rail] a[href^="/workspace/"]')].some((link) => link.textContent?.includes('Storefront')),
        }));

        try {
          if (roster === 'held') {
            expect(await list()).toEqual({ busy: true, empty: false, storefront: false });
            await page.evaluate(() => window.dispatchEvent(new Event('gallery:roster-release')));
            await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null);
            expect(await list()).toEqual({ busy: false, empty: false, storefront: true });
          } else {
            await page.waitForFunction(() => document.body.innerText.includes('No workspaces yet.'));
            expect((await list()).busy).toBe(false);
          }
        } finally {
          await page.evaluate(() => window.dispatchEvent(new Event('gallery:roster-release')));
          await page.close();
        }
      }
    });
  });
});

/** The colour a mascot is drawn in: its gradient's first stop. */
function mascotColours(page: Page, rows: string): Promise<string[]> {
  return page.$$eval(`${rows} .p-mascot stop`, (stops) => stops.filter((stop) => stop.getAttribute('offset') === '0').map((stop) => stop.getAttribute('stop-color') ?? ''));
}

// Production, 2026-10-08: the owner's chats and hires wore few colours between them, and the agents working out of
// sight, with no tab of their own, showed nowhere that they were.
describe('who is at work, and who is who', () => {
  test('each chat and each hire wears a colour no other agent of its workspace does', async () => {
    await withGallery(async (gallery) => {
      const page = await shell(gallery, 1280);

      try {
        await page.waitForSelector('[data-workspace-chat] .p-mascot');
        const chats = await mascotColours(page, '[data-workspace-chat]');
        expect({ drawn: chats.length, distinct: new Set(chats).size }).toEqual({ drawn: 5, distinct: 5 });

        await page.click('[data-agents-counter]');
        await page.waitForFunction((list) => document.querySelector(list)?.closest('[inert]') === null, {}, LIST);
        // The person's chats and the agents hired into them: every one its own colour, none a chat's.
        const agents = await mascotColours(page, `${LIST} [data-agent-row]`);
        expect(agents.length).toBeGreaterThan(chats.length);
        expect(new Set(agents).size).toBe(agents.length);
      } finally {
        await page.close();
      }
    });
  });

  // Production, 2026-10-08: a palette of twelve gave a workspace's thirteenth agent its first one's colour.
  test('a workspace\'s first 24 agents, born one after another, wear 24 colours', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();

      try {
        await page.goto(`${gallery.origin}/gallery.html?frame=characters`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-mascot-size="16"] [data-mascot-state="idle"] .p-mascot');
        const worn = await mascotColours(page, '[data-mascot-size="16"] [data-mascot-state="idle"]');

        expect({ drawn: worn.length, distinct: new Set(worn).size }).toEqual({ drawn: 24, distinct: 24 });
      } finally {
        await page.close();
      }
    });
  });

  test('agents at work with no tab spin on the All agents row and are counted on the bar\'s agents button', async () => {
    await withGallery(async (gallery) => {
      // The fixture's out-of-sight workers: the coupon auditor it hired, and two swarm workers.
      const busy = await shell(gallery, 1280);
      // Nothing works out of sight here: every agent has a tab, and all of them are idle.
      const quiet = await gallery.newPage();
      await quiet.setViewport({ width: 1280, height: 900 });
      await quiet.goto(`${gallery.origin}/gallery.html?frame=workspaceshell`, { waitUntil: 'networkidle0' });

      const shown = (page: Page) => page.evaluate(() => ({
        spinning: document.querySelector('[data-agents-counter] [data-status="working"]') !== null,
        counted: document.querySelector('button[aria-label="All agents"] [data-working-agents]')?.textContent ?? null,
      }));

      try {
        await busy.waitForSelector('[data-agents-counter]');
        await quiet.waitForSelector('[data-agents-counter]');
        expect({ busy: await shown(busy), quiet: await shown(quiet) })
          .toEqual({ busy: { spinning: true, counted: '3' }, quiet: { spinning: false, counted: null } });
      } finally {
        await busy.close();
        await quiet.close();
      }
    });
  });
});
