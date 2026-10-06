/**
 * The workspace bar, as a browser drives it on the real page: + asks the landing's question and the first message
 * opens a chat as the current tab; a chat renames in its tab and deletes after a confirmation; Main renames and never
 * deletes; drafts stay with their conversation; and the open tab is the one the hairline rises around.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const TAB_SHOTS = join(import.meta.dir, '..', '..', '..', 'kinu-logs', 'workspace-bar-ux');

mkdirSync(TAB_SHOTS, { recursive: true });

const CHATS = 'nav[aria-label="Chats"]';

/** The open tab's label, as the bar shows it. */
function openTab(page: Page): Promise<string> {
  return page.$eval(`${CHATS} [data-active] a`, (link) => (link.textContent ?? '').trim());
}

async function openWorkspacePage(newPage: Gallery['newPage'], origin: string, query = ''): Promise<Page> {
  const page = await newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${origin}/gallery.html?frame=workspacepage${query}`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector(`${CHATS} [data-agent-tab="main"]`);

  return page;
}

/** + then the first message: what a person does to open a chat. */
async function startChat(page: Page, opening: string): Promise<void> {
  await page.click(`${CHATS} a[aria-label="New chat"]`);
  await page.waitForSelector('[data-new-chat] textarea');
  await page.type('[data-new-chat] textarea', opening);
  await page.click('[data-new-chat] button[type="submit"]');
}

async function waitForNewChatOpen(page: Page): Promise<void> {
  await page.waitForFunction((chats) => {
    const open = document.querySelector(`${chats} [data-active]`);

    return open !== null && open.getAttribute('data-agent-tab') !== 'main' && open.getAttribute('data-title') === null;
  }, {}, CHATS);
}

describe('a chat in the workspace, as an ordinary conversation', () => {
  /** Kept equal to the gallery's two-frame refusal, so a chain it stopped chaining fails the equality. */
  const CREATE_REFUSAL_CHAIN = 'the workspace refused the new agent: subordinate quota exhausted';

  test('+ asks the workspace question; the first message opens the chat as the current tab and is sent once', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openWorkspacePage(newPage, origin);
      const sends = () => page.evaluate(() => Number(document.documentElement.dataset.galleryChatSends ?? '0'));
      const before = await sends();

      await page.click(`${CHATS} a[aria-label="New chat"]`);
      await page.waitForSelector('[data-new-chat]');
      expect(await page.$eval('[data-new-chat] h1', (heading) => heading.textContent ?? '')).toContain('What do you want to work on in ');

      await page.type('[data-new-chat] textarea', 'Audit the coupon rules');
      await page.click('[data-new-chat] button[type="submit"]');
      await waitForNewChatOpen(page);
      await page.waitForSelector('[data-agent-pane^="checkout-fixes/agents/"] textarea');
      await page.waitForFunction((from) => Number(document.documentElement.dataset.galleryChatSends ?? '0') === from + 1, {}, before);

      // The opening is spent: leaving the chat and coming back sends nothing again.
      await page.click(`${CHATS} [data-agent-tab="main"] a`);
      await page.waitForSelector('[data-agent-pane="checkout-fixes/main"] textarea');
      await page.click(`${CHATS} [data-agent-tab]:not([data-agent-tab="main"]) a`);
      await page.waitForSelector('[data-agent-pane^="checkout-fixes/agents/"] textarea');
      expect(await sends()).toBe(before + 1);
      await page.close();
    });
  });

  test('a refused create says why where it was asked, and the next try lands', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openWorkspacePage(newPage, origin, '&createFails=1');

      await startChat(page, 'Audit the coupon rules');
      await page.waitForFunction((chain) => (document.querySelector('[data-new-chat]')?.textContent ?? '').includes(chain), {}, CREATE_REFUSAL_CHAIN);
      // The draft survives the refusal, so the retry is one click.
      expect(await page.$eval('[data-new-chat] textarea', (field) => field.value)).toBe('Audit the coupon rules');

      await page.click('[data-new-chat] button[type="submit"]');
      await waitForNewChatOpen(page);
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(CREATE_REFUSAL_CHAIN);
      await page.close();
    });
  });

  test('a chat renames in its tab and deletes after a confirmation; Main renames and never deletes', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openWorkspacePage(newPage, origin);
      expect(await page.$(`${CHATS} [data-agent-tab="main"] button[aria-label="Delete Main"]`)).toBeNull();
      expect(await page.$(`${CHATS} [data-agent-tab="main"] button[aria-label="Rename Main"]`)).not.toBeNull();

      await startChat(page, 'Audit the coupon rules');
      await waitForNewChatOpen(page);
      const open = `${CHATS} [data-active]`;

      await page.hover(`${open} a`);
      await page.click(`${open} button[aria-label^="Rename "]`);
      await page.waitForSelector(`${open} input[aria-label="Chat name"]`);
      await page.type(`${open} input[aria-label="Chat name"]`, 'Payments triage');
      await page.keyboard.press('Enter');
      await page.waitForFunction((chats) => (document.querySelector(`${chats} [data-active] a`)?.textContent ?? '').includes('Payments triage'), {}, CHATS);

      // Cancel decides nothing; Delete removes the tab and returns to Main.
      await page.hover(`${open} a`);
      await page.click(`${open} button[aria-label="Delete Payments triage"]`);
      await page.waitForSelector('[role="dialog"]');
      await clickDialogButton(page, 'Cancel');
      expect(await openTab(page)).toBe('Payments triage');

      await page.hover(`${open} a`);
      await page.click(`${open} button[aria-label="Delete Payments triage"]`);
      await page.waitForSelector('[role="dialog"]');
      await clickDialogButton(page, 'Delete');
      await page.waitForFunction((chats) => document.querySelector(`${chats} [data-active]`)?.getAttribute('data-agent-tab') === 'main', {}, CHATS);
      expect(await page.evaluate((chats) => document.querySelector(chats)?.textContent ?? '', CHATS)).not.toContain('Payments triage');
      await page.close();
    });
  });

  test('Main takes a title of its own, which its tab shows', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openWorkspacePage(newPage, origin);
      const main = `${CHATS} [data-agent-tab="main"]`;

      await page.hover(`${main} a`);
      await page.click(`${main} button[aria-label="Rename Main"]`);
      await page.waitForSelector(`${main} input[aria-label="Chat name"]`);
      await page.type(`${main} input[aria-label="Chat name"]`, 'Release plan');
      await page.keyboard.press('Enter');
      await page.waitForFunction((tab) => (document.querySelector(`${tab} a`)?.textContent ?? '') === 'Release plan', {}, main);
      await page.close();
    });
  });

  test('an agent pane\'s picker shows the actor\'s effective model and writes the actor\'s own pin', async () => {
    // The pane's picker once wrote to the ROOT's `setModel`, so a pick there repinned the whole workspace. A pick or
    // a thinking level is written to THIS actor, never the workspace.
    await withGallery(async ({ newPage, origin }) => {
      const page = await openWorkspacePage(newPage, origin);
      await startChat(page, 'Audit the coupon rules');
      await waitForNewChatOpen(page);
      await page.waitForFunction(() => {
        const picker = document.querySelector('[data-agent-pane] [data-model-picker="Model"]');
        const trigger = picker?.closest('button');

        return picker?.textContent?.includes('Claude Opus 4') === true && trigger instanceof HTMLButtonElement && !trigger.disabled;
      });

      // A real pointer press: the option commits on the pointer, not on a synthetic click().
      await page.click('[data-agent-pane] [aria-label="Thinking level"]');
      await page.waitForSelector('[role="option"]');
      let pickedHigh = false;

      for (const option of await page.$$('[role="option"]')) {
        if (((await option.evaluate((el) => el.textContent)) ?? '').trim() === 'High') {
          await option.click();
          pickedHigh = true;
          break;
        }
      }

      if (!pickedHigh) throw new Error('High absent in the thinking-level popup');

      await page.waitForFunction(() => (document.documentElement.dataset.galleryModelCalls ?? '').includes('setReasoningEffort'));
      const calls = await page.evaluate(() => JSON.parse(document.documentElement.dataset.galleryModelCalls ?? '[]'));
      expect(calls).toEqual([{ method: 'setReasoningEffort', args: ['high', 'agent-1'] }]);
      await page.close();
    });
  });

  test('the overview shows what GitHub last said of the workspace\'s repositories and the work its agents touched', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspaceshell&agents=panel`, { waitUntil: 'networkidle0' });
      await page.click('.p-bar-tab[data-title] .p-bar-link');
      await page.waitForSelector('[data-overview-github] [data-github-item]');

      const shown = await page.evaluate(() => ({
        repos: [...document.querySelectorAll('[data-github-repo]')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim()),
        items: [...document.querySelectorAll('[data-github-item]')].map((row) => [row.getAttribute('data-github-item'), row.querySelector('a')?.getAttribute('href'), row.textContent?.includes('an agent') ?? false]),
        checked: document.querySelector('[data-github-checked]')?.getAttribute('data-github-checked'),
        reads: document.documentElement.dataset.galleryGitHubReads,
      }));

      expect(shown.repos[0]).toContain('fix/coupon-guard');
      expect(shown.repos[0]).toContain('failing');
      expect(shown.items).toEqual([
        ['acme/storefront#482', 'https://github.com/acme/storefront/pull/482', false],
        ['acme/storefront#477', 'https://github.com/acme/storefront/issues/477', true],
        ['acme/storefront-docs#61', 'https://github.com/acme/storefront-docs/pull/61', false],
      ]);
      expect(shown.checked).toBe('refreshed');
      // Opening the overview asks GitHub once, first; any later read takes the record as it stands.
      expect(shown.reads).toMatch(/^Rr*$/);
      await page.close();
    });
  });

  test('a file attached in the new-chat box goes out with the opening message', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openWorkspacePage(newPage, origin);

      await page.click(`${CHATS} a[aria-label="New chat"]`);
      await page.waitForSelector('[data-new-chat] textarea');
      await page.$eval('[data-new-chat] form', (form) => {
        const files = new DataTransfer();
        files.items.add(new File(['sku,qty\nSAVE20,1\n'], 'cart.csv', { type: 'text/csv' }));
        form.dispatchEvent(new DragEvent('dragover', { dataTransfer: files, bubbles: true, cancelable: true }));
        form.dispatchEvent(new DragEvent('drop', { dataTransfer: files, bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() => (document.querySelector('[data-new-chat] [data-attachments]')?.textContent ?? '').includes('cart.csv'));
      await page.type('[data-new-chat] textarea', 'Why does this cart 500?');
      await page.click('[data-new-chat] button[type="submit"]');
      await waitForNewChatOpen(page);
      await page.waitForFunction(() => document.documentElement.dataset.galleryChatSent !== undefined);

      expect(JSON.parse(await page.evaluate(() => document.documentElement.dataset.galleryChatSent ?? '[]'))).toEqual(['file:cart.csv', 'text:Why does this cart 500?']);
      await page.close();
    });
  });

  test('a task card opens the agent that owns it, a swarm worker\'s included', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspaceshell&agents=panel`, { waitUntil: 'networkidle0' });
      await page.click(`${CHATS} [data-title] a`);
      await page.waitForSelector('[data-workspace-overview] [data-task-card]');

      await page.evaluate(() => {
        const card = [...document.querySelectorAll('[data-task-card]')].find((node) => (node.textContent ?? '').includes('Serialize gift-card lines'));

        if (!(card instanceof HTMLElement)) throw new Error('no swarm-owned task card');
        card.click();
      });
      await page.waitForSelector('[data-view-only]');
      await page.close();
    });
  });

  // 2026-10-05, production: a tab left on a deleted workspace asked for it every ~7 s, forever, and each answer was a 404.
  test('a workspace the registry no longer holds says so once, links home, and stops asking', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&gone=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-workspace-gone] a[href="/"]');

      // Nothing is left that would ask again: the page, its reads and its socket are gone.
      expect(await page.$('[data-composer-root]')).toBeNull();
      expect(await page.evaluate(() => document.documentElement.dataset.galleryAgentsOpen)).toBe('0');
      await page.close();
    });
  });

  test('on a phone, a workspace that cannot connect still offers the menu', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await page.goto(`${origin}/gallery.html?frame=workspaceshell&terminal=denied`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.p-bar-menu button');
      await page.tap('.p-bar-menu button');
      await page.waitForSelector('[data-drawer]');
      await page.close();
    });
  });

  test('each conversation keeps its own draft across tab switches', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openWorkspacePage(newPage, origin);
      await page.type('[data-agent-pane="checkout-fixes/main"] textarea', 'main draft');
      await startChat(page, 'Audit the coupon rules');
      await waitForNewChatOpen(page);
      await page.waitForSelector('[data-agent-pane^="checkout-fixes/agents/"] textarea');
      expect(await page.$eval('[data-agent-pane] textarea', (field) => field.value)).toBe('');

      await page.click(`${CHATS} [data-agent-tab="main"] a`);
      await page.waitForSelector('[data-agent-pane="checkout-fixes/main"]');
      expect(await page.$eval('[data-agent-pane] textarea', (field) => field.value)).toBe('main draft');
      await page.close();
    });
  });
});

/** Presses a dialog's button by its words. */
async function clickDialogButton(page: Page, words: string): Promise<void> {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((node) => (node.textContent ?? '').trim() === label);

    if (!(button instanceof HTMLButtonElement)) throw new Error(`${label} absent in the dialog`);
    button.click();
  }, words);
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
}


/** One tab of the bar, as painted: its text colour and its box. */
interface TabPaint {
  readonly key: string;
  readonly current: boolean;
  /** The workspace's own name, always in full ink: it is not a chat tab. */
  readonly title: boolean;
  readonly color: string;
  readonly left: number;
  readonly right: number;
}

/** The bar's tabs and the open tab's outline, once their colour transitions have ended. */
function barPaint(page: Page, strip: string): Promise<{ tabs: TabPaint[]; outline: { left: number; right: number } | null }> {
  return page.$eval(`[data-tab-strip="${strip}"] .p-bar`, async (bar) => {
    await Promise.allSettled([...bar.querySelectorAll('.p-bar-link')].flatMap((link) => link.getAnimations().map((animation) => animation.finished)));
    const body = bar.querySelector('.p-bar-outline [data-part="body"]')?.getBoundingClientRect();

    return {
      tabs: [...bar.querySelectorAll('.p-bar-tab')].flatMap((tab) => {
        const link = tab.querySelector('.p-bar-link');

        if (link === null) return [];
        const box = tab.getBoundingClientRect();

        return [{
          key: tab.getAttribute('data-key') ?? '', current: link.getAttribute('aria-current') === 'page', title: tab.hasAttribute('data-title'),
          color: getComputedStyle(link).color, left: box.left, right: box.right,
        }];
      }),
      outline: body === undefined ? null : { left: body.left, right: body.right },
    };
  });
}

/**
 * The open chat tab, as a reader finds it: the complaint was a strip where nothing said which tab the conversation
 * below belonged to. The open tab is the one the hairline rises around, and its words are inked apart from the closed
 * tabs beside it, in both themes. A closed tab under the pointer brightens and never takes the open tab's ink.
 */
describe('the open tab, as the browser paints it', () => {
  for (const open of ['main', 'actor-docs', 'overview']) {
    test(`the ${open} tab reads as the open one, dark and light`, async () => {
      await withGallery(async ({ newPage, origin }) => {
        for (const theme of ['dark', 'light'] as const) {
          const page = await newPage();
          await page.setViewport({ width: 900, height: 700 });
          await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
          await page.goto(`${origin}/gallery.html?frame=tabs`, { waitUntil: 'networkidle0' });
          await page.waitForSelector(`[data-tab-strip="${open}"] .p-bar-outline [data-part="body"]`);

          const paint = await barPaint(page, open);
          const current = paint.tabs.filter((tab) => tab.current);
          const closed = paint.tabs.filter((tab) => !tab.current && !tab.title);

          expect(current.map((tab) => tab.key)).toEqual([open]);
          expect(closed.length).toBeGreaterThan(0);

          for (const other of closed) expect(current[0]?.color).not.toBe(other.color);

          // The outline's body sits inside the open tab, inset by its flares.
          expect(paint.outline?.left).toBeGreaterThan((current[0]?.left ?? 0) - 1);
          expect(paint.outline?.right).toBeLessThan((current[0]?.right ?? 0) + 1);

          await page.screenshot({ path: join(TAB_SHOTS, `bar-${open}-${theme}.png`), fullPage: true });
          await page.close();
        }
      });
    });
  }

  test('a closed tab under the pointer brightens, never to the open tab\'s ink', async () => {
    await withGallery(async ({ newPage, origin }) => {
      for (const theme of ['dark', 'light'] as const) {
        const page = await newPage();
        await page.setViewport({ width: 900, height: 700 });
        await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
        await page.goto(`${origin}/gallery.html?frame=tabs`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-tab-strip="main"] .p-bar-outline');
        const rest = await barPaint(page, 'main');
        const open = rest.tabs.find((tab) => tab.current);
        const closed = 'actor-docs';

        await page.hover(`[data-tab-strip="main"] [data-key="${closed}"] .p-bar-link`);
        const hovered = (await barPaint(page, 'main')).tabs.find((tab) => tab.key === closed);

        expect(hovered?.color).not.toBe(rest.tabs.find((tab) => tab.key === closed)?.color);
        expect(hovered?.color).not.toBe(open?.color);
        await page.close();
      }
    });
  });
});

/**
 * Status a reader takes in at a glance: a working chat's name carries a moving light, one that needs the person
 * has a red light breathing up from under its tab (no outline: the owner's pick, 2026-10-06), a failed one holds a
 * still red mark. With reduced motion asked for, nothing moves.
 */
describe('a chat\'s status, as the bar paints it', () => {
  const motion = (page: Page) => page.$$eval('[data-tab-strip="main"] .p-bar-tab[data-status]', (tabs) => Object.fromEntries(tabs.map((tab) => [
    tab.getAttribute('data-status') ?? '',
    {
      label: getComputedStyle(tab.querySelector('.p-status-label') ?? tab).animationName,
      // The light under the tab: its own layer, never an outline around the tab.
      glow: getComputedStyle(tab.querySelector('.p-bar-link') ?? tab, '::before').animationName,
      outline: getComputedStyle(tab, '::after').boxShadow,
      mark: tab.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null,
    },
  ])));

  test('working shimmers, needing you glows, failed holds still; reduced motion stops both', async () => {
    await withGallery(async ({ newPage, origin }) => {
      for (const reduce of [false, true]) {
        const page = await newPage();
        await page.setViewport({ width: 900, height: 700 });
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }]);
        await page.goto(`${origin}/gallery.html?frame=tabs`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-tab-strip="main"] .p-bar-tab[data-status="waiting"]');

        const seen = await motion(page);

        expect(seen.working).toEqual({ label: reduce ? 'none' : 'p-shimmer', glow: 'none', outline: 'none', mark: 'Working' });
        expect(seen.waiting).toEqual({ label: 'none', glow: reduce ? 'none' : 'p-attention', outline: 'none', mark: 'Needs you' });
        expect(seen.failed).toEqual({ label: 'none', glow: 'none', outline: 'none', mark: 'Last turn failed' });
        await page.close();
      }
    });
  });
});
