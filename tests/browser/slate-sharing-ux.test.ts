/**
 * A shared slate's every v7 state (docs/SLATE-SHARING-SECURITY.md §6), drawn by the real live page, part frames and
 * share sheet over the gallery's fake room (gallery-sharing.tsx), at both widths in both themes. Each person sees the
 * state the room's view says, each control makes its call, and decisions open in the live page, never in a part's frame.
 */
import { describe, expect, test } from 'bun:test';
import type { Frame, Page } from 'puppeteer';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

const SOON = { timeout: 15_000 } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'load' });

  return page;
}

/** A part's frame inside the slate's page, once its live page answered it. */
async function partFrame(page: Page, part: string): Promise<Frame> {
  await page.waitForSelector('[data-live-frame]', SOON);

  for (;;) {
    const frame = page.frames().find((each) => each.url().includes(`frame=room-part&part=${part}`));

    if (frame !== undefined) {
      await frame.waitForSelector('[data-part-frame]', SOON);

      return frame;
    }

    await page.waitForFrame((each) => each.url().includes(`frame=room-part&part=${part}`), SOON);
  }
}

const stateOf = (frame: Frame) => frame.$eval('[data-part-frame]', (element) => element.getAttribute('data-part-frame'));

describe('a shared slate', () => {
  test('each person sees the state the room gives them, and every control acts', async () => {
    await withGallery(async (gallery) => {
      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          // Ben, added with Edit: the parts render, others are here, Edit and Fork are his.
          const live = await freshPage(gallery, 'room&state=live', theme, viewport);

          try {
            await live.waitForSelector('[data-live-bar]', SOON);
            expect(await live.$('[data-live-edit]')).not.toBeNull();
            expect(await live.$('[data-live-fork]')).not.toBeNull();
            expect(await live.$('[data-live-share]')).toBeNull();
            expect(await live.$$eval('[data-presence] [title]', (here) => here.length)).toBeGreaterThan(0);
            expect(await live.$eval('[data-presence-viewing]', (element) => element.textContent)).toContain('3');
            expect(await stateOf(await partFrame(live, 'prs'))).toBe('shown');
            // Shown by its holder: the label names whose and where from.
            const blocker = await partFrame(live, 'blocker');

            expect(await stateOf(blocker)).toBe('shown');
            expect(await blocker.$('[data-part-shown-by]')).not.toBeNull();
          } finally {
            await live.close();
          }

          // Chloe, added with Use: her own GitHub, connected here by her.
          const connect = await freshPage(gallery, 'room&state=live-connect', theme, viewport);

          try {
            const prs = await partFrame(connect, 'prs');

            expect(await stateOf(prs)).toBe('needs-connection');
            expect(await prs.$('[data-part-connect]')).not.toBeNull();
            expect(await connect.$('[data-live-edit]')).toBeNull();
          } finally {
            await connect.close();
          }

          // Connected, a part asks to use her own: the decision opens in the live page, and allowing renders the part.
          const grant = await freshPage(gallery, 'room&state=live-grant', theme, viewport);

          try {
            await grant.waitForSelector('[data-grant-allow]', SOON);
            const issues = await partFrame(grant, 'issues');

            expect(await issues.$('[data-grant-allow]')).toBeNull();
            await grant.click('[data-grant-allow]');
            await issues.waitForFunction(() => document.querySelector('[data-part-frame]')?.getAttribute('data-part-frame') === 'shown', SOON);
          } finally {
            await grant.close();
          }

          // Alice's own private card: only she sees it; showing it is hers to choose, then she can take it back.
          const mine = await freshPage(gallery, 'room&state=live-mine', theme, viewport);

          try {
            const blocker = await partFrame(mine, 'blocker');

            expect(await stateOf(blocker)).toBe('mine');
            await blocker.click('[data-part-show]');
            await mine.waitForSelector('[data-show-confirm]', SOON);
            await mine.click('[data-show-scope="anyone"]');
            await mine.click('[data-show-confirm]');
            await blocker.waitForSelector('[data-part-unshow]', SOON);
            await blocker.click('[data-part-unshow]');
            await blocker.waitForSelector('[data-part-show]', SOON);
          } finally {
            await mine.close();
          }

          // Bob, by the link: neither Alice's repository nor Sam's notes; he asks their holders, and checks his access.
          const outsider = await freshPage(gallery, 'room&state=live-source', theme, viewport);

          try {
            const notes = await partFrame(outsider, 'notes');
            const blocker = await partFrame(outsider, 'blocker');

            expect(await stateOf(notes)).toBe('placeholder');
            expect(await notes.$eval('[data-part-ask]', (button) => (button instanceof HTMLButtonElement ? button.disabled : null))).toBe(true);
            await blocker.click('[data-part-ask]');
            await blocker.waitForFunction(() => {
              const ask = document.querySelector('[data-part-ask]');

              return ask instanceof HTMLButtonElement && ask.disabled;
            }, SOON);
            await blocker.click('[data-part-check]');
            await blocker.waitForFunction(() => document.querySelector('[data-part-frame]')?.getAttribute('data-part-frame') === 'shown', SOON);
            expect(await outsider.$('[data-live-share]')).toBeNull();
          } finally {
            await outsider.close();
          }

          // Alice after Ben changed her part: using it again is asked in the live page.
          const edited = await freshPage(gallery, 'room&state=live-edited', theme, viewport);

          try {
            const prs = await partFrame(edited, 'prs');

            expect(await stateOf(prs)).toBe('edited');
            await prs.click('[data-part-edited] button');
            await edited.waitForSelector('[data-grant-allow]', SOON);
            await edited.click('[data-grant-allow]');
            await prs.waitForFunction(() => document.querySelector('[data-part-frame]')?.getAttribute('data-part-frame') === 'shown', SOON);
          } finally {
            await edited.close();
          }

          // Signed out, by the link: every part says what signing in would let them do; Fork signs them in, then picks.
          const signedOut = await freshPage(gallery, 'room&state=live-signed-out', theme, viewport);

          try {
            expect(await stateOf(await partFrame(signedOut, 'prs'))).toBe('needs-sign-in');
            expect(await (await partFrame(signedOut, 'notes')).$('[data-part-sign-in]')).not.toBeNull();

            const [request] = await Promise.all([
              signedOut.waitForRequest((sent) => new URL(sent.url()).pathname === '/login', SOON),
              signedOut.click('[data-live-fork]'),
            ]);

            const login = new URL(request.url());

            expect(new URL(login.searchParams.get('return_to') ?? '', login.origin).searchParams.get('fork')).toBe('1');
          } finally {
            await signedOut.close();
          }

          // Back from signing in: the fork picker is open.
          const forking = await freshPage(gallery, 'room&state=live&fork=1', theme, viewport);

          try {
            await forking.waitForSelector('input[name="fork-target"]', SOON);
          } finally {
            await forking.close();
          }

          // Removed, and a stopped link: the session ends under them at once, with a way to reach the owner.
          for (const [state, kind] of [['live-removed', 'removed'], ['live-stopped', 'stopped']] as const) {
            const ended = await freshPage(gallery, `room&state=${state}`, theme, viewport);

            try {
              await ended.waitForSelector(`[data-live-ended="${kind}"]`, SOON);
              expect(await ended.$('[data-live-ask-owner]')).not.toBeNull();
            } finally {
              await ended.close();
            }
          }

          // A lend: what it shows is Sam's to say; kept to him, others ask; after an edit, it waits for him.
          const privateLend = await freshPage(gallery, 'room&state=live-lent-private', theme, viewport);

          try {
            expect(await stateOf(await partFrame(privateLend, 'deploys'))).toBe('placeholder');
          } finally {
            await privateLend.close();
          }

          const waiting = await freshPage(gallery, 'room&state=live-lent-edited', theme, viewport);

          try {
            const deploys = await partFrame(waiting, 'deploys');

            expect(await stateOf(deploys)).toBe('waiting');
            expect(await deploys.$('[data-part-ask]')).not.toBeNull();
          } finally {
            await waiting.close();
          }

          // Sam's decisions arrive as cards beside his work, and answering one takes it away.
          for (const [state, kind] of [['live-decide', 'show'], ['live-effect', 'effect'], ['live-lend', 'lend'], ['live-outflow', 'outflow']] as const) {
            const holder = await freshPage(gallery, `room&state=${state}`, theme, viewport);

            try {
              await holder.waitForSelector(`[data-holder-ask="${kind}"]`, SOON);
              await holder.click(`[data-holder-ask="${kind}"] [data-holder-answer="decline"]`);
              await holder.waitForFunction((asked) => document.querySelector(`[data-holder-ask="${asked}"]`) === null, SOON, kind);
            } finally {
              await holder.close();
            }
          }
        }
      }
    });
  });

  test("the owner's sheet: people with roles, the link, the Gallery, lends and who used them", async () => {
    await withGallery(async (gallery) => {
      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const sheet = await freshPage(gallery, 'room&state=sheet', theme, viewport);

          try {
            await sheet.waitForSelector('[data-share-audience="people"]', SOON);
            // Invite by email with a role: the person joins the list, as invited.
            await sheet.type('[data-share-invite-email]', 'eve@acme.dev');
            await sheet.click('[data-share-invite]');
            await sheet.waitForSelector('[data-share-person="eve@acme.dev"]', SOON);
            // A person's role menu changes the role and removes them.
            await sheet.click('[data-share-person="ben@acme.dev"] [data-share-role]');
            await sheet.click('[data-share-role-option="use"]');
            await sheet.waitForSelector('[data-share-person="ben@acme.dev"] [data-share-role="use"]', SOON);
            await sheet.click('[data-share-person="eve@acme.dev"] [data-share-role]');
            await sheet.click('[data-share-remove]');
            await sheet.waitForFunction(() => document.querySelector('[data-share-person="eve@acme.dev"]') === null, SOON);
            // Anyone with the link: whose private items stay hidden, and the Gallery.
            expect(await sheet.$('[data-share-gallery]')).toBeNull();
            await sheet.click('[data-share-audience]');
            await sheet.click('[data-share-audience-option="anyone"]');
            await sheet.waitForSelector('[data-share-private-hidden]', SOON);
            await sheet.click('[data-share-gallery]');
            await sheet.type('[data-share-gallery-line]', 'Every pull request waiting on you.');
            await sheet.click('[data-share-gallery-category="developer"]');
            await sheet.click('[data-share-gallery-list]');
            await sheet.waitForFunction(() => document.querySelector('[data-share-gallery-line]') === null, SOON);
            // Only you: the link goes off, and the people with it.
            await sheet.click('[data-share-audience]');
            await sheet.click('[data-share-audience-option="only-you"]');
            await sheet.waitForFunction(() => document.querySelector('[data-share-person]') === null, SOON);
            expect(await sheet.$eval('[data-share-copy]', (button) => (button instanceof HTMLButtonElement ? button.disabled : null))).toBe(true);
          } finally {
            await sheet.close();
          }

          const lends = await freshPage(gallery, 'room&state=sheet-lends', theme, viewport);

          try {
            await lends.waitForSelector('[data-share-lend="weeklyDeploys"]', SOON);
            // Each lend: one switch, and who sees what it returns.
            await lends.click('[data-share-lend-on="weeklyDeploys"]');
            await lends.waitForSelector('[data-share-lend-on="weeklyDeploys"][aria-checked="false"]', SOON);
            await lends.click('[data-share-lend="searchNotes"] [data-share-lend-shown]');
            await lends.waitForSelector('[data-share-lend="searchNotes"] [data-share-lend-shown="everyone"]', SOON);
            // Who used them, per person; Remove takes them off the slate.
            await lends.click('[data-share-who]');
            await lends.waitForSelector('[data-share-who-remove="bob@outside.io"]', SOON);
            await lends.click('[data-share-who-remove="bob@outside.io"]');
            await lends.waitForFunction(() => document.querySelector('[data-share-who-remove="bob@outside.io"]') === null, SOON);
          } finally {
            await lends.close();
          }

          // Someone else's edit turns a lend off until it is lent again.
          const widened = await freshPage(gallery, 'room&state=sheet-widened', theme, viewport);

          try {
            await widened.waitForSelector('[data-share-lend-again]', SOON);
            await widened.click('[data-share-lend-again]');
            await widened.waitForSelector('[data-share-lend-on="searchNotes"][aria-checked="true"]', SOON);
          } finally {
            await widened.close();
          }

          // A key in the code: the slate stays the owner's alone, with the way to fix it.
          const secret = await freshPage(gallery, 'room&state=sheet-secret', theme, viewport);

          try {
            await secret.waitForSelector('[data-share-secret]', SOON);
            expect(await secret.$eval('[data-share-audience]', (button) => (button instanceof HTMLButtonElement ? button.disabled : null))).toBe(true);
            // Fix opens the owner's workspace chat, which asks the agent about that file and line as its first message.
            await secret.click('[data-share-secret-fix]');
            await secret.waitForSelector('[data-gallery-landed]', SOON);
            expect(await secret.$eval('[data-gallery-landed]', (node) => node.getAttribute('data-gallery-landed'))).toBe('/workspace/acme');
            expect(await secret.$eval('[data-gallery-landed]', (node) => node.getAttribute('data-gallery-opening'))).toContain('server.ts line 12');
          } finally {
            await secret.close();
          }
        }
      }
    });
  });

  test('fork shows what comes with it; an editor picks where to edit; a closed room says why', async () => {
    await withGallery(async (gallery) => {
      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const fork = await freshPage(gallery, 'room&state=fork', theme, viewport);

          try {
            await fork.waitForSelector('[data-fork-lent]', SOON);
            expect(await fork.$('[data-fork-needs]')).not.toBeNull();
            expect(await fork.$$eval('input[name="fork-target"]', (radios) => radios.length)).toBe(3);
          } finally {
            await fork.close();
          }

          const edit = await freshPage(gallery, 'room&state=edit', theme, viewport);

          try {
            await edit.waitForSelector('input[name="fork-target"]', SOON);
            expect(await edit.$('[data-fork-lent]')).toBeNull();
          } finally {
            await edit.close();
          }

          for (const closed of ['not-shared', 'missing', 'stopped'] as const) {
            const page = await freshPage(gallery, `room-closed&state=${closed}`, theme, viewport);

            try {
              await page.waitForSelector('main button', SOON);
            } finally {
              await page.close();
            }
          }

          // A part's frame opened on its own shows nothing of the room, and calls nothing.
          const alone = await freshPage(gallery, 'room-part&part=prs', theme, viewport);

          try {
            await alone.waitForSelector('[data-part-outside]', SOON);
          } finally {
            await alone.close();
          }

          const panel = await freshPage(gallery, 'fork-reach', theme, viewport);

          try {
            await panel.waitForSelector('[data-fork-reach]', SOON);
          } finally {
            await panel.close();
          }
        }
      }
    });
  });
});
