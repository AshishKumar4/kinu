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

const CARDS_SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'home-cards');

mkdirSync(SHOTS, { recursive: true });

mkdirSync(CARDS_SHOTS, { recursive: true });

/** The five names the stock gallery roster displays, in card order. */
const DISPLAYED = ['checkout-fixes', 'perf-audit', 'email-triage', 'design-sys', 'handwrought-walnut-4166c321'];

/** The evidence roster's task text, spelled the same as gallery.tsx's
 *  EVIDENCE_TASK — the assertion binds the fixture, not a paraphrase. */
const EVIDENCE_TASK =
  'Reconcile the supplier ledger against the bank export for August: match every settlement row to its invoice, flag the three unpriced returns, and post the corrected totals back to the weekly ledger sheet before the payout window closes';

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

/** One rendered evidence item: which fact, what it says, its classes. */
interface EvidenceChip {
  key: string;
  text: string;
  className: string;
}

/** The card rows as a reader sees them: title, the status cluster's whole
 *  text, the evidence items beneath the lead line, and whether a retry
 *  button sits beside the link. */
interface CardView {
  title: string;
  /** Everything the right-hand status cluster says, evidence included. */
  status: string;
  retry: boolean;
  evidence: EvidenceChip[];
}

async function cards(page: Page): Promise<CardView[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Recent workspaces"] a')].map((row) => {
      const [nameEl] = [...row.children];

      const statusEl = row.querySelector('[role="status"]');

      return {
        title: nameEl?.textContent ?? '',
        status: statusEl?.textContent ?? '',
        evidence: [...row.querySelectorAll('[data-evidence]')].map((el) => ({
          key: el.getAttribute('data-evidence') ?? '',
          text: el.textContent ?? '',
          className: el instanceof HTMLElement ? el.className : '',
        })),
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

/** The one evidence item a card shows for `key`. */
function fact(card: CardView, key: string): EvidenceChip {
  const hit = card.evidence.find((item) => item.key === key);

  if (!hit) throw new Error(`card "${card.title}" has no ${key} evidence: ${JSON.stringify(card.evidence)}`);

  return hit;
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

        const coupon = cardNamed(list, 'Checkout coupon bug');
        expect(coupon.status).toContain('Needs you · 2');
        expect(coupon.evidence.map((item) => item.text)).toEqual([
          '2 decisions waiting', 'Working now', 'Updates to read',
          'Last run: error', 'Investigate intermittent checkout failures in the coupon migration',
        ]);

        expect(cardNamed(list, 'Perf audit — landing').status).toContain('Working');
        expect(cardNamed(list, 'Perf audit — landing').evidence.some((item) => item.key === 'updates')).toBe(false);

        const triage = cardNamed(list, 'Email triage automation');
        expect(triage.status).toContain('Last run completed');
        expect(fact(triage, 'updates').text).toBe('Updates to read');
        expect(fact(triage, 'run').text).toBe('Last run: completed');
        expect(fact(triage, 'run').className).toContain('p-success');

        // Durable leftovers read as unfinished work, not a live run.
        expect(cardNamed(list, 'Design system v2').status).toContain('Work remains');
        expect(fact(cardNamed(list, 'Design system v2'), 'unfinished').text).toBe('Unfinished work');

        const quiet = cardNamed(list, 'Untitled workspace');
        expect(quiet.status).toContain('No active work');
        expect(quiet.evidence.map((item) => item.text)).toEqual(['No runs yet']);
        expect(quiet.status).not.toContain('completed');

        // Every displayed name — and nothing else — was asked.
        expect((await uniqueRequested(page)).sort()).toEqual([...DISPLAYED].sort());
        // lastVisited is labelled as what it is, never implied activity.
        expect(cardNamed(list, 'Checkout coupon bug').status).toContain('Opened');
        expect(cardNamed(list, 'Checkout coupon bug').status).not.toContain('last activity');
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
        );

        list = await cards(page);
        expect(cardNamed(list, 'Email triage automation').status).not.toContain('Last checked');
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
        );

        const list = await cards(page);
        const card = cardNamed(list, 'Email triage automation');

        expect(card.status).toContain('Updates to read');
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

  test('the evidence roster lists every fact as a chip, and idle is never a completion', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, '&roster=evidence');

      try {
        for (const name of ['ledger-keeper', 'quiet-desk']) await waitForRequests(page, name, 1);

        const list = await cards(page);

        expect(list.map((card) => card.title)).toEqual(['Ledger reconciliation', 'Quiet desk']);

        const ledger = cardNamed(list, 'Ledger reconciliation');

        // The lead slot still wins the line; the row beneath it is the whole
        // answer, fact by fact, in core's order.
        expect(ledger.status).toContain('Needs you · 2');
        expect(ledger.evidence.map((item) => item.text)).toEqual([
          '2 decisions waiting',
          'Working now',
          'Updates to read',
          'Last run: completed',
          EVIDENCE_TASK,
        ]);
        expect(fact(ledger, 'decisions').className).toContain('p-warning');
        expect(fact(ledger, 'working').className).toContain('p-accent');
        expect(fact(ledger, 'updates').className).toContain('p-text-3');
        expect(fact(ledger, 'run').className).toContain('p-success');
        expect(fact(ledger, 'task').className).toContain('p-text-4');

        const desk = cardNamed(list, 'Quiet desk');

        expect(desk.status).toContain('No active work');
        expect(desk.evidence.map((item) => item.text)).toEqual(['No runs yet']);
        expect(fact(desk, 'empty').className).toContain('p-text-4');
        // Idle is not evidence of completion: the word must not appear on a
        // card that never ran, in either status or evidence.
        expect(desk.status.toLowerCase()).not.toContain('completed');
        expect(desk.status).not.toContain('Last run');
      } finally {
        await page.close();
      }
    });
  });

  test('the evidence roster photographs in dark and light, desktop and mobile', async () => {
    await withGallery(async (gallery) => {
      const cases: { name: string; width: number; height: number; theme: 'dark' | 'light' }[] = [
        { name: 'desktop-dark', width: 1568, height: 829, theme: 'dark' },
        { name: 'desktop-light', width: 1568, height: 829, theme: 'light' },
        { name: 'mobile-dark', width: 390, height: 844, theme: 'dark' },
        { name: 'mobile-light', width: 390, height: 844, theme: 'light' },
      ];

      for (const entry of cases) {
        const page = await gallery.newPage();
        await page.setViewport({ width: entry.width, height: entry.height });
        await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), entry.theme);
        await page.goto(`${gallery.origin}/gallery.html?frame=home&roster=evidence`, { waitUntil: 'networkidle0' });

        try {
          for (const name of ['ledger-keeper', 'quiet-desk']) await waitForRequests(page, name, 1);

          // Chips wrap inside the row; the task always sits on its own second
          // line; nothing may scroll sideways at 390px.
          const layout = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            tops: [...document.querySelectorAll('[data-evidence]')].map((el) =>
              el instanceof HTMLElement ? el.offsetTop : -1),
          }));

          expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
          expect(new Set(layout.tops).size).toBeGreaterThanOrEqual(2);

          await page.screenshot({ path: join(CARDS_SHOTS, `${entry.name}.png`), fullPage: true });
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
