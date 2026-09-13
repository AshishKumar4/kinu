/**
 * The home workspace cards, in a real browser.
 *
 * What only a browser can say about this row: whether "Needs you" outranks a
 * run in flight, whether a failed refresh keeps the last answer AND says it is
 * stale, whether a card with no answer renders "unavailable" beside a retry
 * that actually reloads, whether the page asks only for the five names it
 * shows, and whether a long task title truncates instead of widening the row.
 * Every one of those is markup plus a live fetch — a unit test reads neither.
 *
 * The fixture is the gallery's own: `?frame=home` mounts the real HomePage
 * inside the real WorkspaceRosterProvider, and `gallery:overview` events drive
 * each card's answer between load and poll, so what a card does with a stale
 * or refused read is the production component's behavior, photographed.
 *
 * Screenshots land in ~/kinu-logs/home-status/ (outside the worktree).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';
import type { JsonValue } from '@kinu.run/core';

import { withGallery, type Gallery } from './gallery-harness';

const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'home-status');

mkdirSync(SHOTS, { recursive: true });

/** The five names the stock gallery roster displays, in card order. */
const DISPLAYED = ['checkout-fixes', 'perf-audit', 'email-triage', 'design-sys', 'handwrought-walnut-4166c321'];

/** Names the page asked an overview for, as the fixture recorded them. */
async function requestedNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (document.documentElement.dataset.galleryOverviewRequests ?? '').split(' ').filter((name) => name !== ''),
  );
}

/** Unique names the page has asked so far. */
async function uniqueRequested(page: Page): Promise<string[]> {
  return [...new Set(await requestedNames(page))];
}

/** Wait for the page's own request log to name `name` at least `count` times. */
async function waitForRequests(page: Page, name: string, count: number, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(
    (wanted, needed) => {
      const asked = (document.documentElement.dataset.galleryOverviewRequests ?? '').split(' ')
        .filter((entry) => entry === wanted);

      return asked.length >= needed;
    },
    { timeout: timeoutMs },
    name, count,
  );
}

/** The card rows as a reader sees them: [display text, status text, extra]. */
interface CardView {
  title: string;
  /** Everything the right-hand status cluster says. */
  status: string;
  retry: boolean;
  task: string | null;
}

async function cards(page: Page): Promise<CardView[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')].map((row) => {
      const [nameEl] = [...row.children];

      const statusEl = row.querySelector('[role="status"]');

      const taskEl = [...row.children].find(
        (el) => el !== nameEl && el !== statusEl,
      );

      return {
        title: nameEl?.textContent ?? '',
        task: taskEl?.textContent ?? null,
        status: statusEl?.textContent ?? '',
        // The retry is a sibling of the link, not a child of it.
        retry: row.parentElement?.querySelector('button')?.textContent?.trim() === 'retry',
      };
    }),
  );
}

function cardNamed(list: CardView[], name: string): CardView {
  const found = list.find((card) => card.title === name);

  if (!found) throw new Error(`no card titled ${name}: ${JSON.stringify(list)}`);

  return found;
}

/** One card's next answer, in the tagged shape the fixture's event expects. */
type Outcome = { kind: 'status'; status: number } | { kind: 'body'; body: JsonValue };

/** Flip one card's next answer. */
async function setOutcome(page: Page, name: string, outcome: Outcome): Promise<void> {
  await page.evaluate((target, value) => {
    window.dispatchEvent(new CustomEvent('gallery:overview', { detail: { name: target, outcome: value } }));
  }, name, outcome);
}

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light' | null = 'dark'): Promise<Page> {
  const page = await gallery.browser.newPage();

  if (theme !== null) {
    await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  }

  await page.goto(`${gallery.origin}/gallery.html?frame=home${query}`, { waitUntil: 'networkidle0' });

  return page;
}

describe('the home workspace cards', () => {
  test('the five states render as labels a reader can act on', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '');

      try {
        // StrictMode double-mounts: wait until every displayed name has been
        // asked at least once, not for a fixed request count.
        for (const name of DISPLAYED) await waitForRequests(page, name, 1);

        const list = await cards(page);

        // Roster order, untouched by the async answers: no card moved under a
        // pointer while its summary arrived.
        expect(list.map((card) => card.title)).toEqual([
          'Checkout coupon bug', 'Perf audit — landing', 'Email triage automation',
          'Design system v2', 'handwrought-walnut-4166c321',
        ]);

        expect(cardNamed(list, 'Checkout coupon bug').status).toContain('Needs you · 2');
        expect(cardNamed(list, 'Checkout coupon bug').status).toContain('updates');
        expect(cardNamed(list, 'Checkout coupon bug').task).toContain('checkout failures');

        expect(cardNamed(list, 'Perf audit — landing').status).toContain('Working');
        expect(cardNamed(list, 'Perf audit — landing').status).not.toContain('updates');

        expect(cardNamed(list, 'Email triage automation').status).toContain('Last run completed');
        expect(cardNamed(list, 'Email triage automation').status).toContain('updates');

        // Durable leftovers read as unfinished work, not a live run.
        expect(cardNamed(list, 'Design system v2').status).toContain('Work remains');
        expect(cardNamed(list, 'handwrought-walnut-4166c321').status).toContain('No active work');

        // Every displayed name — and nothing else — was asked.
        expect((await uniqueRequested(page)).sort()).toEqual([...DISPLAYED].sort());
        // lastVisited is labelled as what it is, never implied activity.
        expect(cardNamed(list, 'Checkout coupon bug').status).toContain('Opened');
        expect(cardNamed(list, 'Checkout coupon bug').status).not.toContain('last activity');
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('a failed refresh keeps the last answer, marks it stale, and retries', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&overviewErrors=design-sys');

      try {
        for (const name of DISPLAYED) await waitForRequests(page, name, 1);

        let list = await cards(page);
        // Seeded failure: this card never held a good answer.
        expect(cardNamed(list, 'Design system v2').status).toContain('unavailable');
        expect(cardNamed(list, 'Design system v2').retry).toBe(true);

        // The other four are healthy — a per-card failure, not a page one.
        expect(cardNamed(list, 'Email triage automation').status).toContain('Last run completed');

        // Break a healthy card mid-session: the next poll turns its last good
        // answer stale rather than erasing it.
        await setOutcome(page, 'email-triage', { kind: 'status', status: 503 });
        await page.waitForFunction(
          () => [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .some((row) => (row.textContent ?? '').includes('Last checked')),
          { timeout: 20_000 },
        );

        list = await cards(page);
        const stale = cardNamed(list, 'Email triage automation');

        expect(stale.status).toContain('Last checked');
        expect(stale.status).toContain('Last run completed');
        expect(stale.retry).toBe(true);

        // The in-row retry reloads without navigating — arm a good answer
        // first so the retry's request is the recovery, not a second failure.
        const before = (await requestedNames(page)).filter((n) => n === 'email-triage').length;

        await setOutcome(page, 'email-triage', { kind: 'body', body: {
          observedAt: Date.now(), activity: 'idle', decisionsWaiting: 0, hasUpdates: false,
          latestRun: { status: 'completed', task: 'Sort this week\'s receipts into the ledger' },
        } });

        await page.evaluate(() => {
          const row = [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .find((node) => (node.textContent ?? '').includes('Last checked'));

          const retry = [...(row?.parentElement?.querySelectorAll('button') ?? [])]
            .find((node) => (node.textContent ?? '').trim() === 'retry');

          retry?.click();
        });

        await waitForRequests(page, 'email-triage', before + 1);
        await page.waitForFunction(
          () => ![...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .some((row) => (row.textContent ?? '').includes('Last checked')),
          { timeout: 20_000 },
        );

        list = await cards(page);
        expect(cardNamed(list, 'Email triage automation').status).not.toContain('Last checked');
        expect(page.url()).toContain('gallery.html');
      } finally {
        await page.close();
      }
    });
  }, 90_000);

  test('only the displayed names are fetched, and the sixth row never mounts', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&overflowRoster=1');

      try {
        for (const name of DISPLAYED) await waitForRequests(page, name, 1);
        // Let one full revalidation tick pass: the only way a request for the
        // hidden sixth name could hide is inside the second wave.
        await page.waitForFunction(
          () => (document.documentElement.dataset.galleryOverviewRequests ?? '').split(' ').length >= 10,
          { timeout: 20_000 },
        );

        const asked = await uniqueRequested(page);

        expect(asked.sort()).toEqual([...DISPLAYED].sort());
        expect(asked).not.toContain('sixth-unseen');

        const titles = (await cards(page)).map((card) => card.title);

        expect(titles).toHaveLength(5);
        expect(titles).not.toContain('A sixth workspace');
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('a narrow viewport wraps the degraded card — updates, last-known, retry all visible', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '');
      await page.setViewport({ width: 390, height: 844 });

      try {
        for (const name of DISPLAYED) await waitForRequests(page, name, 1);

        // Degrade the card that carries every kind of metadata at once:
        // a completed run, updates, and a refresh failure on top.
        await setOutcome(page, 'email-triage', { kind: 'status', status: 503 });
        await page.waitForFunction(
          () => [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .some((row) => (row.textContent ?? '').includes('Last checked')),
          { timeout: 20_000 },
        );

        const list = await cards(page);
        const card = cardNamed(list, 'Email triage automation');

        expect(card.status).toContain('updates');
        expect(card.status).toContain('Last run completed');
        expect(card.status).toContain('Last checked');
        expect(card.retry).toBe(true);

        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));

        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
        await page.screenshot({ path: join(SHOTS, 'mobile-dark-degraded.png'), fullPage: true });
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('desktop and mobile photograph the states, dark and light', async () => {
    await withGallery(async (gallery) => {
      const cases: { name: string; width: number; height: number; theme: 'dark' | 'light'; query: string }[] = [
        { name: 'desktop-dark', width: 1280, height: 900, theme: 'dark', query: '' },
        { name: 'desktop-light', width: 1280, height: 900, theme: 'light', query: '' },
        { name: 'mobile-dark', width: 390, height: 844, theme: 'dark', query: '' },
        { name: 'mobile-light', width: 390, height: 844, theme: 'light', query: '' },
        { name: 'desktop-dark-degraded', width: 1280, height: 900, theme: 'dark', query: '&overviewErrors=design-sys,email-triage' },
        { name: 'mobile-light-degraded', width: 390, height: 844, theme: 'light', query: '&overviewErrors=design-sys,email-triage' },
      ];

      for (const entry of cases) {
        const page = await gallery.browser.newPage();
        await page.setViewport({ width: entry.width, height: entry.height });
        await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), entry.theme);
        await page.goto(`${gallery.origin}/gallery.html?frame=home${entry.query}`, { waitUntil: 'networkidle0' });

        try {
          for (const name of DISPLAYED) await waitForRequests(page, name, 1);

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
  }, 120_000);
});

describe('the home page is the new-workspace form', () => {
  test('the create action carries the primary fill and the content centres on desktop', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${gallery.origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });

      try {
        const fact = await page.evaluate(() => {
          const submit = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create workspace');
          // The inner <main> — the app shell wraps the page in its own.
          const grid = document.querySelector('form')?.closest('main') ?? null;

          return {
            primaryClass: submit?.classList.contains('p-btn') ?? false,
            enabledEmpty: submit !== undefined && !submit.disabled,
            alignContent: grid === null ? '' : getComputedStyle(grid).alignContent,
            sidebarButton: [...document.querySelectorAll('aside button')].some((b) => b.textContent === 'New workspace'),
          };
        });

        // The page's one primary action is brass even before a mission is
        // typed: `create` refuses an empty mission itself, so the disabled
        // chip was only hiding the colour the owner asked for.
        expect(fact.primaryClass).toBe(true);
        expect(fact.enabledEmpty).toBe(true);
        // md+ content-centres the tracks; the rail is up at 1280px.
        expect(fact.alignContent).toBe('center');
        // The sidebar does not offer the form the page already is.
        expect(fact.sidebarButton).toBe(false);
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('mobile keeps the top flow', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.browser.newPage();
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`${gallery.origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });

      try {

        const align = await page.evaluate(() => {

          const grid = document.querySelector('form')?.closest('main') ?? null;

          return grid === null ? '' : getComputedStyle(grid).alignContent;
        });

        expect(align).not.toBe('center');
      } finally {
        await page.close();
      }
    });
  }, 60_000);
});
