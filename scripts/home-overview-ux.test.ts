/**
 * The home page's recent workspaces, in a real browser: one 56px line per
 * workspace — title, the last task when it says something the title does
 * not, one status chip, the relative time.
 *
 * What only a browser can say about this line: whether "Needs you" outranks a
 * run in flight, whether a failed refresh keeps the last answer AND says it is
 * stale, whether a card with no answer renders "unavailable" beside a retry
 * that actually reloads, whether the page asks only for the five names it
 * shows, and whether a long task truncates instead of widening the line.
 * Every one of those is markup plus a live fetch — a unit test reads neither.
 *
 * The fixture is the gallery's own: `?frame=home` mounts the real HomePage
 * inside the real WorkspaceRosterProvider, and `gallery:overview` events drive
 * each card's answer between load and poll, so what a card does with a stale
 * or refused read is the production component's behavior, photographed.
 * Screenshots land in ~/kinu-logs/home-status/ and ~/kinu-logs/home-cards/
 * (outside the worktree).
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
async function waitForRequests(page: Page, name: string, count: number): Promise<void> {
  await page.waitForFunction(
    (wanted, needed) => {
      const asked = (document.documentElement.dataset.galleryOverviewRequests ?? '').split(' ')
        .filter((entry) => entry === wanted);

      return asked.length >= needed;
    },
    {},
    name, count,
  );
}

/** A line as a reader sees it: the title, the task beneath it (null when
 *  the line shows none), the one chip's text and classes, whether the line
 *  says its answer is old, and whether a retry button sits beside the link. */
interface CardView {
  title: string;
  task: string | null;
  chip: string;
  chipClass: string;
  stale: boolean;
  retry: boolean;
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
        stale: (row.textContent ?? '').includes('checked '),
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
  const page = await gallery.newPage();

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
          'Design system v2', 'Untitled workspace',
        ]);

        // One chip per line, the shared headline: a waiting decision outranks
        // the live turn beside it, and its count rides the label.
        const coupon = cardNamed(list, 'Checkout coupon bug');
        expect(coupon.chip).toBe('Needs you · 2');
        expect(coupon.chipClass).toContain('p-accent');
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

        // Every displayed name — and nothing else — was asked.
        expect((await uniqueRequested(page)).sort()).toEqual([...DISPLAYED].sort());
        // Nothing on a healthy line claims its answer is old.
        expect(list.every((card) => !card.stale && !card.retry)).toBe(true);
      } finally {
        await page.close();
      }
    });
  });

  test('a failed refresh keeps the last answer, marks it stale, and retries', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&overviewErrors=design-sys');

      try {
        for (const name of DISPLAYED) await waitForRequests(page, name, 1);

        let list = await cards(page);
        // Seeded failure: this card never held a good answer.
        expect(cardNamed(list, 'Design system v2').chip).toBe('unavailable');
        expect(cardNamed(list, 'Design system v2').retry).toBe(true);

        // The other four are healthy — a per-card failure, not a page one.
        expect(cardNamed(list, 'Email triage automation').chip).toBe('Updated');

        // Break a healthy card mid-session: the next poll turns its last good
        // answer stale rather than erasing it.
        await setOutcome(page, 'email-triage', { kind: 'status', status: 503 });
        await page.waitForFunction(
          () => [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .some((row) => (row.textContent ?? '').includes('checked ')),
        );

        list = await cards(page);
        const stale = cardNamed(list, 'Email triage automation');

        expect(stale.stale).toBe(true);
        expect(stale.chip).toBe('Updated');
        expect(stale.chipClass).toContain('p-text-4');
        expect(stale.retry).toBe(true);

        // The in-row retry reloads without navigating — arm a good answer
        // first so the retry's request is the recovery, not a second failure.
        const before = (await requestedNames(page)).filter((n) => n === 'email-triage').length;

        await setOutcome(page, 'email-triage', { kind: 'body', body: {
          observedAt: Date.now(), activity: 'idle', decisionsWaiting: 0, hasUpdates: false,
          latestRun: { status: 'completed', task: 'Sort this week\'s receipts into the ledger' }, primarySlate: null,
        } });

        await page.evaluate(() => {
          const row = [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .find((node) => (node.textContent ?? '').includes('checked '));

          const retry = [...(row?.parentElement?.querySelectorAll('button') ?? [])]
            .find((node) => (node.textContent ?? '').trim() === 'retry');

          retry?.click();
        });

        await waitForRequests(page, 'email-triage', before + 1);
        await page.waitForFunction(
          () => ![...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .some((row) => (row.textContent ?? '').includes('checked ')),
        );

        list = await cards(page);
        expect(cardNamed(list, 'Email triage automation').stale).toBe(false);
        expect(cardNamed(list, 'Email triage automation').retry).toBe(false);
        expect(page.url()).toContain('gallery.html');
      } finally {
        await page.close();
      }
    });
  });

  test('only the displayed names are fetched, and the sixth row never mounts', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&overflowRoster=1');

      try {
        for (const name of DISPLAYED) await waitForRequests(page, name, 1);
        // Let one full revalidation tick pass: the only way a request for the
        // hidden sixth name could hide is inside the second wave.
        await page.waitForFunction(
          () => (document.documentElement.dataset.galleryOverviewRequests ?? '').split(' ').length >= 10,
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
  });

  test('a narrow viewport keeps the degraded line whole — chip, task and retry visible, nothing sideways', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '');
      await page.setViewport({ width: 390, height: 844 });

      try {
        for (const name of DISPLAYED) await waitForRequests(page, name, 1);

        // Degrade the line that carries the most: a sealed run, unread
        // updates, a task beneath the title, and a refresh failure on top.
        await setOutcome(page, 'email-triage', { kind: 'status', status: 503 });
        await page.waitForFunction(
          () => [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')]
            .some((row) => (row.parentElement?.querySelector('button')?.textContent ?? '').trim() === 'retry'),
        );

        const list = await cards(page);
        const card = cardNamed(list, 'Email triage automation');

        expect(card.chip).toBe('Updated');
        expect(card.task).toBe("Sort this week's receipts into the ledger");
        expect(card.retry).toBe(true);

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
        await page.screenshot({ path: join(SHOTS, 'mobile-dark-degraded.png'), fullPage: true });
      } finally {
        await page.close();
      }
    });
  });

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
        const page = await gallery.newPage();
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
  });
});

describe('the home page is the new-workspace form', () => {
  test('the create action carries the primary fill and the content centres on desktop', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();
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
            eyebrow: grid?.querySelector('.p-eyebrow')?.textContent ?? null,
            heading: grid?.querySelector('h1')?.textContent ?? null,
          };
        });

        // The page's one primary action is brass even before a mission is
        // typed: `create` refuses an empty mission itself, so the disabled
        // chip was only hiding the colour the owner asked for.
        expect(fact.primaryClass).toBe(true);
        expect(fact.enabledEmpty).toBe(true);
        // md+ content-centres the tracks; the rail is up at 1280px.
        expect(fact.alignContent).toBe('center');
        // The sidebar does not offer the form the page already is — and the
        // page itself stopped restating it as an eyebrow. The H1 and the
        // primary action are the label now.
        expect(fact.sidebarButton).toBe(false);
        expect(fact.eyebrow).not.toBe('New workspace');
        expect(fact.heading).toBe('What do you wanna work on?');
      } finally {
        await page.close();
      }
    });
  });

  test('mobile keeps the top flow', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();
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
  });
});
