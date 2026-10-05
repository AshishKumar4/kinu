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
      expect(top).toEqual(['Main', 'Release notes', 'Perf pass on checkout', 'Currency formatting']);

      // A hire sits under the chat or agent that hired it, never beside the person's chats.
      const parentOf = (key: string) => page.$eval(`${LIST} [data-agent-row="${key}"]`, (row) => row.parentElement?.parentElement?.closest('li')?.querySelector('[data-agent-row]')?.getAttribute('data-agent-row'));
      expect(await parentOf('a-scout')).toBe('main');
      expect(await parentOf('a-check')).toBe('a-scout');
      expect(await parentOf('a-copy')).toBe('actor-docs');

      // Swarms and helpers are their own groups, folded until asked for.
      const groups = await page.$$eval(`${LIST} section`, (all) => all.map((section) => [section.getAttribute('aria-label'), section.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')]));
      expect(groups).toEqual([['Swarms', 'false'], ['Background', 'false']]);

      await page.click(`${LIST} [data-agent-row="a-scout"]`);
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/coupon-auditor"]');
      await page.waitForFunction((list) => document.querySelector(`${list} [data-agent-row="a-scout"]`)?.getAttribute('aria-current') === 'page', {}, LIST);

      await page.click(`${LIST} [data-agents-back]`);
      await page.waitForFunction((list) => document.querySelector(list)?.closest('[inert]') !== null, {}, LIST);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-agents-counter'))).toBe(true);
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
