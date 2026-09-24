/**
 * The sharing surfaces, in a real browser: the Drive's Shared tab, the
 * blueprint page (signed in and signed out), the share dialog in both modes
 * and the unmapped-bindings panel, each at desktop and phone width in dark and
 * light.
 *
 * What only a browser can say here: that the warning about secret-shaped text
 * names a location and never a value, that a signed-out visitor's one action
 * is a sign-in, that the fork picker offers every workspace plus a new one,
 * that the live dialog grants every read member with no click and a mutating
 * one only after a click that changes the grant summary, that the risk text
 * under a mutating member names the act, the workspace and who can trigger it
 * rather than a generic warning, and that the dialog states the limits a share
 * runs under. Screenshots land in ~/kinu-logs/blueprints/ and
 * ~/kinu-logs/live-shares/ (outside the worktree).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';
import { SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE } from '@kinu.run/core';

import { withGallery, type Gallery } from './gallery-harness';

const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'blueprints');

const LIVE_SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'live-shares');

mkdirSync(SHOTS, { recursive: true });

mkdirSync(LIVE_SHOTS, { recursive: true });

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'networkidle0' });

  return page;
}

async function shoot(page: Page, name: string, dir = SHOTS): Promise<string> {
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });

  return path;
}

describe('slate sharing surfaces', () => {
  test('every surface renders at both widths in both themes, and says what it must', async () => {
    await withGallery(async (gallery) => {
      const shots: string[] = [];

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const shared = await freshPage(gallery, 'shared', theme, viewport);

          try {
            await shared.waitForSelector('[data-drive-share]');
            const text = await shared.evaluate(() => document.body.innerText);

            // A received row names who shared it; forking one picks a workspace, or a new one.
            expect(text).toContain('sam@example.com');
            await shared.click('[data-drive-share="live-mail-9"] [data-drive-menu]');
            await shared.evaluate(() => {
              const item = [...document.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === 'Fork…');

              if (!(item instanceof HTMLButtonElement)) throw new Error('no Fork… item');
              item.click();
            });
            await shared.waitForSelector('[role="dialog"]');
            await shared.waitForFunction(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').includes('checkout-fixes'));
            const dialog = await shared.$eval('[role="dialog"]', (element) => element.textContent ?? '');
            expect(dialog).toContain('New workspace');
            shots.push(await shoot(shared, `shared-fork-picker-${viewport}-${theme}`));
          } finally {
            await shared.close();
          }

          const blueprint = await freshPage(gallery, 'blueprint', theme, viewport);

          try {
            const text = await blueprint.evaluate(() => document.body.innerText);
            expect(text).toContain('Issue triage');
            expect(await blueprint.$('[role="alert"]')).not.toBeNull();
            expect(text).toContain('src/config.ts:4');
            expect(text).not.toContain('AKIA');
            expect(text).toContain('Fork into Kinu');
            expect(text).toContain('MCP server');
            shots.push(await shoot(blueprint, `blueprint-${viewport}-${theme}`));
          } finally {
            await blueprint.close();
          }

          const visitor = await freshPage(gallery, 'blueprint&viewer=signedout', theme, viewport);

          try {
            // A visitor's one action signs in and comes back here.
            const action = await visitor.evaluate(() => {
              const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Fork into Kinu'));

              return button === undefined ? null : button.textContent;
            });

            expect(action).toContain('Fork into Kinu');
            expect(await visitor.$('aside')).toBeNull();
            shots.push(await shoot(visitor, `blueprint-signed-out-${viewport}-${theme}`));
          } finally {
            await visitor.close();
          }

          const live = await freshPage(gallery, 'sharedialog', theme, viewport);

          try {
            // One sentence, who can open it, the fork choice, and the reach folded behind one row.
            const lead = await live.$eval('[role="dialog"]', (element) => element.textContent ?? '');
            expect(lead).toContain('It runs in your workspace, as you.');
            expect(await live.$eval('[data-share-access]', (element) => element.getAttribute('data-share-access'))).toBe('users');
            expect(await live.$eval('[data-share-fork]', (box) => box instanceof HTMLInputElement && box.checked)).toBe(true);
            // The bounds a live share runs under, in the dialog that creates it.
            const limits = await live.$eval('[data-share-limits]', (element) => element.textContent ?? '');
            expect(limits).toContain(String(SHARE_VIEWER_REQUESTS_PER_MINUTE));
            expect(limits).toContain(`$${String(SHARE_SPEND_CAP_USD_PER_DAY)}`);
            shots.push(await shoot(live, `share-dialog-live-${viewport}-${theme}`, LIVE_SHOTS));
            await live.click('[data-share-reach]');
            await live.waitForSelector('[data-grant-summary]');
            const text = await live.$eval('[role="dialog"]', (element) => element.textContent ?? '');
            // Read members are granted with no click; changes wait for one.
            expect(await live.$$eval('[role="dialog"] input[data-approve]', (boxes) => boxes.filter((box) => box instanceof HTMLInputElement && box.checked).length)).toBe(0);
            expect(await live.$eval('[data-grant-summary]', (element) => element.textContent ?? '')).toContain('People get 4 read-only members. You allowed 0 of 5 changes.');
            // The risk statement is per member: the act, the workspace, who can trigger it.
            expect(text).toContain('Calls create_issue on GitHub with your credentials.');
            expect(text).toContain('Writes, edits or deletes files in workspace checkout-fixes as you.');
            expect(text).toContain("Sends a message to your agent's inbox as this slate.");
            expect(text).toContain('Runs a model call on your fast tier. Every call spends your inference.');
            expect(text).toContain('Anyone you named on this share can trigger it.');
            // The app hop is drawn as a subtree of the slate it names.
            expect(text).toContain('via PEER → digest');
            expect(text).toContain('DIGEST_FILES');
            await live.click('[data-approve="ASK.send"]');
            expect(await live.$eval('[data-grant-summary]', (element) => element.textContent ?? '')).toContain('You allowed 1 of 5');
            // Public wording follows the access choice.
            await live.click('[data-share-access]');
            await live.click('[data-share-access-option="public"]');
            expect(await live.$eval('[role="dialog"]', (element) => element.textContent ?? '')).toContain('Anyone who opens this share can trigger it.');
            shots.push(await shoot(live, `share-dialog-live-approved-public-${viewport}-${theme}`, LIVE_SHOTS));
          } finally {
            await live.close();
          }

          const dialog = await freshPage(gallery, 'sharedialog-blueprint', theme, viewport);

          try {
            const text = await dialog.$eval('[role="dialog"]', (element) => element.textContent ?? '');
            expect(text).toContain('Publish');
            // Only a credentialed binding asks the forker to connect; the app hop is not one.
            expect(await dialog.$eval('[data-blueprint-connect]', (element) => element.textContent ?? '')).toContain('GITHUB');
            expect(text).not.toContain('PEER (app');
            expect(await dialog.$('[role="dialog"] [role="alert"]')).not.toBeNull();
            expect(text).not.toMatch(/per minute|spend|\$/);
            shots.push(await shoot(dialog, `share-dialog-blueprint-${viewport}-${theme}`, LIVE_SHOTS));
          } finally {
            await dialog.close();
          }

          const panel = await freshPage(gallery, 'unmapped', theme, viewport);

          try {
            const text = await panel.$eval('[data-unmapped-bindings]', (element) => element.textContent ?? '');
            expect(text).toContain('needs its bindings connected');
            expect(text).toContain('Connect an MCP server named "github"');
            expect(text).toContain('Open the preview');
            shots.push(await shoot(panel, `unmapped-bindings-${viewport}-${theme}`));
          } finally {
            await panel.close();
          }
        }
      }

      expect(shots.length).toBe(28);
      process.stdout.write(`slate-sharing-ux: ${String(shots.length)} screenshots under ${SHOTS} and ${LIVE_SHOTS}\n`);
    });
  });
});
