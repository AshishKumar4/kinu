/**
 * A slate's personal parts as their viewer meets them (docs/SLATE-SHARING-NIMBUS.md §3), in the gallery's `part-host`:
 * an app page hosting a slate's page, which frames three part frames. Each part runs, allows, approves and shows only
 * through the app page at the top, and every decision opens there, never in the part's frame. The routes answer in the
 * fixture (gallery-parts.tsx), which records what the page asked.
 */
import { describe, expect, test } from 'bun:test';
import type { Frame, Page } from 'puppeteer';
import * as v from 'valibot';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 1400 } } as const;

const SOON = { timeout: 15_000 } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();

  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'load' });

  return page;
}

/** One part's frame inside the slate's page, once it has drawn the part's state. */
async function partFrame(page: Page, part: string): Promise<Frame> {
  const found = await page.waitForFrame((frame) => frame.url().includes(`frame=part-frame&part=${part}`), SOON);

  await found.waitForSelector('[data-part-frame]', SOON);

  return found;
}

const stateOf = (frame: Frame) => frame.$eval('[data-part-frame]', (node) => node.getAttribute('data-part-frame'));

/** Waits until the part's frame draws `state`. */
const reaches = (frame: Frame, state: string) => frame.waitForSelector(`[data-part-frame="${state}"]`, SOON);

const AskedSchema = v.array(v.object({ path: v.string(), body: v.nullable(v.string()) }));

const asked = async (page: Page) => v.parse(AskedSchema, JSON.parse(await page.$eval('html', (root) => root.getAttribute('data-gallery-asked')) ?? '[]'));

/** No decision of any kind is drawn inside a part's frame: they open at the top alone. */
const noDecisionIn = async (frame: Frame) => expect(await frame.$('[data-consent-allow], [data-approval-approve], [data-show-confirm]')).toBeNull();

describe("a slate's personal parts", () => {
  test('each asks its viewer at the top, then shows; an effect waits for approval of its exact payload; a showing is confirmed as it leaves', async () => {
    await withGallery(async (gallery) => {
      for (const [theme, viewport] of [['dark', 'desktop'], ['light', 'mobile']] as const) {
        const page = await freshPage(gallery, 'part-host', theme, viewport);

        try {
          const standup = await partFrame(page, 'standup');
          const deploy = await partFrame(page, 'deploy');
          const team = await partFrame(page, 'team');

          // A part the share does not declare: it says what to do, and nothing runs.
          expect(await stateOf(team)).toBe('stub');
          expect(await team.$('[data-part-stub="no-part"]')).not.toBeNull();

          // Allowed for an earlier revision: the code changed since, and the top says so. The part names its slate as the
          // top gives it, not by the id in its own address.
          expect(await stateOf(standup)).toBe('needs-consent');
          expect(await standup.$eval('[data-part-needs="consent"]', (node) => node.textContent ?? '')).toContain('Team board');
          // The connection by the title the viewer's account gives it.
          expect(await standup.$eval('[data-part-needs="consent"]', (node) => node.textContent ?? '')).toContain('GitHub connection');
          await standup.click('[data-part-needs="consent"] button');
          await page.waitForSelector('[data-consent-allow]', SOON);
          expect(await page.$('[data-consent-changed]')).not.toBeNull();
          await noDecisionIn(standup);
          await page.click('[data-consent-allow]');
          await reaches(standup, 'shown');
          expect(await standup.$eval('[data-part-content]', (node) => node.getAttribute('sandbox'))).toBe('');

          // Its own control runs it again, Kinu's and not the slate's script.
          await standup.click('[data-part-action="refresh"]');
          await page.waitForFunction((count) => JSON.parse(document.documentElement.getAttribute('data-gallery-asked') ?? '[]').filter((each: { path: string }) => each.path.endsWith('/parts/standup/run')).length >= count, SOON, 3);

          // Show to everyone: exactly what leaves, and that it can't be taken back, before it does.
          await standup.click('[data-part-show]');
          await page.waitForSelector('[data-show-confirm]', SOON);
          expect(await page.$('[data-show-final]')).not.toBeNull();
          expect(JSON.parse(await page.$eval('[data-show-payload]', (node) => node.textContent ?? 'null'))).toEqual({ author: 'you', open: [412, 409] });
          await noDecisionIn(standup);
          await page.click('[data-show-confirm]');
          await page.waitForFunction(() => document.querySelector('[data-show-confirm]') === null, SOON);
          const shown = (await asked(page)).find((each) => each.path.endsWith('/parts/standup/show'));

          expect(JSON.parse(shown?.body ?? '{}')).toEqual({ revision: 'r2', label: 'Your open pull requests, as the team sees them', value: { author: 'you', open: [412, 409] } });

          // A first consent says nothing changed; then its effect waits, payload shown, and runs once approved.
          await deploy.click('[data-part-needs="consent"] button');
          await page.waitForSelector('[data-consent-allow]', SOON);
          expect(await page.$('[data-consent-changed]')).toBeNull();
          await page.click('[data-consent-allow]');
          await reaches(deploy, 'needs-approval');
          await deploy.click('[data-part-needs="approval"] button');
          await page.waitForSelector('[data-approval-approve]', SOON);
          expect(JSON.parse(await page.$eval('[data-approval-payload]', (node) => node.textContent ?? 'null'))).toEqual({ project: 'site', target: 'production', ref: 'main' });
          expect(await page.$eval('[data-approval-tool]', (node) => node.textContent)).toBe('Create deployment');
          await noDecisionIn(deploy);
          await page.click('[data-approval-approve]');
          await reaches(deploy, 'shown');

          const after = await asked(page);
          const lastDeploy = after.filter((each) => each.path.endsWith('/parts/deploy/run')).at(-1);

          expect(after.some((each) => each.path.endsWith('/approvals/approval-1') && JSON.parse(each.body ?? '{}').decision === 'approve')).toBe(true);
          expect(JSON.parse(lastDeploy?.body ?? '{}').approval).toBe('approval-1');
        } finally {
          await page.close();
        }
      }
    });
  });

  test('a part frame opened on its own, with no app page above it, runs nothing and shows nothing of a viewer', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'part-frame&part=standup', 'light', 'desktop');

      try {
        await page.waitForSelector('[data-part-outside]', SOON);
        expect(await page.$('[data-part-frame]')).toBeNull();
      } finally {
        await page.close();
      }
    });
  });
});
