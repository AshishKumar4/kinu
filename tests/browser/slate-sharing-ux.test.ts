/** Real-browser share access, grant consent, credential redaction and blueprint reach at both widths and themes. */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';


const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'load' });

  return page;
}


describe('slate sharing surfaces', () => {
  test('every surface renders at both widths in both themes, and says what it must', async () => {
    await withGallery(async (gallery) => {
      

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
            expect(text).toContain('Connect an MCP server named "github"');
            
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
            // docs/SLATE-SHARING.md S5, independent of the constants used to render these bounds.
            const limits = await live.$eval('[data-share-limits]', (element) => element.textContent ?? '');
            const requests: number[] = [];
            const dollars: number[] = [];

            for (const [, currency, amount] of limits.matchAll(/(\$?)(\d+(?:\.\d+)?)/g)) {
              (currency === '$' ? dollars : requests).push(Number(amount));
            }

            expect({ requests, dollars }).toEqual({ requests: [120], dollars: [2] });
            
            // Folded, the reach names what the slate reaches (a server by its title), not the slate's own keys.
            const reach = await live.$eval('[data-share-reach]', (element) => element.textContent ?? '');
            expect(reach).toContain('GitHub');
            expect(reach).not.toContain('GITHUB');
            await live.click('[data-share-reach]');
            await live.waitForSelector('[data-grant-summary]');
            const text = await live.$eval('[role="dialog"]', (element) => element.textContent ?? '');
            // Read members are granted with no click; changes wait for one.
            expect(await live.$$eval('[role="dialog"] input[data-approve]', (boxes) => boxes.filter((box) => box instanceof HTMLInputElement && box.checked).length)).toBe(0);
            expect(await live.$eval('[data-grant-summary]', (element) => element.textContent ?? '')).toContain('People get 5 read-only members. You allowed 0 of 5 changes.');
            // The risk statement is per member: the act, the workspace, who can trigger it.
            expect(text).toContain('Calls create_issue on GitHub with your credentials.');
            expect(text).toContain('Writes, edits or deletes files in workspace checkout-fixes as you.');
            expect(text).toContain('Sends agent.send out of workspace checkout-fixes as you');
            expect(text).toContain('Runs a model call on your inference. Every call spends it.');
            expect(text).toContain('Anyone you named on this share can trigger it.');
            // The app hop is drawn as a subtree of the slate it names.
            expect(text).toContain('via issue-triage → digest');
            await live.click('[data-approve="agent.send"]');
            expect(await live.$eval('[data-grant-summary]', (element) => element.textContent ?? '')).toContain('You allowed 1 of 5');
            // Public wording follows the access choice.
            await live.click('[data-share-access]');
            await live.click('[data-share-access-option="public"]');
            expect(await live.$eval('[role="dialog"]', (element) => element.textContent ?? '')).toContain('Anyone who opens this share can trigger it.');
            
          } finally {
            await live.close();
          }

          const dialog = await freshPage(gallery, 'sharedialog-blueprint', theme, viewport);

          try {
            const text = await dialog.$eval('[role="dialog"]', (element) => element.textContent ?? '');
            expect(text).toContain('Publish');
            // The forker connects their own of what the slate reaches.
            expect(await dialog.$eval('[data-blueprint-connect]', (element) => element.textContent ?? '')).toContain('mcp.github');
            expect(await dialog.$('[role="dialog"] [role="alert"]')).not.toBeNull();
            expect(text).not.toMatch(/per minute|spend|\$/);
            
          } finally {
            await dialog.close();
          }

          const panel = await freshPage(gallery, 'fork-reach', theme, viewport);

          try {
            const text = await panel.$eval('[data-fork-reach]', (element) => element.textContent ?? '');
            expect(text).toContain('runs as you here');
            expect(text).toContain('Connect an MCP server named "github"');
            expect(text).toContain('Open the preview');
            
          } finally {
            await panel.close();
          }
        }
      }

      
    });
  });
});
