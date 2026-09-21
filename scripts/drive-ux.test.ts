/**
 * The Drive page, in a real browser.
 *
 * What only a browser can say about it: that a folder is a link a reader can
 * follow and the breadcrumb follows with it; that an upload picked through the
 * file input lands as a row without a reload; that "New folder" creates the
 * folder the dialog named; that "Mark as skill" is DISABLED on a folder that
 * is not a skill and says why on hover, and enabled on one that is, after
 * which the folder is linked under /skills; and that a pasted SKILL.md with no
 * front matter is refused inside the dialog with the parser's reason rather
 * than closing it.
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

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-drive-list] [data-drive-entry], [data-drive-empty]');

  return page;
}

async function shoot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });

  return path;
}

/** One row as a reader sees it: name, kind, whether it is a skill, and what
 *  the "Mark as skill" control says and allows. */
interface Row {
  name: string;
  kind: string;
  skill: boolean;
  mark: { disabled: boolean; title: string } | null;
}

async function rows(page: Page): Promise<Row[]> {
  return page.$$eval('[data-drive-list] [data-drive-entry]', (elements) => elements.map((element) => {
    const mark = element.querySelector('[data-drive-mark]');

    return {
      name: element.getAttribute('data-drive-entry') ?? '',
      kind: element.getAttribute('data-drive-kind') ?? '',
      skill: element.getAttribute('data-drive-skill') === 'true',
      mark: mark instanceof HTMLButtonElement ? { disabled: mark.disabled, title: mark.title } : null,
    };
  }));
}

function rowNamed(list: Row[], name: string): Row {
  const found = list.find((row) => row.name === name);

  if (!found) throw new Error(`no row named ${name}: ${JSON.stringify(list)}`);

  return found;
}

/** Wait until a row of that name is listed (or gone). */
async function waitForRow(page: Page, name: string, present = true): Promise<void> {
  await page.waitForFunction(
    (wanted, expected) => (document.querySelector(`[data-drive-entry="${wanted}"]`) !== null) === expected,
    {},
    name, present,
  );
}

const crumbs = (page: Page) => page.$$eval('nav[aria-label="Folder"] a', (anchors) => anchors.map((a) => a.textContent ?? ''));

describe('the Drive page', () => {
  test('lists a folder, follows a folder link, uploads a file, and makes a folder', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'drive', 'dark', 'desktop');

      try {
        const root = await rows(page);

        // Folders first, files after; the reserved two are folders with no
        // "mark" control at all; a plain folder that is not a skill carries a
        // disabled control that says why.
        expect(root.map((row) => [row.name, row.kind])).toEqual([
          ['blueprints', 'folder'], ['data', 'folder'], ['notes', 'folder'], ['projects', 'folder'], ['skills', 'folder'],
          ['README.md', 'file'],
        ]);
        expect(rowNamed(root, 'skills').mark).toBeNull();
        expect(rowNamed(root, 'notes').mark).toEqual({ disabled: true, title: 'no SKILL.md in /notes' });
        expect(rowNamed(root, 'README.md').mark).toBeNull();
        expect(await crumbs(page)).toEqual(['Drive']);
        await shoot(page, 'drive-root-dark');

        // A folder is a link: the URL and the breadcrumb follow it.
        await page.click('[data-drive-entry="projects"] a');
        await waitForRow(page, 'ops');
        expect(await crumbs(page)).toEqual(['Drive', 'projects']);
        await page.click('[data-drive-entry="ops"] a');
        await waitForRow(page, 'deploy');
        expect(await crumbs(page)).toEqual(['Drive', 'projects', 'ops']);

        // Upload through the picker: the row appears without a reload.
        const input = await page.$('input[data-drive-files-input]');

        if (input === null) throw new Error('no files input');
        await input.uploadFile(join(import.meta.dir, 'drive-ux.test.ts'));
        await waitForRow(page, 'drive-ux.test.ts');
        expect(await page.$('[data-drive-transfer="failed"]')).toBeNull();

        // A new folder, named in the dialog.
        await page.click('[data-drive-new-folder]');
        await page.waitForSelector('[role="dialog"] input');
        await page.type('[role="dialog"] input', 'staging');
        await page.click('[data-drive-dialog-commit]');
        await waitForRow(page, 'staging');
        expect(await page.$('[role="dialog"]')).toBeNull();
        expect(rowNamed(await rows(page), 'staging')).toMatchObject({ kind: 'folder', skill: false, mark: { disabled: true, title: 'no SKILL.md in /projects/ops/staging' } });
        await shoot(page, 'drive-folder-dark');
      } finally {
        await page.close();
      }
    });
  });

  test('marks a skill folder, refuses a folder that is not one, and refuses a pasted file with no front matter', async () => {
    await withGallery(async (gallery) => {
      const page2 = await freshPage(gallery, 'drive&path=/projects/ops', 'light', 'desktop');

      try {
        // `deploy` carries a SKILL.md naming itself: the control is live.
        expect(rowNamed(await rows(page2), 'deploy')).toMatchObject({ kind: 'folder', skill: true, mark: { disabled: false } });
        await page2.click('[data-drive-entry="deploy"] [data-drive-mark]');

        // Marking links it under /skills; the folder stays where it was. The
        // tenant lives in the page, so the link is reached by navigating
        // within it, never by a reload.
        await page2.click('nav[aria-label="Folder"] a');
        await waitForRow(page2, 'skills');
        await page2.click('[data-drive-entry="skills"] a');
        await waitForRow(page2, 'deploy');

        const skills = await rows(page2);

        expect(rowNamed(skills, 'deploy')).toMatchObject({ kind: 'symlink', skill: true, mark: null });
        expect(rowNamed(skills, 'review')).toMatchObject({ kind: 'folder', skill: true, mark: null });
        await shoot(page2, 'drive-skills-light');

        // The folder that is not a skill cannot be marked, and the control
        // says why rather than failing on click.
        await page2.click('nav[aria-label="Folder"] a');
        await waitForRow(page2, 'notes');
        expect(rowNamed(await rows(page2), 'notes').mark).toEqual({ disabled: true, title: 'no SKILL.md in /notes' });

        // A pasted SKILL.md without front matter: the dialog stays open and
        // names the parser's reason.
        await page2.click('[data-drive-add-skill]');
        await page2.waitForSelector('[data-drive-skill-text]');
        await page2.type('[data-drive-skill-text]', 'just some prose');
        await page2.click('[data-drive-add-skill-commit]');
        await page2.waitForSelector('[data-drive-skill-error]');
        const refusal = await page2.$eval('[data-drive-skill-error]', (element) => element.textContent ?? '');
        expect(refusal).toContain('SKILL.md');
        expect(await page2.$('[role="dialog"]')).not.toBeNull();
        await shoot(page2, 'drive-add-skill-refused-light');

        // And a well-formed one lands under /skills, where the page then goes.
        await page2.$eval('[data-drive-skill-text]', (element) => {
          if (element instanceof HTMLTextAreaElement) element.select();
        });
        await page2.keyboard.press('Backspace');
        await page2.type('[data-drive-skill-text]', '---\nname: triage\ndescription: Sort the inbox\n---\nSteps.');
        await page2.click('[data-drive-add-skill-commit]');
        await waitForRow(page2, 'triage');
        expect(await crumbs(page2)).toEqual(['Drive', 'skills']);
        expect(rowNamed(await rows(page2), 'triage')).toMatchObject({ kind: 'folder', skill: true });
      } finally {
        await page2.close();
      }
    });
  });

  test('the empty Drive and the phone width say what they must', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'drive-empty', 'dark', 'mobile');

      try {
        // An empty tenant still lists the two reserved folders, and nothing
        // else; a fresh reserved folder says it is empty.
        expect((await rows(page)).map((row) => row.name)).toEqual(['blueprints', 'skills']);
        await page.click('[data-drive-entry="skills"] a');
        await page.waitForSelector('[data-drive-empty]');
        expect(await page.$eval('[data-drive-empty]', (element) => element.textContent ?? '')).toContain('This folder is empty');
        await shoot(page, 'drive-empty-mobile-dark');
      } finally {
        await page.close();
      }
    });
  });
});
