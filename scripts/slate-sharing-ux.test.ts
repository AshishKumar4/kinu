/**
 * The four Phase 1 sharing surfaces, in a real browser: the Shared page, the
 * blueprint page (signed in and signed out), the share dialog and the
 * unmapped-bindings panel, each at desktop and phone width in dark and light.
 *
 * What only a browser can say here: that the warning about secret-shaped text
 * names a location and never a value, that a signed-out visitor's one action
 * is a sign-in, that the picker offers every workspace plus a new one, and
 * that the dialog names the credentialed set above its confirm button.
 * Screenshots land in ~/kinu-logs/blueprints/ (outside the worktree).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from './gallery-harness';

const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'blueprints');

mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.browser.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'networkidle0' });

  return page;
}

async function shoot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
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
            const text = await shared.evaluate(() => document.body.innerText);
            expect(text).toContain('My shared');
            expect(text).toContain('Shared with me');
            expect(text).toContain('from sam@example.com');
            expect(await shared.$$eval('button', (buttons) => buttons.filter((button) => button.textContent?.includes('Fork into a workspace')).length)).toBe(3);
            shots.push(await shoot(shared, `shared-${viewport}-${theme}`));
            await shared.evaluate(() => {
              const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Fork into a workspace'));

              if (button === undefined) throw new Error('no fork button');
              button.click();
            });
            await shared.waitForSelector('[role="dialog"]', { timeout: 10_000 });
            const dialog = await shared.$eval('[role="dialog"]', (element) => element.textContent ?? '');
            expect(dialog).toContain('New workspace');
            expect(dialog).toContain('checkout-fixes');
            shots.push(await shoot(shared, `shared-fork-picker-${viewport}-${theme}`));
          } finally {
            await shared.close();
          }

          const blueprint = await freshPage(gallery, 'blueprint', theme, viewport);

          try {
            const text = await blueprint.evaluate(() => document.body.innerText);
            expect(text).toContain('Issue triage');
            expect(text).toContain('Secret-shaped text in the source');
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

          const dialog = await freshPage(gallery, 'sharedialog', theme, viewport);

          try {
            const text = await dialog.$eval('[role="dialog"]', (element) => element.textContent ?? '');
            expect(text).toContain('Publish blueprint');
            expect(text).toContain('A forker must connect');
            expect(text).toContain('GITHUB');
            expect(text).not.toContain('PEER (app');
            expect(text).toContain('Secret-shaped text');
            expect(text).toContain('Share with users');
            expect(text).not.toMatch(/rate|spend|per hour|\$/);
            shots.push(await shoot(dialog, `share-dialog-${viewport}-${theme}`));
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

      expect(shots.length).toBe(24);
      process.stdout.write(`slate-sharing-ux: ${String(shots.length)} screenshots under ${SHOTS}\n`);
    });
  }, 240_000);
});
