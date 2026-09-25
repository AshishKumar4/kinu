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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { packZip } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import type { Page } from 'puppeteer';

import { contrast, rgba, withGallery, type Gallery } from './gallery-harness';

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

/** Resolves once a frame has been drawn after everything before it. */
/** Upload tiles still drawn, as state and name. */
const transfers = (page: Page) => page.$$eval('[data-drive-transfer]', (tiles) => tiles.map((tile) => `${tile.getAttribute('data-drive-transfer') ?? ''} ${tile.querySelector('[data-drive-tile-name]')?.textContent?.trim() ?? ''}`));

async function drawn(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
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

  /** Opens `frame` with Issue triage's picture answering, every other picture missing, and reads what each tile under
   *  `selector` drew once every picture has answered and a frame has drawn the answer. */
  async function drawnPictures(gallery: Gallery, frame: string, selector: string, key: string): Promise<[string | null, string][]> {
    const page = await gallery.newPage();

    try {
      await page.setRequestInterception(true);
      page.on('request', async (request) => {
        const { pathname } = new URL(request.url());

        if (!pathname.startsWith('/api/user/pictures/')) await request.continue();
        else if (pathname.startsWith('/api/user/pictures/checkout-fixes/issue-triage/')) await request.respond({ status: 200, contentType: 'image/png', body: PIXEL });
        else await request.respond({ status: 404, body: 'No such picture.' });
      });
      await page.setViewport(VIEWPORTS.desktop);
      await page.goto(`${gallery.origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(selector);
      await page.waitForFunction((tiles: string) => [...document.querySelectorAll(`${tiles} img`)].every((img) => img instanceof HTMLImageElement && img.complete), {}, selector);
      await drawn(page);

      return await page.$$eval(selector, (tiles, attribute) => tiles.map((tile): [string | null, string] => {
        const img = tile.querySelector('img');
        let shows = 'cover';

        if (img !== null) shows = img.naturalWidth > 0 ? 'picture' : 'broken';

        return [tile.getAttribute(attribute), shows];
      }), key);
    } finally {
      await page.close();
    }
  }

  test('a slate tile shows its picture, and its cover while it has none or when the picture fails', async () => {
    await withGallery(async (gallery) => {
      // Issue triage's picture answers; Landing perf report's is missing; Standup notes has none yet.
      expect(await drawnPictures(gallery, 'drive', '[data-drive-slate]', 'data-drive-slate'))
        .toEqual([['issue-triage', 'picture'], ['lighthouse', 'cover'], ['standup', 'cover']]);
    });
  });

  test('a live share of yours shows its slate\'s picture; a blueprint and a share you received keep their covers', async () => {
    await withGallery(async (gallery) => {
      const tiles = await drawnPictures(gallery, 'shared', '[data-drive-share]', 'data-drive-share');

      // Only a live share of yours has a slate of yours to show; the others, two blueprints and a live share someone
      // gave you, keep their covers.
      expect(tiles.filter(([, how]) => how === 'picture').map(([id]) => id)).toEqual(['live-board-1']);
      expect(tiles.length).toBe(4);
    });
  });

  test("an upload's bar stands out on its tile, on both themes", async () => {
    await withGallery(async (gallery) => {
      for (const theme of ['dark', 'light'] as const) {
        const page = await freshPage(gallery, 'drive&path=/projects/ops', theme, 'desktop');

        try {
          // Held in flight: the page's own fetch never answers the upload.
          await page.evaluate(() => {
            const real = window.fetch;

            window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PUT' ? new Promise<Response>(() => {}) : real(input, init)), { preconnect: real.preconnect });
          });
          const input = await page.$('input[data-drive-files-input]');

          if (input === null) throw new Error('no files input');
          await input.uploadFile(join(import.meta.dir, 'drive-ux.test.ts'));
          await page.waitForSelector('[data-drive-transfer="uploading"]');

          const [sweep, ground] = await page.$eval('[data-drive-transfer="uploading"] [role="progressbar"]', (bar) => [
            getComputedStyle(bar, '::after').backgroundColor,
            getComputedStyle(bar.parentElement ?? bar).backgroundColor,
          ]);

          // WCAG's floor for a graphic that carries meaning.
          expect(contrast(rgba(sweep), rgba(ground))).toBeGreaterThanOrEqual(3);
        } finally {
          await page.close();
        }
      }
    });
  });

  test('an upload is a tile in its folder until it lands; Cancel stops it, and a refusal stays with its reason', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'drive', 'dark', 'desktop');

      try {
        // An empty folder to upload into.
        await pressNew(page, 'data-drive-new-folder');
        await page.waitForSelector('[role="dialog"] input');
        await page.type('[role="dialog"] input', 'archive');
        await page.click('[data-drive-dialog-commit]');
        await waitForEntry(page, 'archive');
        await page.click('[data-drive-entry="archive"] a');
        await page.waitForSelector('[data-drive-empty]');

        // The gallery's network is the page's own fetch: an upload is held until aborted, or refused when asked.
        await page.evaluate(() => {
          const real = window.fetch;

          window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method !== 'PUT') return real(input, init);

            if (document.documentElement.dataset.put === 'refuse') {
              return Promise.resolve(new Response(JSON.stringify({ error: 'File too large for the Drive' }), { status: 413, headers: { 'content-type': 'application/json' } }));
            }

            return new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal?.reason)); });
          }, { preconnect: real.preconnect });
        });

        const input = await page.$('input[data-drive-files-input]');
        const file = join(import.meta.dir, 'drive-ux.test.ts');

        if (input === null) throw new Error('no files input');

        // In flight, the folder is no longer empty: the file is a tile in Files.
        await input.uploadFile(file);
        await drawn(page);
        expect(await page.$('[data-drive-empty]')).toBeNull();
        expect(await sections(page)).toEqual([{ title: 'Files', tiles: ['drive-ux.test.ts'] }]);

        // Cancelled, the tile goes and the folder is empty again.
        await menuOf(page, '[data-drive-transfer="uploading"]');
        await page.click('[data-drive-transfer="uploading"] [data-drive-cancel-upload]');
        await drawn(page);
        expect(await page.$('[data-drive-transfer]')).toBeNull();
        expect(await page.$('[data-drive-empty]')).not.toBeNull();

        // Refused, the tile stays with the Drive's reason until it is dismissed.
        await page.evaluate(() => { document.documentElement.dataset.put = 'refuse'; });
        await input.uploadFile(file);
        await drawn(page);
        expect(await page.$eval('[data-drive-transfer]', (tile) => [tile.getAttribute('data-drive-transfer'), tile.textContent?.includes('File too large for the Drive')]))
          .toEqual(['failed', true]);
        await menuOf(page, '[data-drive-transfer="failed"]');
        await page.click('[data-drive-transfer="failed"] [data-drive-dismiss-upload]');
        await drawn(page);
        expect(await page.$('[data-drive-transfer]')).toBeNull();
      } finally {
        await page.close();
      }
    });
  });

  test('a folder and a .zip upload each leave their tile once done; a cancelled one leaves nothing', async () => {
    const scratch = scratchDir('drive-ux-uploads');
    const picked = join(scratch, 'photos');
    mkdirSync(picked);
    writeFileSync(join(picked, 'one.txt'), 'one');
    const archive = join(scratch, 'bundle.zip');
    const later = join(scratch, 'later.zip');

    for (const zip of [archive, later]) writeFileSync(zip, packZip([{ path: 'inner.txt', bytes: new TextEncoder().encode('inner') }]));

    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'drive&path=/projects/ops', 'dark', 'desktop');

      try {
        const folderInput = await page.$('input[data-drive-folder-input]');
        const zipInput = await page.$('input[data-drive-zip-input]');

        if (folderInput === null || zipInput === null) throw new Error('no folder or zip input');

        await folderInput.uploadFile(picked);
        await waitForEntry(page, 'photos');
        await drawn(page);
        expect(await transfers(page)).toEqual([]);

        await zipInput.uploadFile(archive);
        await waitForEntry(page, 'bundle');
        await drawn(page);
        expect(await transfers(page)).toEqual([]);

        // Held until aborted: Cancel takes the tile, and the folder never lands.
        await page.evaluate(() => {
          const real = window.fetch;

          window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PUT'
            ? new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal?.reason)); })
            : real(input, init)), { preconnect: real.preconnect });
        });
        await zipInput.uploadFile(later);
        await page.waitForSelector('[data-drive-transfer="uploading"]');
        await menuOf(page, '[data-drive-transfer="uploading"]');
        await page.click('[data-drive-transfer="uploading"] [data-drive-cancel-upload]');
        await drawn(page);
        expect(await transfers(page)).toEqual([]);
        expect(await page.$('[data-drive-entry="later"]')).toBeNull();
      } finally {
        await page.close();
      }
    });
  });

  test('a sheet\'s tile draws its first rows as cells, a code file\'s its lines numbered, and Markdown\'s its page', async () => {
    await withGallery(async (gallery) => {
      // A cover is drawn once its file is read, when the tile holds the file's first words however it draws them.
      const read = async (query: string, entry: string, words: string): Promise<Page> => {
        const page = await freshPage(gallery, query, 'dark', 'desktop');

        await page.waitForFunction((tile: string, first: string) => document.querySelector(`[data-drive-entry="${tile}"]`)?.textContent?.includes(first) === true, {}, entry, words);
        await drawn(page);

        return page;
      };

      const sheet = await read('drive&path=/data', 'customers.csv', 'plan');

      try {
        expect(await sheet.$$eval('[data-drive-entry="customers.csv"] [data-drive-sheet-row]', (rows) => rows.slice(0, 2).map((row) => [...row.children].map((cell) => cell.textContent))))
          .toEqual([['id', 'name', 'plan', 'seats'], ['1', 'Lovelace, Ada', 'Team', '2']]);
      } finally {
        await sheet.close();
      }

      const code = await read('drive&path=/projects/ops/deploy/scripts', 'run.sh', '#!/bin/sh');

      try {
        const lines = await code.$$eval('[data-drive-entry="run.sh"] [data-drive-code-line]', (rows) => rows.map((row) => [row.children[0]?.textContent, row.children[1]?.textContent]));

        expect(lines.slice(0, 3)).toEqual([['1', '#!/bin/sh'], ['2', '# Ship the current branch to production.'], ['3', 'set -eu']]);
        expect(lines.map(([number]) => number)).toEqual(lines.map((_, index) => String(index + 1)));
      } finally {
        await code.close();
      }

      const prose = await read('drive&path=/projects/ops', 'runbook.md', 'Runbook');

      try {
        const drawnPage = await prose.$eval('[data-drive-entry="runbook.md"]', (tile) => ({
          heading: tile.querySelector('[data-drive-page-heading]')?.textContent ?? null,
          lines: [...tile.querySelectorAll('[data-drive-page-line]')].map((line) => line.textContent?.trim() ?? ''),
        }));

        // The first heading titles the page, a list keeps its bullets, and no line shows Markdown's own marks.
        expect(drawnPage.heading).toBe('Runbook');
        expect(drawnPage.lines.some((line) => line.startsWith('• '))).toBe(true);
        expect(drawnPage.lines.filter((line) => /^#|^[-*+] |`|\*\*|\]\(/u.test(line))).toEqual([]);
      } finally {
        await prose.close();
      }
    });
  });

  test('marks a skill folder from its menu, shows the built-in skills beside it, and refuses a pasted file with no front matter', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'drive&path=/projects/ops', 'light', 'desktop');

      try {
        const deploy = '[data-drive-entry="deploy"]';
        const markOf = (tile: string): Promise<string> => page.$eval(`${tile} svg`, (svg) => svg.outerHTML);
        const skillMark = await markOf(deploy);
        expect((await menuOf(page, deploy)).find((item) => item.label === 'Mark as skill')).toEqual({ label: 'Mark as skill', refused: null });
        await page.click(`${deploy} [data-drive-mark]`);

        // Marking links it under /skills; the folder stays where it was.
        await page.click('[data-drive-crumb]');
        await waitForEntry(page, 'skills');
        // The Skills folder holds skills without being one, and wears their mark; a plain folder does not.
        expect(await markOf('[data-drive-entry="skills"]')).toBe(skillMark);
        expect(await markOf('[data-drive-entry="projects"]')).not.toBe(skillMark);
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
        // A built-in skill's tile reads as its page: its steps show none of Markdown's own marks.
        const builtinLines = await page.$$eval('[data-drive-builtin] [data-drive-page-line]', (lines) => lines.map((line) => line.textContent ?? ''));

        expect(builtinLines.length).toBeGreaterThan(0);
        expect(builtinLines.filter((line) => /^#|`|\*\*/u.test(line))).toEqual([]);
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

  test('a Markdown file opens as a document: its headings stand above its text, and its lists keep their markers', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'drive&path=/projects/ops%3Ffile%3Drunbook.md', 'dark', 'desktop');

      try {
        await page.waitForSelector('[data-drive-viewer] [data-files-preview-body] li');

        const read = await page.$eval('[data-drive-viewer] [data-files-preview-body]', (body) => {
          const size = (selector: string): number => Number.parseFloat(getComputedStyle(body.querySelector(selector) ?? body).fontSize);

          return {
            headings: [size('h1'), size('h2')].every((heading) => heading > size('p')),
            markers: [...body.querySelectorAll('ol, ul')].map((list) => getComputedStyle(list).listStyleType),
          };
        });

        expect(read).toEqual({ headings: true, markers: ['decimal', 'disc'] });
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
        // The confirmation names everyone the share was given to, the two people who lose it.
        const confirm = await shared.$eval('[role="dialog"]', (element) => element.textContent ?? '');

        expect(['sam@example.com', 'lee@example.com'].filter((person) => !confirm.includes(person))).toEqual([]);
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
