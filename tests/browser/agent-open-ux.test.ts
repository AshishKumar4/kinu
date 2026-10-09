/**
 * An agent opened from the sidebar's agents list or from a task in the Work tab shows its live chat in the main chat area
 * (owner, 2026-09-27: "the live chat appears in the main chat area itself"). On a phone that means the Chat pane.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const AUDITOR_PANE = '[data-agent-pane="checkout-fixes/agents/coupon-auditor"]';

const REFINER_PANE = '[data-agent-pane="checkout-fixes/agents/refiner"]';

/** A message only the coupon auditor's own transcript holds. */
const AUDITOR_SAID = 'Two rules skip the expiry check';

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, phone: { width: 390, height: 844 } } as const;

async function workspace(gallery: Gallery, viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.goto(`${gallery.origin}/gallery.html?frame=workspaceshell&agents=panel`, { waitUntil: 'networkidle0' });

  return page;
}

/** Whether the chat area, not the work surface, holds the agent's pane, and a phone shows that area. */
function chatShows(page: Page, pane: string): Promise<boolean> {
  return page.$eval(pane, (node) => {
    // On a phone the bar's toggle swaps the chat for the workspace; unpressed, the chat is what shows.
    const toggle = document.querySelector('.p-bar [data-inspector-toggle]');

    return node.closest('[data-agents-panel]') === null && node.checkVisibility() && (toggle === null || toggle.getAttribute('aria-label') !== 'Show chat');
  });
}

describe('opening an agent shows its live chat in the main chat area', () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    test(`from the sidebar's agents list, on a ${viewport}`, async () => {
      await withGallery(async (gallery) => {
        const page = await workspace(gallery, viewport);

        // The list is the sidebar's: the rail's on a desktop, the drawer's on a phone.
        if (viewport === 'phone') await page.click('.p-bar-menu button');

        await page.click(`${viewport === 'phone' ? '[data-drawer]' : '[data-rail]'} [data-agents-counter]`);
        await page.click(`${viewport === 'phone' ? '[data-drawer]' : '[data-rail]'} [data-agent-row="a-scout"]`);
        await page.waitForSelector(AUDITOR_PANE);
        await page.waitForFunction((pane, said) => document.querySelector(pane)?.textContent?.includes(said), {}, AUDITOR_PANE, AUDITOR_SAID);

        expect(await chatShows(page, AUDITOR_PANE)).toBe(true);
        // Its task came from Main, so the chat shows it as an event that names the hirer, never as the person's words.
        expect(await page.$eval(AUDITOR_PANE, (pane) => pane.textContent ?? '')).toMatch(/from Main[\s\S]*Audit every coupon rule/);
        await page.close();
      });
    });

    test(`from a task's owner in the Work tab, on a ${viewport}`, async () => {
      await withGallery(async (gallery) => {
        const page = await workspace(gallery, viewport);

        if (viewport === 'phone') {
          await page.click('.p-bar [data-inspector-toggle]');
        }

        await page.click('nav[aria-label="Workspace"] button[aria-label="Work"]');
        // A task one past a head names its owner and offers no door: there is no conversation of its own to open.
        expect(await page.evaluate(() => document.body.textContent?.includes('Serialize gift-card lines · packages/cart/src/serializer.ts'))).toBe(true);
        expect(await page.$('button[aria-label="Open packages/cart/src/serializer.ts\'s conversation"]')).toBeNull();
        await page.click('button[aria-label="Open Coupon auditor\'s conversation"]');
        await page.waitForSelector(AUDITOR_PANE);
        await page.waitForFunction((pane, said) => document.querySelector(pane)?.textContent?.includes(said), {}, AUDITOR_PANE, AUDITOR_SAID);

        expect(await chatShows(page, AUDITOR_PANE)).toBe(true);
        await page.close();
      });
    });

    test(`from a background helper's row in the Work tab, on a ${viewport}`, async () => {
      await withGallery(async (gallery) => {
        const page = await workspace(gallery, viewport);

        if (viewport === 'phone') await page.click('.p-bar [data-inspector-toggle]');

        await page.click('nav[aria-label="Workspace"] button[aria-label="Work"]');
        await page.waitForSelector('[data-helper-row]');
        // The refiner works in the background with no tab, so Now lists it; a hired agent has a place of its own and is not listed.
        expect(await page.$$eval('[data-helper-row]', (rows) => rows.map((row) => row.getAttribute('data-helper-row')))).toEqual(['a-refine']);
        await page.click('[data-helper-row="a-refine"]');
        await page.waitForSelector(REFINER_PANE);

        expect(await chatShows(page, REFINER_PANE)).toBe(true);
        await page.close();
      });
    });
  }
});
