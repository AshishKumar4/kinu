/**
 * An agent opened from the Agents panel or from a task in the Work tab shows its live chat in the main chat area
 * (owner, 2026-09-27: "the live chat appears in the main chat area itself"). On a phone that means the Chat pane.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const AUDITOR_PANE = '[data-agent-pane="checkout-fixes/agents/coupon-auditor"]';

/** A message only the coupon auditor's own transcript holds. */
const AUDITOR_SAID = 'Two rules skip the expiry check';

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, phone: { width: 390, height: 844 } } as const;

async function workspace(gallery: Gallery, viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.goto(`${gallery.origin}/gallery.html?frame=workspacepage&agents=panel`, { waitUntil: 'networkidle0' });

  return page;
}

/** Whether the chat area, not the work surface, holds the agent's pane, and a phone shows that area. */
function chatShows(page: Page, pane: string): Promise<boolean> {
  return page.$eval(pane, (node) => {
    const chat = [...document.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent?.trim().startsWith('Chat'));

    return node.closest('[data-agents-panel]') === null && node.checkVisibility() && (chat === undefined || chat.getAttribute('aria-pressed') === 'true');
  });
}

describe('opening an agent shows its live chat in the main chat area', () => {
  for (const viewport of ['desktop', 'phone'] as const) {
    test(`from the Agents panel, on a ${viewport}`, async () => {
      await withGallery(async (gallery) => {
        const page = await workspace(gallery, viewport);
        await page.click('[data-agents-counter]');
        await page.click('[data-agent-row="a-scout"]');
        await page.waitForSelector(AUDITOR_PANE);
        await page.waitForFunction((pane, said) => document.querySelector(pane)?.textContent?.includes(said), {}, AUDITOR_PANE, AUDITOR_SAID);

        expect(await chatShows(page, AUDITOR_PANE)).toBe(true);
        await page.close();
      });
    });

    test(`from a task's owner in the Work tab, on a ${viewport}`, async () => {
      await withGallery(async (gallery) => {
        const page = await workspace(gallery, viewport);

        if (viewport === 'phone') {
          await page.$$eval('button[aria-pressed]', (buttons) => {
            buttons.find((button) => button.textContent?.trim().startsWith('Workspace'))?.click();
          });
        }

        await page.click('.p-tabstrip button[aria-label="Work"]');
        // The frame's plan awaits review, so the tab opens on it.
        await page.click('[data-back-to-work]');
        await page.click('button[aria-label="Open Coupon auditor\'s conversation"]');
        await page.waitForSelector(AUDITOR_PANE);
        await page.waitForFunction((pane, said) => document.querySelector(pane)?.textContent?.includes(said), {}, AUDITOR_PANE, AUDITOR_SAID);

        expect(await chatShows(page, AUDITOR_PANE)).toBe(true);
        await page.close();
      });
    });
  }
});
