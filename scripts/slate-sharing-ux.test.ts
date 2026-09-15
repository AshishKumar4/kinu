/**
 * The sharing surfaces, in a real browser: the Shared page with its four
 * lists, the blueprint page (signed in and signed out), the share dialog in
 * both modes and the unmapped-bindings panel, each at desktop and phone width
 * in dark and light.
 *
 * What only a browser can say here: that the warning about secret-shaped text
 * names a location and never a value, that a signed-out visitor's one action
 * is a sign-in, that the picker offers every workspace plus a new one, that
 * the live dialog grants every read member with no click and a mutating one
 * only after a click that changes the grant summary, and that the risk text
 * under a mutating member names the act, the workspace and who can trigger it
 * rather than a generic warning. Screenshots land in ~/kinu-logs/blueprints/
 * and ~/kinu-logs/live-shares/ (outside the worktree).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from './gallery-harness';

const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'blueprints');

const LIVE_SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'live-shares');

mkdirSync(SHOTS, { recursive: true });

mkdirSync(LIVE_SHOTS, { recursive: true });

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.browser.newPage();
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
            const text = await shared.evaluate(() => document.body.innerText);

            // The five segments, each carrying its list's count — All is the
            // kind:id-deduped union, so the doubled live row counts once.
            const tabs = await shared.$$eval('[aria-label="Shared lists"] [role="tab"]', (els) =>
              els.map((el) => ({ label: el.childNodes[0]?.textContent?.trim() ?? '', count: el.querySelector('span')?.textContent ?? '' })));

            expect(tabs).toEqual([
              { label: 'All', count: '7' }, { label: 'Mine', count: '3' }, { label: 'With me', count: '2' },
              { label: 'Public', count: '2' }, { label: 'People I know', count: '1' },
            ]);
            expect(text).toContain('sam@example.com');
            expect(text).toContain('lee@example.com');
            // A blueprint row forks; a live row opens. Four blueprints, three live rows in the union.
            expect(await shared.$$eval('[data-share-grid] button', (buttons) => buttons.filter((button) => button.textContent?.trim() === 'Fork').length)).toBe(4);
            expect(await shared.$$eval('[data-open-live]', (buttons) => buttons.length)).toBe(3);
            expect(text).toContain('live · public');
            expect(text).toContain('live · people');
            // Three columns at the spec's 1440, one on the phone.
            await shared.setViewport({ width: viewport === 'desktop' ? 1440 : 390, height: viewport === 'desktop' ? 900 : 844 });
            const columns = await shared.$eval('[data-share-grid]', (grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
            expect(columns).toBe(viewport === 'desktop' ? 3 : 1);
            shots.push(await shoot(shared, `shared-${viewport}-${theme}`));
            shots.push(await shoot(shared, `shared-four-lists-${viewport}-${theme}`, LIVE_SHOTS));
            // The segments switch what the grid holds, and search narrows it —
            // a searched-out segment says "Nothing matches", not its own line.
            await shared.click('[data-segment="received"]');
            await shared.waitForFunction(
              () => document.querySelectorAll('[data-share-grid] > li').length === 2, { timeout: 10_000 },
            );
            await shared.type('[aria-label="Search shared"]', 'lighthouse');
            await shared.waitForFunction(
              () => document.body.innerText.includes('Nothing matches'),
              { timeout: 10_000 },
            );
            await shared.$eval('[aria-label="Search shared"]', (input) => {
              // React owns the value: only the native setter plus an input
              // event moves its tracker.
              Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '');
              input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await shared.click('[data-segment="all"]');
            await shared.waitForFunction(
              () => document.querySelectorAll('[data-share-grid] > li').length === 7, { timeout: 10_000 },
            );
            await shared.evaluate(() => {
              const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Fork');

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

          const live = await freshPage(gallery, 'sharedialog', theme, viewport);

          try {
            const text = await live.$eval('[role="dialog"]', (element) => element.textContent ?? '');
            expect(text).toContain('Share live');
            expect(text).toContain('What a viewer reaches');
            // Read members are granted with no click; mutating ones wait for one.
            expect(await live.$$eval('[role="dialog"] input[type="checkbox"]', (boxes) => boxes.filter((box) => box instanceof HTMLInputElement && box.checked).length)).toBe(0);
            expect(await live.$eval('[data-grant-summary]', (element) => element.textContent ?? '')).toContain('Viewers get 4 read-only members. You approved 0 of 5 mutating members.');
            // The risk statement is per member: the act, the workspace, who can trigger it.
            expect(text).toContain('Calls create_issue on GitHub with your credentials.');
            expect(text).toContain('Writes, edits or deletes files in workspace checkout-fixes as you.');
            expect(text).toContain("Sends a message to your agent's inbox as this slate.");
            expect(text).toContain('Runs a model call on your fast tier. Every call spends your inference.');
            expect(text).toContain('Anyone you named on this share can trigger it.');
            expect(text).not.toMatch(/rate|spend cap|per hour|\$/);
            // The app hop is drawn as a subtree of the slate it names.
            expect(text).toContain('via PEER → digest');
            expect(text).toContain('DIGEST_FILES');
            shots.push(await shoot(live, `share-dialog-live-${viewport}-${theme}`, LIVE_SHOTS));
            await live.click('[data-approve="ASK.send"]');
            expect(await live.$eval('[data-grant-summary]', (element) => element.textContent ?? '')).toContain('You approved 1 of 5');
            // Public wording follows the visibility switch.
            await live.click('[role="radio"][aria-checked="false"]');
            expect(await live.$eval('[role="dialog"]', (element) => element.textContent ?? '')).toContain('Anyone who opens this share can trigger it.');
            shots.push(await shoot(live, `share-dialog-live-approved-public-${viewport}-${theme}`, LIVE_SHOTS));
          } finally {
            await live.close();
          }

          const dialog = await freshPage(gallery, 'sharedialog-blueprint', theme, viewport);

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

      expect(shots.length).toBe(40);
      process.stdout.write(`slate-sharing-ux: ${String(shots.length)} screenshots under ${SHOTS} and ${LIVE_SHOTS}\n`);
    });
  }, 240_000);
});
