/**
 * An agent opened from the sidebar's agents list or from a task in the Work tab shows its live chat in the main chat area
 * (owner, 2026-09-27: "the live chat appears in the main chat area itself"). On a phone that means the Chat pane.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';
import { AGENTS_COUNTER } from '../../scripts/browser-page';

const AUDITOR_PANE = '[data-agent-pane="api-worker/agents/binding-auditor"]';

const REFINER_PANE = '[data-agent-pane="api-worker/agents/refiner"]';

/** A message only the binding auditor's own transcript holds. */
const AUDITOR_SAID = 'Two routes still read env.DB themselves';

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, phone: { width: 390, height: 844 } } as const;

async function workspace(gallery: Gallery, viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.goto(`${gallery.origin}/gallery.html?frame=workspaceshell&agents=panel`, { waitUntil: 'networkidle0' });

  return page;
}

/**
 * Opens the sidebar's agents list and waits until a reader could press a row in it: drawn, not inert, and done sliding
 * in. A row pressed before then is under a panel still off to the side (tiers, 2026-10-10: the press hit the list).
 */
async function openAgentsList(page: Page, scope: string): Promise<void> {
  await page.click(`${scope} ${AGENTS_COUNTER}`);
  await page.waitForFunction((list) => {
    const shown = document.querySelector(list);

    return shown !== null && shown.closest('[inert]') === null
      && document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== 'running');
  }, {}, `${scope} [data-sidebar-agents]`);
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

        await openAgentsList(page, viewport === 'phone' ? '[data-drawer]' : '[data-rail]');
        await page.click(`${viewport === 'phone' ? '[data-drawer]' : '[data-rail]'} [data-agent-row="a-scout"]`);
        await page.waitForSelector(AUDITOR_PANE);
        await page.waitForFunction((pane, said) => document.querySelector(pane)?.textContent?.includes(said), {}, AUDITOR_PANE, AUDITOR_SAID);

        expect(await chatShows(page, AUDITOR_PANE)).toBe(true);
        // Its task came from Main, so the chat shows it as an event that names the hirer, never as the person's words.
        expect(await page.$eval(AUDITOR_PANE, (pane) => pane.textContent ?? '')).toMatch(/from Main[\s\S]*Audit every route for a read of the old database binding/);
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
        expect(await page.evaluate(() => document.body.textContent?.includes('Move the webhook route onto openDb · workers/api/src/routes/webhooks.ts'))).toBe(true);
        expect(await page.$('button[aria-label="Open workers/api/src/routes/webhooks.ts\'s conversation"]')).toBeNull();
        await page.click('button[aria-label="Open Binding auditor\'s conversation"]');
        await page.waitForSelector(AUDITOR_PANE);
        await page.waitForFunction((pane, said) => document.querySelector(pane)?.textContent?.includes(said), {}, AUDITOR_PANE, AUDITOR_SAID);

        expect(await chatShows(page, AUDITOR_PANE)).toBe(true);
        await page.close();
      });
    });

    test(`from a background subagent's row in the Work tab, on a ${viewport}`, async () => {
      await withGallery(async (gallery) => {
        const page = await workspace(gallery, viewport);

        if (viewport === 'phone') await page.click('.p-bar [data-inspector-toggle]');

        await page.click('nav[aria-label="Workspace"] button[aria-label="Work"]');
        await page.waitForSelector('[data-subagent-row]');
        // The refiner works in the background with no tab, so Now lists it; a hired agent has a place of its own and is not listed.
        expect(await page.$$eval('[data-subagent-row]', (rows) => rows.map((row) => row.getAttribute('data-subagent-row')))).toEqual(['a-refine']);
        await page.click('[data-subagent-row="a-refine"]');
        await page.waitForSelector(REFINER_PANE);

        expect(await chatShows(page, REFINER_PANE)).toBe(true);
        await page.close();
      });
    });
  }
});

describe("an agent's chat says when its turn waits on the provider, as the workspace's does", () => {
  test('the wait the server sends its room shows in its composer', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();

      await page.setViewport(VIEWPORTS.desktop);
      await page.goto(`${gallery.origin}/gallery.html?frame=workspaceshell&agent=binding-auditor`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(`${AUDITOR_PANE} [data-composer-root] textarea`);

      const shown = await page.evaluate(async (pane) => {
        window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail: { type: 'provider_wait', provider: 'anthropic', waitMs: 60_000, attempt: 1, source: 'header' } }));
        await new Promise((painted) => { requestAnimationFrame(() => { requestAnimationFrame(painted); }); });

        return [...document.querySelectorAll(`${pane} [data-composer-root] [role="status"]`)]
          .some((notice) => /anthropic/iu.test(notice.textContent ?? ''));
      }, AUDITOR_PANE);

      expect(shown).toBe(true);
    });
  });
});
