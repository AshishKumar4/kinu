/**
 * A chat's slash commands in the real workspace page (ledger 1025-slash): the owner asked whether the web has slash
 * commands, and chose every command that fits the web. A lone `/` lists them over the field, a word narrows them as the
 * CLI's palette does, the keys move and pick, and each picked command does what the page already offers for it.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { withGallery } from '../../scripts/gallery-harness';

declare global {
  interface Window {
    galleryPath?: string;
    /** Every Blob the page handed the browser to save, its text as it reads. */
    gallerySaved?: Promise<string>[];
  }
}

const FIELD = '[data-composer-field]';

async function draft(page: Page, text: string): Promise<void> {
  await page.click(FIELD);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
}

/** The commands the open menu lists, in its order, and the one it highlights. */
async function menu(page: Page): Promise<{ readonly offered: string[]; readonly highlighted: string | null }> {
  return page.evaluate(() => ({
    offered: [...document.querySelectorAll('[data-slash-menu] [data-slash-command]')].map((row) => row.getAttribute('data-slash-command') ?? ''),
    highlighted: document.querySelector('[data-slash-menu] [aria-selected="true"]')?.getAttribute('data-slash-command') ?? null,
  }));
}

/** The field's draft. */
async function field(page: Page): Promise<string | null> {
  return page.$eval(FIELD, (box) => (box instanceof HTMLTextAreaElement ? box.value : null));
}

/** A data value the gallery's fixtures keep on the root. */
async function flag(page: Page, name: string): Promise<string | null> {
  return page.evaluate((key) => document.documentElement.dataset[key] ?? null, name);
}

/** The root's turn claim, as the server sends it each time it changes. */
async function claim(page: Page, state: Record<string, string | number>): Promise<void> {
  await page.evaluate((detail) => { window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail })); }, { type: 'turn_claim', claim: state });
}

/** The surface the inspector shows, by its tool's name. */
async function surface(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('button[aria-current="true"][aria-label]')?.getAttribute('aria-label') ?? null);
}

describe("a chat's slash commands", () => {
  test('listed over the field, narrowed by a word, moved and picked by key, each doing what the page offers', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=toolruns`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(FIELD);

      // A lone `/` lists what this chat runs; what only a CLI can do is not offered.
      await draft(page, '/');
      const all = (await menu(page)).offered;

      expect({ web: ['/stop', '/model', '/clear', '/tree', '/settings', '/stats', '/fork'].filter((name) => !all.includes(name)), cli: all.filter((name) => ['/exit', '/always', '/instructions', '/compact', '/cancel'].includes(name)) })
        .toEqual({ web: [], cli: [] });

      // A word narrows the list, best first; the arrows move the highlight, and Enter runs it.
      await draft(page, '/tr');
      expect((await menu(page)).highlighted).toBe('/tree');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('button[aria-current="true"][aria-label="Swarms"]') !== null);
      expect({ surface: await surface(page), draft: await field(page), open: (await menu(page)).offered })
        .toEqual({ surface: 'Swarms', draft: '', open: [] });

      // Escape closes the menu and keeps the draft; a sent alias runs its command, as `/new` does `/clear`'s.
      await draft(page, '/ne');
      await page.keyboard.press('Escape');
      expect({ open: (await menu(page)).offered, draft: await field(page) }).toEqual({ open: [], draft: '/ne' });
      await draft(page, '/new');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="dialog"]');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);

      // A command whose words it cannot use says so in the chat's notices, and sends nothing.
      await draft(page, '/effort sideways');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-command-notice]');

      // One that opens a page goes there.
      await draft(page, '/stats');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.galleryPath === '/user/settings#usage');
      await page.close();
    });
  });

  // Review, 2026-10-25: a command cleared the field before its words were taken, so words a Plan turn or a refused
  // branch did not take were lost, and its arguments lost their lines.
  test("a command's words keep their lines, and stay in the field until the chat takes them", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=toolruns`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(FIELD);

      // Sent in Plan mode, with its second line's indent.
      await draft(page, '/plan first line');
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await page.keyboard.type('  indented line');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.documentElement.dataset.galleryChatSent !== undefined);
      expect({ sent: JSON.parse(await flag(page, 'galleryChatSent') ?? '[]'), draft: await field(page) }).toEqual({ sent: ['text:first line\n  indented line'], draft: '' });

      // A turn runs. In Plan mode no branch runs beside it: the chat says so, and the words stay.
      await claim(page, { kind: 'admitted', turnId: 'slash-live', claimedAt: 1 });
      await page.waitForSelector('[data-stop]');
      await draft(page, '/branch try the other way');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-command-notice]');
      expect({ draft: await field(page), branched: await flag(page, 'galleryBranched') }).toEqual({ draft: '/branch try the other way', branched: null });

      // In Auto, a branch the agent refuses says why, and the words stay; one it takes clears them. The mode is chosen
      // between turns.
      await claim(page, { kind: 'settled' });
      await page.waitForFunction(() => document.querySelector('[data-stop]') === null);
      await page.evaluate(() => { [...document.querySelectorAll('[aria-label="Turn mode"] button')].find((mode) => mode.textContent?.trim() === 'Auto')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await claim(page, { kind: 'admitted', turnId: 'slash-live-2', claimedAt: 2 });
      await page.waitForSelector('[data-stop]');
      await page.evaluate(() => { document.documentElement.dataset.galleryBranchRefuses = '1'; });
      await page.click(FIELD);
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-branch-notice]');
      expect({ draft: await field(page), branched: await flag(page, 'galleryBranched') }).toEqual({ draft: '/branch try the other way', branched: 'try the other way' });
      await page.evaluate(() => { delete document.documentElement.dataset.galleryBranchRefuses; });
      await page.click(FIELD);
      await page.keyboard.press('Enter');
      await page.waitForFunction((selector: string) => {
        const box = document.querySelector(selector);

        return box instanceof HTMLTextAreaElement && box.value === '';
      }, {}, FIELD);
      await page.close();
    });
  });

  // Review, 2026-10-25: /export and /fork read the window the tab held, not the conversation, and miscounted it.
  test('/export writes the whole conversation and /fork counts back through it, older pages unloaded', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await page.evaluateOnNewDocument(() => {
        const made = URL.createObjectURL.bind(URL);

        window.gallerySaved = [];
        URL.createObjectURL = (object) => {
          if (object instanceof Blob) window.gallerySaved?.push(object.text());

          return made(object);
        };
      });
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&history=400`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(FIELD);
      await page.waitForFunction(() => document.querySelector('.p-thread-column')?.textContent?.includes('Answer 399.') === true);
      // The tab holds the newest page alone.
      expect(await page.evaluate(() => document.querySelector('.p-thread-column')?.textContent?.includes('Question 0:') ?? null)).toBe(false);

      await draft(page, '/export');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (window.gallerySaved?.length ?? 0) > 0);
      const [markdown = ''] = await page.evaluate(async () => Promise.all(window.gallerySaved ?? []));

      expect({ oldest: markdown.includes('Question 0: what changed'), newest: markdown.includes('Answer 399.') }).toEqual({ oldest: true, newest: true });

      // The 150th of the owner's 200 messages back from the newest is question 100.
      await draft(page, '/fork 150');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-revert-action="conversation"]');
      await page.click('[data-revert-action="conversation"]');
      await page.waitForFunction(() => document.documentElement.dataset.galleryRevertedTo !== undefined);
      expect(await flag(page, 'galleryRevertedTo')).toBe('hist-00100');
      await page.close();
    });
  });
});
