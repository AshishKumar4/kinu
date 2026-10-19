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
            await shared.waitForFunction(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').includes('api-worker'));
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
            // Who can open it, the fork choice, and whose access it runs with: their own unless the owner picks theirs
            // (docs/SLATE-SHARING-NIMBUS.md §2), with no reach of the owner's to list until then.
            expect(await live.$eval('[data-share-access]', (element) => element.getAttribute('data-share-access'))).toBe('users');
            expect(await live.$eval('[data-share-mode][aria-checked="true"]', (element) => element.getAttribute('data-share-mode'))).toBe('own');
            expect(await live.$('[data-share-reach]')).toBeNull();
            expect(await live.$('[data-share-owner-warning]')).toBeNull();
            expect(await live.$eval('[data-share-fork]', (box) => box instanceof HTMLInputElement && box.checked)).toBe(true);
            // docs/SLATE-SHARING.md S5, independent of the constants used to render these bounds.
            const limits = await live.$eval('[data-share-limits]', (element) => element.textContent ?? '');
            const requests: number[] = [];
            const dollars: number[] = [];

            for (const [, currency, amount] of limits.matchAll(/(\$?)(\d+(?:\.\d+)?)/g)) {
              (currency === '$' ? dollars : requests).push(Number(amount));
            }

            expect({ requests, dollars }).toEqual({ requests: [120], dollars: [2] });
            
            // My access lists the reach the people it is shared with act within, and says what that means first.
            await live.click('[data-share-mode="owner"]');
            await live.waitForSelector('[data-share-owner-warning]');
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
            expect(text).toContain('Writes, edits or deletes files in workspace api-worker as you.');
            expect(text).toContain('Sends agent.send out of workspace api-worker as you');
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

            // A slate shared whose own files do not build alone says why it does not run.
            expect(await live.$('[data-share-broken]')).not.toBeNull();

            // A team share says who edits and who uses it, and that an editor's change stopped it on the owner's access.
            expect(await live.$$eval('[data-live-share="live-team-2"] [data-live-share-person]', (rows) => rows.map((row) => [row.getAttribute('data-live-share-person'), row.getAttribute('data-live-share-role')])))
              .toEqual([['pat@example.com', 'edit'], ['sam@example.com', 'use']]);
            expect(await live.$eval('[data-live-share="live-team-2"] [data-live-share-mode]', (element) => element.textContent ?? '')).toContain('pat@example.com');

            // What the owner answered "Always for this slate" to is listed by what it reaches, on its root, and taken back
            // from every share of the slate in one press, sent as the list named it.
            expect(await live.$$eval('[data-share-always-entry]', (rows) => rows.map((row) => row.getAttribute('data-share-always-entry'))))
              .toEqual(['issue-triage/mcp.github.create_issue', 'issue-triage/workspace.fs.write']);
            const standing = await live.$eval('[data-share-always]', (element) => element.textContent ?? '');
            expect(standing).toContain('GitHub');
            expect(standing).toContain('acme');
            await live.click('[data-share-always-entry="issue-triage/mcp.github.create_issue"] [data-share-always-withdraw]');
            await live.waitForFunction(() => document.querySelector('[data-share-always-entry="issue-triage/mcp.github.create_issue"]') === null);
            expect(JSON.parse(await live.$eval('html', (root) => root.getAttribute('data-gallery-withdrawn')) ?? 'null'))
              .toEqual({ slate: 'issue-triage', namespace: 'mcp.github', member: 'create_issue', root: { org: 'acme' } });
            expect(await live.$('[data-share-always-entry="issue-triage/workspace.fs.write"]')).not.toBeNull();

            // A share on the owner's access whose code changed is stopped; the owner sees its reach again, then approves it
            // at the slate's revision now.
            expect(await live.$eval('[data-live-share="live-board-1"] [data-live-share-mode]', (element) => element.getAttribute('data-live-share-mode'))).toBe('owner');
            await live.click('[data-live-share="live-board-1"] [data-live-share-review]');
            await live.waitForSelector('[data-share-approve-reach]');
            expect(await live.$('[data-share-reach]')).not.toBeNull();
            expect(await live.$('[data-share-submit]')).toBeNull();
            await live.click('[data-share-approve-reach]');
            await live.waitForFunction(() => document.querySelector('[data-live-share="live-board-1"] [data-live-share-review]') === null);
            expect(await live.$('[data-share-submit]')).not.toBeNull();

            // On the owner's access it is never listed, and the row says why.
            expect(await live.$('[data-share-gallery-owner]')).not.toBeNull();
            expect(await live.$('[data-share-gallery]')).toBeNull();

            // And it moves to each person's own access in one press: nothing of the owner's is used.
            await live.click('[data-live-share="live-board-1"] [data-live-share-own]');
            await live.waitForSelector('[data-live-share="live-board-1"] [data-live-share-mode="own"]');
            expect(await live.$('[data-live-share="live-board-1"] [data-live-share-own]')).toBeNull();

            // Then it can be listed, by a line and a category asked for first.
            await live.click('[data-share-gallery]');
            await live.type('[data-share-gallery-line]', 'Triage issues by label');
            await live.click('[data-share-gallery-category="developer"]');
            await live.click('[data-share-gallery-list]');
            await live.waitForFunction(() => (document.querySelector('[data-share-gallery-for]')?.textContent ?? '').includes('Triage issues by label'));
            // And taken off again.
            await live.click('[data-share-gallery]');
            await live.waitForFunction(() => !(document.querySelector('[data-share-gallery-for]')?.textContent ?? '').includes('Triage issues by label'));
          } finally {
            await live.close();
          }

          // A slate's first share asks what they start with; an empty copy shares a fork of its code in its place.
          const first = await freshPage(gallery, 'sharedialog-first', theme, viewport);

          try {
            expect(await first.$eval('[data-share-start][aria-checked="true"]', (element) => element.getAttribute('data-share-start'))).toBe('as-is');
            await first.click('[data-share-start="empty"]');
            // Each person added uses it, or edits it too.
            await first.type('[data-share-emails]', 'pat@example.com, sam@example.com');
            await first.waitForSelector('[data-share-person="sam@example.com"]');
            expect(await first.$('[data-share-editors-note]')).toBeNull();
            await first.click('[data-share-person="pat@example.com"] [data-share-person-role="edit"]');
            await first.waitForSelector('[data-share-editors-note]');
            await first.click('[data-share-submit]');
            await first.waitForSelector('[data-share-created]');
            const sent = JSON.parse(await first.$eval('html', (root) => root.getAttribute('data-gallery-shared')) ?? '{}');

            expect([sent.slate, sent.start, sent.emails, sent.editors]).toEqual(['issue-triage', 'empty', ['pat@example.com', 'sam@example.com'], ['pat@example.com']]);
          } finally {
            await first.close();
          }

          // A slate already shared asks nothing of it: its later shares share what the first one did.
          const again = await freshPage(gallery, 'sharedialog', theme, viewport);

          try {
            await again.waitForSelector('[data-share-mode]');
            expect(await again.$('[data-share-start]')).toBeNull();
          } finally {
            await again.close();
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
