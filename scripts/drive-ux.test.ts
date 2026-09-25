/**
 * The Drive, in a real browser.
 *
 * What only a browser can say about it: that My stuff tiles the owner's
 * slates, blueprints, folders and files in that order and draws no section it
 * has nothing for; that a folder is a link a reader can follow and the
 * breadcrumb follows with it; that an upload picked through the file input
 * lands as a tile without a reload; that New folder creates the folder the
 * dialog named; that "Mark as skill" in a folder's menu is refused on a folder
 * that is not a skill, with the reason, and allowed on one that is, after which
 * the folder is linked under /skills; that the Skills folder is always there,
 * showing the built-in skills read only beside the owner's, in the order and
 * precedence of the /skills view agents read; that a pasted SKILL.md with no
 * front matter is refused inside the dialog with the parser's reason; that a
 * file opens in the viewer; that the Shared tab exists only once something is
 * shared, and a new account someone shared with lands on it.
 *
 * The fixture is the gallery's own: `?frame=drive` mounts the real DrivePage
 * over an in-memory tenant driven by the SAME core rules the Durable Object
 * runs (gallery-drive.tsx), so every refusal here is the product's rule.
 * Screenshots land in ~/kinu-logs/drive-ux/ (outside the worktree).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from './gallery-harness';

const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'drive-ux');

mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

/** A one-pixel PNG: what a slate's picture route answers here, since the gallery serves none. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-drive-section], [data-drive-empty]');

  return page;
}

async function shoot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });

  return path;
}

/** The sections as drawn, in order, with the names their tiles show. */
function sections(page: Page): Promise<{ title: string; tiles: string[] }[]> {
  return page.$$eval('[data-drive-section]', (elements) => elements.map((element) => ({
    title: element.getAttribute('data-drive-section') ?? '',
    tiles: [...element.querySelectorAll('[data-drive-tile-name]')].map((name) => name.textContent?.trim() ?? ''),
  })));
}

/** The entries My stuff lists, as `[name, kind]`. */
function entries(page: Page): Promise<string[][]> {
  return page.$$eval('[data-drive-entry]', (elements) => elements.map((element) => [
    element.getAttribute('data-drive-entry') ?? '', element.getAttribute('data-drive-kind') ?? '',
  ]));
}

async function waitForEntry(page: Page, name: string): Promise<void> {
  await page.waitForFunction((wanted) => document.querySelector(`[data-drive-entry="${wanted}"]`) !== null, {}, name);
}

const crumbs = (page: Page) => page.$$eval('nav[aria-label="Folder"] a', (anchors) => anchors.map((a) => a.textContent?.trim() ?? ''));

/** The Skills folder's tiles as drawn: name, whether built in, and the meta line. */
function skillTiles(page: Page): Promise<{ name: string; builtin: boolean; meta: string }[]> {
  return page.$$eval('[data-drive-section="Skills"] li', (tiles) => tiles.map((tile) => ({
    name: tile.querySelector('[data-drive-tile-name]')?.textContent?.trim() ?? '',
    builtin: tile.hasAttribute('data-drive-builtin'),
    meta: tile.querySelector('[data-drive-tile-meta]')?.textContent?.trim() ?? '',
  })));
}

/** Open a tile's menu; each item by its accessible name, with the reason a refused one gives. */
async function menuOf(page: Page, tile: string): Promise<{ label: string; refused: string | null }[]> {
  await page.click(`${tile} [data-drive-menu]`);
  await page.waitForSelector(`${tile} [role="menu"]`);

  return page.$$eval(`${tile} [role="menuitem"]`, (items) => items.map((item) => {
    const text = (id: string | null): string | null => (id === null ? null : document.getElementById(id)?.textContent?.trim() ?? null);

    return {
      label: text(item.getAttribute('aria-labelledby')) ?? item.textContent?.trim() ?? '',
      refused: item.getAttribute('aria-disabled') === 'true' ? text(item.getAttribute('aria-describedby')) : null,
    };
  }));
}

/** Tab from the focus until an element named `label` has it: whether it says it is disabled, and why. */
async function tabTo(page: Page, label: string): Promise<{ disabled: string | null; reason: string | null } | null> {
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab');

    const reached = await page.evaluate((wanted) => {
      const element = document.activeElement;
      const text = (id: string | null): string | null => (id === null ? null : document.getElementById(id)?.textContent?.trim() ?? null);

      if (element === null || (text(element.getAttribute('aria-labelledby')) ?? element.textContent?.trim()) !== wanted) return null;

      return { disabled: element.getAttribute('aria-disabled'), reason: text(element.getAttribute('aria-describedby')) };
    }, label);

    if (reached !== null) return reached;
  }

  return null;
}

async function pressNew(page: Page, item: string): Promise<void> {
  await page.click('[data-drive-new]');
  await page.waitForSelector(`[${item}]`);
  await page.click(`[${item}]`);
}

describe('the Drive', () => {
  test('My stuff tiles slates, blueprints, folders and files, and a folder link, an upload and New folder work', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'drive', 'dark', 'desktop');

      try {
        // The owner's own things, in one grid, in this order; Skills leads the folders.
        expect(await sections(page)).toEqual([
          { title: 'Slates', tiles: ['Issue triage', 'Landing perf report', 'Standup notes'] },
          { title: 'Blueprints', tiles: ['Issue triage'] },
          { title: 'Folders', tiles: ['Skills', 'data', 'notes', 'projects'] },
          { title: 'Files', tiles: ['README.md'] },
        ]);
        // A slate opens in its workspace, on its own tab.
        expect(await page.$eval('[data-drive-slate="issue-triage"] a', (a) => a.getAttribute('href')))
          .toBe('/workspace/checkout-fixes?slate=issue-triage');
        expect(await page.$$eval('[data-drive-tab]', (tabs) => tabs.map((tab) => tab.textContent?.trim()))).toEqual(['My stuff', 'Shared']);
        await shoot(page, 'drive-mine-dark');

        // A folder is a link: the breadcrumb follows it.
        await page.click('[data-drive-entry="projects"] a');
        await waitForEntry(page, 'ops');
        expect(await crumbs(page)).toEqual(['My stuff', 'projects']);
        // Below the root the owner's slates and blueprints are not repeated.
        expect((await sections(page)).map((section) => section.title)).toEqual(['Folders']);
        await page.click('[data-drive-entry="ops"] a');
        await waitForEntry(page, 'deploy');
        expect(await crumbs(page)).toEqual(['My stuff', 'projects', 'ops']);

        // Upload through the picker: the tile appears without a reload.
        const input = await page.$('input[data-drive-files-input]');

        if (input === null) throw new Error('no files input');
        await input.uploadFile(join(import.meta.dir, 'drive-ux.test.ts'));
        await waitForEntry(page, 'drive-ux.test.ts');
        expect(await page.$('[data-drive-transfer="failed"]')).toBeNull();

        // A new folder, named in the dialog.
        await pressNew(page, 'data-drive-new-folder');
        await page.waitForSelector('[role="dialog"] input');
        await page.type('[role="dialog"] input', 'staging');
        await page.click('[data-drive-dialog-commit]');
        await waitForEntry(page, 'staging');
        expect(await page.$('[role="dialog"]')).toBeNull();
        expect(await menuOf(page, '[data-drive-entry="staging"]')).toContainEqual({ label: 'Mark as skill', refused: 'no SKILL.md in /projects/ops/staging' });
        // The keyboard reaches the refused item too, and hears why.
        expect(await tabTo(page, 'Mark as skill')).toEqual({ disabled: 'true', reason: 'no SKILL.md in /projects/ops/staging' });
        await shoot(page, 'drive-folder-dark');
      } finally {
        await page.close();
      }
    });
  });

  test('a slate tile shows its picture, and its cover while it has none or when the picture fails', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();

      try {
        // Issue triage's picture answers; Landing perf report's is missing; Standup notes has none yet.
        await page.setRequestInterception(true);
        page.on('request', async (request) => {
          const { pathname } = new URL(request.url());

          if (!pathname.startsWith('/api/user/pictures/')) await request.continue();
          else if (pathname.startsWith('/api/user/pictures/checkout-fixes/issue-triage/')) await request.respond({ status: 200, contentType: 'image/png', body: PIXEL });
          else await request.respond({ status: 404, body: 'No such picture.' });
        });
        await page.setViewport(VIEWPORTS.desktop);
        await page.goto(`${gallery.origin}/gallery.html?frame=drive`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-drive-slate]');
        // Every picture has answered, and a frame has drawn what its tile made of the answer.
        await page.waitForFunction(() => [...document.querySelectorAll('[data-drive-slate] img')].every((img) => img instanceof HTMLImageElement && img.complete));
        await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));

        expect(await page.$$eval('[data-drive-slate]', (tiles) => tiles.map((tile) => {
          const img = tile.querySelector('img');
          let drawn = 'cover';

          if (img !== null) drawn = img.naturalWidth > 0 ? 'picture' : 'broken';

          return [tile.getAttribute('data-drive-slate'), drawn];
        }))).toEqual([['issue-triage', 'picture'], ['lighthouse', 'cover'], ['standup', 'cover']]);
      } finally {
        await page.close();
      }
    });
  });

  test('marks a skill folder from its menu, shows the built-in skills beside it, and refuses a pasted file with no front matter', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'drive&path=/projects/ops', 'light', 'desktop');

      try {
        const deploy = '[data-drive-entry="deploy"]';
        expect((await menuOf(page, deploy)).find((item) => item.label === 'Mark as skill')).toEqual({ label: 'Mark as skill', refused: null });
        await page.click(`${deploy} [data-drive-mark]`);

        // Marking links it under /skills; the folder stays where it was.
        await page.click('[data-drive-crumb]');
        await waitForEntry(page, 'skills');
        await page.click('[data-drive-entry="skills"] a');
        await waitForEntry(page, 'deploy');
        expect(await entries(page)).toEqual([
          ['deploy', 'symlink'], ['review', 'folder'], ['slates', 'folder'], ['review.md', 'file'], ['slates.md', 'file'], ['standup.md', 'file'],
        ]);
        // The built-in skills sit among the owner's in the /skills view's order: by name, a built-in ahead of the
        // owner's skill of its name, which agents never see and whose tile says so.
        expect(await skillTiles(page)).toEqual([
          { name: 'audit-implementation', builtin: true, meta: 'Built in' },
          { name: 'deploy', builtin: false, meta: 'From projects/ops/deploy' },
          { name: 'review', builtin: false, meta: expect.any(String) },
          { name: 'slates', builtin: true, meta: 'Built in' },
          { name: 'slates', builtin: false, meta: 'Not used' },
        ]);

        // A flat skill file is read as discovery reads it: the folder beside review.md takes its name, slates.md
        // has a built-in's, and standup.md is a skill agents use.
        const flat = await page.$$eval('[data-drive-kind="file"]', (tiles) => tiles.map((tile) => [
          tile.getAttribute('data-drive-entry'),
          tile.querySelector('[data-drive-tile-meta]')?.textContent?.trim() ?? '',
          tile.querySelector('[data-drive-tile-meta] [title]')?.getAttribute('title') ?? null,
        ]));

        expect(flat).toEqual([
          ['review.md', 'Not used', 'Agents read skills/review/SKILL.md instead'],
          ['slates.md', 'Not used', 'A built-in skill has this name, so agents use the built-in'],
          ['standup.md', expect.stringMatching(/^\d+ B · /u), null],
        ]);
        // The reserved folder is not renamed or deleted, and its skills say who uses them.
        expect(await page.evaluate(() => document.body.innerText)).toContain('Every workspace you own uses these skills.');
        await shoot(page, 'drive-skills-light');

        // A built-in is read only: no menu, and it opens as the SKILL.md agents read, with no edit and a download
        // of the same text.
        expect(await page.$('[data-drive-builtin="audit-implementation"] [data-drive-menu]')).toBeNull();
        await page.click('[data-drive-builtin="audit-implementation"] button');
        await page.waitForFunction(() => (document.querySelector('[data-drive-viewer] [data-files-preview-body]')?.textContent ?? '').includes('Audit your implementation'));
        expect(await page.$('[data-drive-viewer] [data-files-edit]')).toBeNull();
        expect(await page.$eval('[data-drive-viewer]', (element) => element.textContent ?? '')).toContain('Built in');

        // Its front matter reads as the YAML it is, the first block, rather than as a paragraph under a rule.
        const firstBlock = await page.$eval('[data-drive-viewer] [data-files-preview-body] .p-code', (block) => block.textContent ?? '');

        expect(firstBlock).toStartWith('yaml');
        expect(firstBlock).toContain('name: audit-implementation');

        const download = await page.$eval('[data-drive-viewer] [data-files-download]', async (anchor) => ({
          name: anchor.getAttribute('download'),
          text: await (await fetch(anchor.getAttribute('href') ?? '')).text(),
        }));

        expect(download.name).toBe('SKILL.md');
        expect(download.text).toStartWith('---\nname: audit-implementation\n');
        await page.click('[data-drive-viewer] [aria-label="Close preview"]');
        await page.waitForFunction(() => document.querySelector('[data-drive-viewer]') === null);

        // In Skills the one action is New skill; a SKILL.md without front matter is refused in the dialog.
        await page.click('[data-drive-add-skill]');
        await page.waitForSelector('[data-drive-skill-text]');
        await page.type('[data-drive-skill-text]', 'just some prose');
        await page.click('[data-drive-add-skill-commit]');
        await page.waitForSelector('[data-drive-skill-error]');
        expect(await page.$eval('[data-drive-skill-error]', (element) => element.textContent ?? '')).toContain('SKILL.md');
        expect(await page.$('[role="dialog"]')).not.toBeNull();

        await page.$eval('[data-drive-skill-text]', (element) => {
          if (element instanceof HTMLTextAreaElement) element.select();
        });
        await page.keyboard.press('Backspace');
        await page.type('[data-drive-skill-text]', '---\nname: triage\ndescription: Sort the inbox\n---\nSteps.');
        await page.click('[data-drive-add-skill-commit]');
        await waitForEntry(page, 'triage');
        expect(await crumbs(page)).toEqual(['My stuff', 'Skills']);
      } finally {
        await page.close();
      }
    });
  });

  test('a file opens in the viewer, and the Shared tab holds both directions', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'drive', 'dark', 'desktop');

      try {
        await page.click('[data-drive-entry="README.md"] button');
        await page.waitForSelector('[data-drive-viewer] [data-files-preview-body]');
        await page.waitForFunction(() => (document.querySelector('[data-files-preview-body]')?.textContent ?? '').includes('Shared across every workspace'));
        // The Drive's copy is read-only: no edit control, and a download.
        expect(await page.$('[data-drive-viewer] [data-files-edit]')).toBeNull();
        expect(await page.$('[data-drive-viewer] [data-files-download]')).not.toBeNull();
        await shoot(page, 'drive-file-dark');
      } finally {
        await page.close();
      }

      const shared = await freshPage(gallery, 'shared', 'light', 'desktop');

      try {
        expect(await sections(shared)).toEqual([
          { title: 'Shared with you', tiles: ['Inbox digest', 'Deploy status board'] },
          { title: 'Shared by you', tiles: ['Issue triage', 'Issue triage'] },
        ]);
        // Newest first, though the owner's rows arrive oldest first.
        expect(await shared.$$eval('[data-drive-section="Shared by you"] [data-drive-share-kind]',
          (tiles) => tiles.map((tile) => tile.getAttribute('data-drive-share-kind')))).toEqual(['live', 'blueprint']);

        // Search narrows both sections by title, description or sharer, and says so when nothing matches.
        const search = async (text: string): Promise<void> => {
          await shared.click('[data-drive-search]', { count: 3 });
          await shared.keyboard.press('Backspace');

          if (text !== '') await shared.type('[data-drive-search]', text);
        };

        await search('digest');
        expect(await sections(shared)).toEqual([{ title: 'Shared with you', tiles: ['Inbox digest'] }]);
        await search('every service');
        expect(await sections(shared)).toEqual([{ title: 'Shared with you', tiles: ['Deploy status board'] }]);
        await search('SAM@');
        expect(await sections(shared)).toEqual([{ title: 'Shared with you', tiles: ['Inbox digest', 'Deploy status board'] }]);
        await search('triage');
        expect(await sections(shared)).toEqual([{ title: 'Shared by you', tiles: ['Issue triage', 'Issue triage'] }]);
        await search('nothing like it');
        expect(await sections(shared)).toEqual([]);
        expect(await shared.$eval('[data-drive-no-match]', (element) => element.textContent)).toBe('Nothing matches “nothing like it”');
        await search('');
        // Both forks where the sharer allows it; what the owner shared also stops.
        expect((await menuOf(shared, '[data-drive-share="live-mail-9"]')).map((item) => item.label)).toEqual(['Open', 'Fork…']);
        expect((await menuOf(shared, '[data-drive-share="live-board-1"]')).map((item) => item.label)).toEqual(['Open', 'Fork…', 'Stop sharing']);
        await shared.click('[data-drive-share="live-board-1"] [data-drive-stop-sharing]');
        await shared.waitForSelector('[role="dialog"]');
        expect(await shared.$eval('[role="dialog"]', (element) => element.textContent ?? '')).toContain('Everyone with the link loses access right away');
        await shoot(shared, 'drive-shared-light');
      } finally {
        await shared.close();
      }
    });
  });

  test('a new account holds only Skills, with the built-in skills in it, and one someone shared with lands on Shared', async () => {
    await withGallery(async (gallery) => {
      const empty = await freshPage(gallery, 'drive-empty', 'dark', 'mobile');

      try {
        // No tabs and no empty state: the Skills folder alone, since the built-in skills are always in it.
        expect(await sections(empty)).toEqual([{ title: 'Folders', tiles: ['Skills'] }]);
        expect(await empty.$$('[data-drive-tab]')).toHaveLength(0);
        await shoot(empty, 'drive-empty-mobile-dark');
        await empty.click('[data-drive-entry="skills"] a');
        await empty.waitForSelector('[data-drive-builtin]');
        expect(await skillTiles(empty)).toEqual([
          { name: 'audit-implementation', builtin: true, meta: 'Built in' },
          { name: 'slates', builtin: true, meta: 'Built in' },
        ]);
      } finally {
        await empty.close();
      }

      const recipient = await freshPage(gallery, 'drive-recipient', 'light', 'mobile');

      try {
        await recipient.waitForSelector('[data-drive-tab="shared"][aria-current="page"]');
        expect(await sections(recipient)).toEqual([{ title: 'Shared with you', tiles: ['Inbox digest', 'Deploy status board'] }]);
        await shoot(recipient, 'drive-recipient-mobile-light');

        // Pressing My stuff shows it, holding only Skills, rather than bouncing back.
        await recipient.click('[data-drive-tab="mine"]');
        await recipient.waitForSelector('[data-drive-tab="mine"][aria-current="page"]');
        await recipient.waitForSelector('[data-drive-section]');
        expect(await sections(recipient)).toEqual([{ title: 'Folders', tiles: ['Skills'] }]);
      } finally {
        await recipient.close();
      }
    });
  });
});
