/**
 * The home page's recent workspaces, in a real browser: one 56px line per
 * workspace — title, the last task when it says something the title does
 * not, one status chip, the relative time.
 *
 * What only a browser can say about this line: whether "Needs you" outranks a
 * run in flight, whether the page draws every line from its roster read and
 * asks nothing of any workspace, whether a change the roster socket carries
 * moves a line where it stands, and whether a long task truncates instead of
 * widening the line.
 *
 * The fixture is the gallery's own: `?frame=home` mounts the real HomePage
 * inside the real WorkspaceRosterProvider, the roster read carries each
 * workspace's tile, and `gallery:overview` events send the frames the owner's
 * object would. Screenshots land in ~/kinu-logs/home-status/ (outside the worktree).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Viewport } from 'puppeteer';
import type { JsonValue } from '@kinu.run/core';

import { withGallery, type Gallery } from './gallery-harness';

declare global {
  interface Window {
    /** Every path the gallery page fetched, in order (`galleryFetch` in gallery.tsx). */
    galleryRequests?: string[];
  }
}

const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'home-status');

mkdirSync(SHOTS, { recursive: true });

/** A line as a reader sees it: the title, the task beneath it (null when the line shows none), and the chip. */
interface CardView {
  title: string;
  task: string | null;
  chip: string;
  chipClass: string;
}

async function cards(page: Page): Promise<CardView[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')].map((row) => {
      const [nameEl] = [...row.children];
      const [titleEl, taskEl] = [...(nameEl?.children ?? [])];
      const chip = row.querySelector('[data-overview-chip]');

      return {
        title: titleEl?.textContent ?? '',
        task: taskEl?.textContent ?? null,
        chip: chip?.textContent?.trim() ?? '',
        chipClass: chip instanceof HTMLElement ? chip.className : '',
      };
    }),
  );
}

function cardNamed(list: CardView[], name: string): CardView {
  const found = list.find((card) => card.title === name);

  if (!found) throw new Error(`no card titled ${name}: ${JSON.stringify(list)}`);

  return found;
}

/** One workspace's tile changes, as the owner's object would tell the page. */
async function setOverview(page: Page, name: string, overview: JsonValue): Promise<void> {
  await page.evaluate((target, value) => {
    window.dispatchEvent(new CustomEvent('gallery:overview', { detail: { name: target, overview: value } }));
  }, name, overview);
}

/** Every path the page has fetched so far. */
async function asked(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window.galleryRequests ?? [])]);
}

async function freshPage(gallery: Gallery, theme: 'dark' | 'light', viewport?: Viewport): Promise<Page> {
  const page = await gallery.newPage();

  if (viewport !== undefined) await page.setViewport(viewport);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Recent workspaces"] a').length === 5);

  return page;
}

describe('the home workspace cards', () => {
  test('the five states render from the roster read alone, as labels a reader can act on', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'dark');

      try {
        const list = await cards(page);

        expect(list.map((card) => card.title)).toEqual([
          'Checkout coupon bug', 'Perf audit — landing', 'Email triage automation',
          'Design system v2', 'Untitled workspace',
        ]);

        // One chip per line, the shared headline: a waiting decision outranks
        // the live turn beside it, and its count rides the label.
        const coupon = cardNamed(list, 'Checkout coupon bug');
        expect(coupon.chip).toBe('Needs you · 2');
        expect(coupon.chipClass).toContain('p-warning');
        expect(coupon.task).toBe('Investigate intermittent checkout failures in the coupon migration');

        expect(cardNamed(list, 'Perf audit — landing').chip).toBe('Working');

        // A sealed run with unread updates: the chip says so, and no run word
        // decorates the line.
        const triage = cardNamed(list, 'Email triage automation');
        expect(triage.chip).toBe('Updated');
        expect(triage.task).toBe("Sort this week's receipts into the ledger");

        // A sealed error outranks the durable leftovers beside it; and the
        // task that IS the title (a workspace titled by its first prompt)
        // is not repeated under it.
        const design = cardNamed(list, 'Design system v2');
        expect(design.chip).toBe('Last run failed');
        expect(design.chipClass).toContain('p-danger');
        expect(design.task).toBeNull();

        const quiet = cardNamed(list, 'Untitled workspace');
        expect(quiet.chip).toBe('Idle');
        expect(quiet.task).toBeNull();

        // The roster read is the page's only read of its workspaces: no line asks one.
        const paths = await asked(page);
        expect(paths.filter((path) => path.startsWith('/api/workspaces/'))).toEqual([]);
        expect(paths).toContain('/api/user/workspaces');
      } finally {
        await page.close();
      }
    });
  });

  test('a change the roster socket carries moves its line in place, with no read', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'dark');

      try {
        const readsBefore = (await asked(page)).length;

        await setOverview(page, 'email-triage', {
          activity: 'working', decisionsWaiting: 0, hasUpdates: false,
          latestRun: { status: null, task: "Sort this week's receipts into the ledger" }, slates: [],
        });
        await page.waitForFunction(
          () => [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .some((row) => (row.textContent ?? '').includes('Email triage automation') && (row.textContent ?? '').includes('Working')),
        );

        const list = await cards(page);

        expect(cardNamed(list, 'Email triage automation').chip).toBe('Working');
        // The line kept its place, and the change cost the page no request.
        expect(list.map((card) => card.title)[2]).toBe('Email triage automation');
        expect(await asked(page)).toHaveLength(readsBefore);
      } finally {
        await page.close();
      }
    });
  });

  test('a workspace with no tile reads as not yet reported, never idle', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'dark');

      try {
        await setOverview(page, 'handwrought-walnut-4166c321', null);
        await page.waitForFunction(
          () => [...document.querySelectorAll('section[aria-label="Recent workspaces"] [data-overview-chip]')]
            .some((chip) => chip.textContent?.trim() === 'Not yet reported'),
        );

        expect(cardNamed(await cards(page), 'Untitled workspace').chip).toBe('Not yet reported');
      } finally {
        await page.close();
      }
    });
  });

  test('a narrow viewport keeps the line whole — chip and task visible, nothing sideways', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'dark', { width: 390, height: 844 });

      try {
        const card = cardNamed(await cards(page), 'Email triage automation');

        expect(card.chip).toBe('Updated');
        expect(card.task).toBe("Sort this week's receipts into the ledger");

        // The line's rule at 390px: the title and task keep to one line
        // each, and the visible chip does not push past the line's box.
        const boxes = await page.evaluate(() => {
          const line = [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .find((node) => (node.textContent ?? '').includes('Email triage automation'));

          const chip = line?.querySelector('[data-overview-chip]');

          return {
            line: line?.getBoundingClientRect().height ?? -1,
            chipRight: chip?.getBoundingClientRect().right ?? -1,
            lineRight: line?.getBoundingClientRect().right ?? -1,
          };
        });

        expect(boxes.line).toBeLessThanOrEqual(56);
        expect(boxes.chipRight).toBeLessThanOrEqual(boxes.lineRight);

        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));

        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
      } finally {
        await page.close();
      }
    });
  });

  test('desktop and mobile photograph the states, dark and light', async () => {
    await withGallery(async (gallery) => {
      const cases: { name: string; viewport: Viewport; theme: 'dark' | 'light' }[] = [
        { name: 'desktop-dark', viewport: { width: 1280, height: 900 }, theme: 'dark' },
        { name: 'desktop-light', viewport: { width: 1280, height: 900 }, theme: 'light' },
        { name: 'mobile-dark', viewport: { width: 390, height: 844 }, theme: 'dark' },
        { name: 'mobile-light', viewport: { width: 390, height: 844 }, theme: 'light' },
      ];

      for (const entry of cases) {
        const page = await freshPage(gallery, entry.theme, entry.viewport);

        try {
          // The overflow contract: nothing outside the viewport's width may be
          // asked to scroll sideways to read.
          const overflow = await page.evaluate(() => {
            const doc = document.documentElement;

            return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
          });

          expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
          await page.screenshot({ path: join(SHOTS, `${entry.name}.png`), fullPage: true });
        } finally {
          await page.close();
        }
      }
    });
  });
});
