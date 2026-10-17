/**
 * A slate's personal parts as their viewer meets them (docs/SLATE-SHARING-NIMBUS.md §3), in the gallery's `part-host`:
 * an app page hosting a slate's page, which frames three part frames. Each part runs, allows, approves and shows only
 * through the app page at the top, and every decision opens there, never in the part's frame. The routes answer in the
 * fixture (gallery-parts.tsx), which records what the page asked.
 */
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import type { Frame, Page } from 'puppeteer';
import * as v from 'valibot';
import { detach } from '@kinu.run/core/obs';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 1400 } } as const;

const SOON = { timeout: 15_000 } as const;

/**
 * In each part frame, from its first render on: every count of nested frames it held, as the slate's page can read it
 * off the frame's window, and whether a nested frame was ever taken out. A count that differs by state, or a frame
 * replaced, would tell the slate's page something of its viewer.
 */
function sampleFrames(): void {
  if (new URLSearchParams(location.search).get('frame') !== 'part-frame') return;
  const lengths: number[] = [];
  let replaced = false;

  // Kept on the root, where the test reads it back.
  const keep = () => document.documentElement.setAttribute('data-frames-held', JSON.stringify({ lengths, replaced }));

  const note = () => {
    if ((document.getElementById('root')?.childElementCount ?? 0) === 0 || lengths.at(-1) === window.length) return;
    lengths.push(window.length);
    keep();
  };

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node instanceof Element && (node.matches('iframe') || node.querySelector('iframe') !== null)) {
          replaced = true;
          keep();
        }
      }
    }

    note();
  }).observe(document, { childList: true, subtree: true });

  const tick = () => {
    note();
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

const FramesHeldSchema = v.object({ lengths: v.array(v.number()), replaced: v.boolean() });

/** What a part frame held throughout: one nested frame, never replaced, is the only answer that tells nothing. */
const framesHeld = async (frame: Frame) => v.parse(FramesHeldSchema, JSON.parse(await frame.$eval('html', (root) => root.getAttribute('data-frames-held')) ?? 'null'));

const ONE_FRAME_THROUGHOUT = { lengths: [1], replaced: false };

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();

  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.evaluateOnNewDocument(sampleFrames);
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

/**
 * The preview host is answered here, as a public address, and frames the gallery's part frame on loopback. Chrome refuses
 * a public page's frame onto a more private address, which deployed hosts never meet: the slate's page and the app are
 * both public there.
 */
const PREVIEW_ON_LOOPBACK = { browserArgs: ['--disable-features=LocalNetworkAccessChecks'] };

/** The slate's server, as its preview host serves the owner's previews: its page, framing its standup part. */
async function serveSlatePage(page: Page, gallery: string): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request) => detach(Effect.promise(async () => {
    if (!new URL(request.url()).hostname.endsWith('.preview.example.test')) {
      await request.continue();

      return;
    }

    await request.respond({ status: 200, contentType: 'text/html', body: [
      '<!doctype html><body style="margin:0">',
      `<iframe data-slate-part="standup" src="${gallery}/gallery.html?frame=part-frame&part=standup&scheme=light" style="border:0;width:100%;height:220px"></iframe>`,
    ].join('') });
  })));
}

/** The standup part's frame inside one of the owner's previews (`pane` or `inline`), once it has drawn its state. */
async function previewPart(page: Page, display: string): Promise<Frame> {
  const preview = await page.waitForSelector(`[data-slate-preview-display="${display}"] iframe`, SOON);
  const slate = await preview?.contentFrame();
  const found = await page.waitForFrame((frame) => frame.parentFrame() === slate && frame.url().includes('frame=part-frame&part=standup'), SOON);

  await found.waitForSelector('[data-part-frame]', SOON);

  return found;
}

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

          // Its own control, with what the viewer typed, needs a first consent, which says nothing changed; then its effect
          // waits, payload shown, and runs once approved. Each decision resumes that same run, what was typed kept.
          await reaches(deploy, 'shown');
          await deploy.type('[data-part-action-input="deploy"]', 'release-7');
          await deploy.click('[data-part-action="deploy"]');
          await reaches(deploy, 'needs-consent');
          await deploy.click('[data-part-needs="consent"] button');
          await page.waitForSelector('[data-consent-allow]', SOON);
          expect(await page.$('[data-consent-changed]')).toBeNull();
          await page.click('[data-consent-allow]');
          await reaches(deploy, 'needs-approval');
          await deploy.click('[data-part-needs="approval"] button');
          await page.waitForSelector('[data-approval-approve]', SOON);
          expect(JSON.parse(await page.$eval('[data-approval-payload]', (node) => node.textContent ?? 'null'))).toEqual({ project: 'site', target: 'production', ref: 'release-7' });
          expect(await page.$eval('[data-approval-tool]', (node) => node.textContent)).toBe('Create deployment');
          await noDecisionIn(deploy);
          await page.click('[data-approval-approve]');
          await reaches(deploy, 'shown');

          const after = await asked(page);
          const pressed = { id: 'deploy', input: 'release-7' };

          expect(after.some((each) => each.path.endsWith('/approvals/approval-1') && JSON.parse(each.body ?? '{}').decision === 'approve')).toBe(true);
          // The press, its resumption once allowed, and once approved.
          expect(after.filter((each) => each.path.endsWith('/parts/deploy/run')).slice(-3).map((each) => JSON.parse(each.body ?? '{}'))).toEqual([
            { args: [], action: pressed, approval: null },
            { args: [], action: pressed, approval: null },
            { args: [], action: pressed, approval: 'approval-1' },
          ]);

          // Through every state each part showed, its frame held one nested frame, the same one.
          for (const part of [standup, deploy, team]) expect(await framesHeld(part)).toEqual(ONE_FRAME_THROUGHOUT);
        } finally {
          await page.close();
        }
      }
    });
  });

  test("a part whose viewer's session has ended offers Sign in, back to the same page; another refusal says why", async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'part-host-refused', 'light', 'desktop');

      try {
        const standup = await partFrame(page, 'standup');
        const team = await partFrame(page, 'team');

        expect(await stateOf(standup)).toBe('stub');
        await standup.waitForSelector('[data-part-stub="signed-out"] button', SOON);
        expect(await stateOf(team)).toBe('failed');
        const deploy = await page.waitForFrame((frame) => frame.url().includes('frame=part-frame&part=deploy'), SOON);

        // A refusal says why in the server's own words, not as the app's internal failure.
        expect(await (await deploy.waitForSelector('[role="alert"]', SOON))?.evaluate((node) => node.textContent)).toContain("The workspace didn't answer in time.");
        expect(await deploy.$eval('[role="alert"]', (node) => node.textContent)).not.toContain('Cause(');

        // Refused, failed or never answered, each part frame holds the one nested frame every other state holds.
        for (const part of [standup, deploy, team]) expect(await framesHeld(part)).toEqual(ONE_FRAME_THROUGHOUT);

        const here = new URL(page.url());

        const [login] = await Promise.all([
          page.waitForRequest((request) => new URL(request.url()).pathname === '/login', SOON),
          standup.click('[data-part-stub="signed-out"] button'),
        ]);

        expect(new URL(login.url()).searchParams.get('return_to')).toBe(here.pathname + here.search);
      } finally {
        await page.close();
      }
    });
  });

  test("a share's page frames the slate under Kinu's bar and hosts its parts for the visitor", async () => {
    await withGallery(async (gallery) => {
      for (const [theme, viewport] of [['light', 'desktop'], ['dark', 'mobile']] as const) {
        const page = await freshPage(gallery, 'shared-live', theme, viewport);

        try {
          await page.waitForSelector('[data-shared-slate="team-board"]', SOON);
          expect(await page.$eval('[data-shared-title]', (node) => node.textContent)).toBe('Team board');

          // The visitor allows their own GitHub at the share's page, and sees their part.
          const standup = await partFrame(page, 'standup');

          await standup.click('[data-part-needs="consent"] button');
          await page.waitForSelector('[data-consent-allow]', SOON);
          await noDecisionIn(standup);
          await page.click('[data-consent-allow]');
          await reaches(standup, 'shown');
        } finally {
          await page.close();
        }
      }
    });
  });

  test("a share that names people, entered signed out, signs its visitor in and lands them back on it", async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'shared-live-signed-out', 'light', 'desktop');

      try {
        await page.waitForSelector('[data-shared-sign-in] button', SOON);
        const here = new URL(page.url());

        const [login] = await Promise.all([
          page.waitForRequest((request) => new URL(request.url()).pathname === '/login', SOON),
          page.click('[data-shared-sign-in] button'),
        ]);

        expect(new URL(login.url()).searchParams.get('return_to')).toBe(here.pathname + here.search);
      } finally {
        await page.close();
      }
    });
  });

  test("the owner's previews, in the column and in an answer, each host their slate's parts and open its decisions at the top", async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();

      try {
        await page.setViewport(VIEWPORTS.desktop);
        await serveSlatePage(page, gallery.origin);
        await page.goto(`${gallery.origin}/gallery.html?frame=part-previews`, { waitUntil: 'load' });

        for (const display of ['inline', 'pane']) {
          const standup = await previewPart(page, display);

          expect(await stateOf(standup)).toBe('needs-consent');
          await standup.click('[data-part-needs="consent"] button');
          await page.waitForSelector('[data-consent-allow]', SOON);
          await noDecisionIn(standup);
          await page.click('[data-consent-allow]');
          await reaches(standup, 'shown');
        }
      } finally {
        await page.close();
      }
    }, PREVIEW_ON_LOOPBACK);
  });

  test('a part frame opened on its own, with no app page above it, runs nothing and shows nothing of a viewer', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'part-frame&part=standup', 'light', 'desktop');

      try {
        await page.waitForSelector('[data-part-outside]', SOON);
        expect(await page.$('[data-part-frame]')).toBeNull();
        expect(await framesHeld(page.mainFrame())).toEqual(ONE_FRAME_THROUGHOUT);
      } finally {
        await page.close();
      }
    });
  });
});
