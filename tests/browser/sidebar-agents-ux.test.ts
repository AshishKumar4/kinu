/**
 * A workspace's agents live in the left sidebar, drilled into from the chat's Agents control: sections, each row
 * with its figures, a row opening that agent's chat in the main chat area, a swarm worker view only, and Back
 * returning focus to the control. On a phone the sidebar is the drawer.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const LIST = '[data-sidebar-agents="checkout-fixes"]';

async function shell(gallery: Gallery, width: number): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport({ width, height: 900 });
  await page.goto(`${gallery.origin}/gallery.html?frame=workspaceshell&agents=panel`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-agents-counter]');

  return page;
}

/** Each section's title and its rows' names, as a reader meets them. */
function sections(page: Page): Promise<[string, string[]][]> {
  return page.$$eval(`${LIST} section`, (all) => all.map((section): [string, string[]] => [
    section.getAttribute('aria-label') ?? '',
    [...section.querySelectorAll('[data-agent-row]')].map((row) => row.querySelector('.p-row-text')?.firstChild?.textContent ?? ''),
  ]));
}

describe('the sidebar drills into a workspace\'s agents', () => {
  test('the Agents control lists every agent by section with its figures, a row opens its chat, and Back returns', async () => {
    await withGallery(async (gallery) => {
      const page = await shell(gallery, 1280);

      // Folded, the lane unfolds for the list.
      await page.click('[data-rail-collapse]');
      await page.waitForSelector('[data-rail-collapsed]');
      await page.click('[data-agents-counter]');
      await page.waitForSelector(LIST);
      expect(await page.$('[data-rail-collapsed]')).toBeNull();
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H2');

      expect(await sections(page)).toEqual([
        ['Main', ['Main']],
        ['Yours', ['Docs writer']],
        ['Hired', ['Coupon auditor', 'Checkout tester']],
        ['Swarm · view only', ['packages/checkout/src/apply-coupon.ts', 'packages/cart/src/serializer.ts', 'packages/checkout/src/pricing.ts']],
        ['Background', ['Prompt refiner']],
      ]);
      expect(await page.$eval(`${LIST} [data-agent-row="a-scout"] [data-agent-figures]`, (line) => line.textContent))
        .toBe('48.9k tok · $0.110 · 7m · 91% cached');
      // A figure nothing recorded is left out, never shown as zero.
      expect(await page.$eval(`${LIST} [data-agent-row="a-check"] [data-agent-figures]`, (line) => line.textContent)).toBe('6.1k tok · 45s');
      // A chat the owner made has no parent line; one an agent hired names it.
      expect(await page.$(`${LIST} [data-agent-row="actor-docs"]`).then((row) => row?.evaluate((node) => node.textContent))).not.toContain('from');
      expect(await page.$eval(`${LIST} [data-agent-row="a-scout"]`, (row) => row.textContent)).toContain('from Main');
      // The tester sits under the auditor that hired it.
      const indent = (key: string) => page.$eval(`${LIST} [data-agent-row="${key}"]`, (row) => row.getBoundingClientRect().left + parseFloat(getComputedStyle(row).paddingLeft));
      expect(await indent('a-check')).toBeGreaterThan(await indent('a-scout'));
      expect(await page.$eval(`${LIST} [data-agent-row="main"]`, (row) => row.getAttribute('aria-current'))).toBe('true');

      await page.click(`${LIST} [data-agent-row="a-scout"]`);
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/coupon-auditor"]');
      // Moving between the workspace's agents keeps the list, now marking the one shown.
      await page.waitForFunction((list) => document.querySelector(`${list} [data-agent-row="a-scout"]`)?.getAttribute('aria-current') === 'true', {}, LIST);

      await page.click(`${LIST} [data-agents-back]`);
      await page.waitForFunction((list) => document.querySelector(list) === null, {}, LIST);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-agents-counter'))).toBe(true);
      await page.close();
    });
  });

  test('a swarm worker opens view only, and leaving the workspace ends the agents list', async () => {
    await withGallery(async (gallery) => {
      const page = await shell(gallery, 1280);
      await page.click('[data-agents-counter]');
      await page.waitForSelector(LIST);

      await page.click(`${LIST} [data-agent-row="root-merge-1/root-merge-1-h0"]`);
      await page.waitForSelector('[data-view-only]');
      expect(await page.$('[data-agent-pane] textarea')).toBeNull();
      expect(await page.$(LIST)).not.toBeNull();

      await page.click('[data-rail] a[aria-label="Kinu home"]');
      await page.waitForSelector('[data-gallery-blank]');
      expect(await page.$(LIST)).toBeNull();
      await page.close();
    });
  });

  test('on a phone the Agents control opens the drawer on the list, and a row closes it onto that chat', async () => {
    await withGallery(async (gallery) => {
      const page = await shell(gallery, 390);
      const drawn = `[data-drawer] ${LIST}`;
      await page.click('[data-agents-counter]');
      await page.waitForSelector(drawn);

      await page.click(`${drawn} [data-agent-row="actor-docs"]`);
      await page.waitForFunction(() => document.querySelector('[data-drawer]') === null);
      await page.waitForSelector('[data-agent-pane="checkout-fixes/agents/docs"]');
      await page.close();
    });
  });
});
