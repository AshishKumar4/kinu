/**
 * The workspace's shell around the chat, as a browser lays it out: the inspector column, the rails, the Work tab, the
 * model tiers and settings, the home creation form and the sidebar. Each test opens its own gallery frame.
 */
import { describe, expect, test } from 'bun:test';

import type { Page } from 'puppeteer';

import { withGallery } from '../../scripts/gallery-harness';
import { CHATS, PAGES_NAV } from '../../scripts/browser-page';

import { present } from '@kinu.run/test-utils';

/**
 * A STUBBED FIXTURE MUST NOT RENDER A FAILURE STATE.
 *
 * The sidebar footer read "Profile unavailable" in every gallery capture any
 * agent took, while `/api/user/profile` sat in the stub table with a payload.
 * The cause was not the fetch racing the stub — the stub is installed at module
 * scope, before React mounts. The payload simply did not satisfy the schema the
 * CLIENT parses it with: `UserProfileSchema` requires `displayName`, the stub
 * omitted it, valibot threw, and the component's own catch rendered the failure.
 *
 * So the assertion is over the RENDERED state rather than over the table: a
 * table that type-checks and still fails the client's parse is exactly what
 * happened, and only a browser can see the difference.
 */
function panelBoxes(page: Page) {
  return page.$$eval('[data-panel]', (panels) => panels.map((panel) => {
    const box = panel.getBoundingClientRect();

    return { left: box.left, right: box.right, width: Math.round(box.width) };
  }));
}

describe('the gallery shell photographs a healthy neighbour', () => {
  test('the real shell shares identity, width, and one settings action', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1568, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=shell`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('aside');
      await page.waitForFunction(
        () => !(document.querySelector('aside')?.textContent ?? '').includes('loading...'),
      );
      // The account shows in the sidebar's account menu, which opens from its head.
      await page.click('aside [data-account-menu]');
      await page.waitForSelector('aside [data-account-panel]');
      await page.waitForFunction(() => !(document.querySelector('aside [data-account-panel]')?.textContent ?? '').includes('Loading'));

      const shell = await page.evaluate(() => ({
        account: document.querySelector('aside [data-account-panel]')?.textContent ?? '',
        chatShown: (document.querySelector('[data-gallery-chat] > *')?.getBoundingClientRect().width ?? 0) > 0,
        chatWidth: Math.round(document.querySelector('[data-gallery-chat] > *')?.getBoundingClientRect().width ?? 0),
        composerWidth: Math.round(document.querySelector('[data-composer-root] > [data-composer]')?.getBoundingClientRect().width ?? 0),
        headerSettings: document.querySelectorAll('[aria-label="Workspace settings"]').length,
        rosterSettings: document.querySelectorAll('[aria-label^="Workspace settings for"]').length,
      }));

      await page.close();
      expect(shell.account).not.toContain('Could not load your profile');
      expect(shell.account).toContain('@');
      expect(shell.chatShown).toBe(true);
      expect(shell.composerWidth).toBe(shell.chatWidth);
      expect(shell.headerSettings).toBe(1);
      expect(shell.rosterSettings).toBe(0);
    });
  });

  test('mobile gives Chat and Workspace the full viewport in turn', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-composer-root]');

      const chatPanels = await panelBoxes(page);

      await page.click('[data-workspace-bar] button[data-inspector-toggle]');
      await page.waitForFunction(
        () => [...document.querySelectorAll('[data-panel]')].some((panel, index) => (
          index === 1 && Math.round(panel.getBoundingClientRect().width) === 390
        )),
      );

      const workspacePanels = await panelBoxes(page);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      const viewportWidth = await page.evaluate(() => innerWidth);
      await page.close();
      expect(chatPanels[0].width).toBe(viewportWidth);
      expect(chatPanels[1].right).toBe(chatPanels[1].left);
      expect(workspacePanels[0].right).toBe(workspacePanels[0].left);
      expect(workspacePanels[1].width).toBe(viewportWidth);
      expect(overflow).toBe(0);
    });
  });
});

describe('the shell rails collapse and reopen, and the choice survives a reload', () => {
  test('rail and inspector each collapse then reopen by role and state, persisted across reload', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=app&path=/`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('button[aria-label="Hide sidebar"]');

      // The roster column, as opposed to the icon rail it folds to.
      const railVisible = () => page.evaluate(() => {
        const rail = document.querySelector('aside[data-rail]');

        return rail instanceof HTMLElement && rail.offsetParent !== null;
      });

      expect(await railVisible()).toBe(true);
      await page.click('button[aria-label="Hide sidebar"]');
      await page.waitForSelector('button[aria-label="Show sidebar"]');
      expect(await railVisible()).toBe(false);
      expect(await page.evaluate(() => localStorage.getItem('kinu:rail-open'))).toBe('0');
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('button[aria-label="Show sidebar"]');
      expect(await railVisible()).toBe(false);

      await page.click('button[aria-label="Show sidebar"]');
      await page.waitForSelector('button[aria-label="Hide sidebar"]');
      expect(await railVisible()).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem('kinu:rail-open'))).toBe('1');

      // B8's other half, on the panel that carries the defect: a collapsed
      // right panel has to be reopenable, and the control is addressed the way
      // a reader reaches it — a button with that name — over the panel's own
      // measured width, never a test hook.
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector(CHATS);
      await page.waitForSelector('button[aria-label="Hide inspector"]');

      const opened = await page.evaluate(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ));

      expect(await inspectorShown(page)).toBe('open');

      await page.click('button[aria-label="Hide inspector"]');
      await page.waitForFunction(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) === 0);
      // The rail's choice is the rail's: collapsing this panel is not a shell
      // preference, and the two controls are not one.
      expect(await page.evaluate(() => localStorage.getItem('kinu:rail-open'))).toBe('1');
      expect(await page.$('button[aria-label="Hide inspector"]')).toBeNull();

      await page.click('button[aria-label="Show inspector"]');
      await page.waitForSelector('button[aria-label="Hide inspector"]');
      // Reopened at the width it was collapsed from, and the reopen handle is
      // gone because there is nothing left to reopen.
      expect(await page.evaluate(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ))).toBe(opened);
      expect(await page.$('button[aria-label="Show inspector"]')).toBeNull();

      await page.close();
    });
  });
});

/**
 * iOS Safari zooms the page when a text field under 16px takes focus, and leaves it zoomed. On a touch phone every
 * text field, on the pages that carry one, must compute to at least 16px.
 */
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true } as const;

describe('text fields on a touch phone', () => {
  test('every visible text field computes to at least 16px, so iOS does not zoom on focus', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const small: string[] = [];

      for (const frame of ['workspacepage', 'home', 'files', 'usersettingsstate&section=providers']) {
        const page = await newPage();
        await page.setViewport(PHONE);
        await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('input, textarea');
        // The load swaps the renderer, which once took the touch pointer after the page read it (0965, under load). The
        // same viewport again sends touch emulation to the renderer now showing the page, and resolves once applied.
        await page.setViewport({ ...PHONE });

        const measured = await page.$$eval(
          'input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="color"], [type="button"], [type="submit"]), textarea, select',
          (fields) => ({
            coarse: matchMedia('(pointer: coarse)').matches,
            fields: fields.filter((field) => field.checkVisibility()).map((field) => ({
              name: field.getAttribute('aria-label') ?? field.getAttribute('placeholder') ?? field.tagName,
              px: Number.parseFloat(getComputedStyle(field).fontSize),
            })),
          }),
        );

        expect(measured.coarse).toBe(true);
        expect(measured.fields.length).toBeGreaterThan(0);
        small.push(...measured.fields.filter((field) => field.px < 16).map((field) => `${frame}: ${field.name} ${String(field.px)}px`));
        await page.close();
      }

      expect(small).toEqual([]);
    });
  });
});

/**
 * KINU-073. User settings mounts the shipped page and its eight real
 * useAsyncResource branches. Codex fails until the browser heals the fixture;
 * gateways remain unresolved until a separate release. QualityView uses the
 * same held/failing split through its Rpc prop. The assertions run while work
 * is held, not only after final settlement. Blind spot: the sourced 30-second
 * deadline is not slept through here; the explicit failure proves its visible
 * terminal state and the held requests prove siblings do not wait for it.
 *
 * The page is sectioned now, so the walk crosses one: the profile is read on
 * Account and the three connection cards on Providers. That crossing is the
 * second thing this proves — the reads belong to the PAGE, so a section switch
 * neither re-reads a settled card nor releases a held one.
 */
describe('independent settings and quality reads publish independently', () => {
  test('one account card fails and retries while ready and held siblings remain visible', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1200 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate`, { waitUntil: 'networkidle0' });

      // No hash: the first section, and the rail says so.
      expect(await page.$eval(
        '[data-settings-section="account"]',
        (entry) => entry.getAttribute('aria-current'),
      )).toBe('true');
      expect(await page.$eval(
        '[data-settings-resource="your profile"]',
        (resource) => resource.getAttribute('data-resource-state'),
      )).toBe('ready');
      expect(await page.$eval('body', (body) => body.textContent ?? '')).toContain('owner@example.com');
      // Scoped: the connection cards are not on this section at all.
      expect(await page.$('[data-settings-resource="your ChatGPT connection"]')).toBeNull();

      await page.click('[data-settings-section="providers"]');
      await page.waitForSelector('[data-settings-resource="your ChatGPT connection"][data-resource-state="error"]');
      expect(await page.$eval(
        '[data-settings-section="providers"]',
        (entry) => entry.getAttribute('aria-current'),
      )).toBe('true');
      expect(await page.$eval(
        '[data-settings-resource="your AI gateways"]',
        (resource) => resource.getAttribute('data-resource-state'),
      )).toBe('loading');

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:settings-heal')));
      await page.click('[data-settings-resource="your ChatGPT connection"] button');
      await page.waitForSelector(
        '[data-settings-resource="your ChatGPT connection"][data-resource-state="ready"]',
      );
      expect(await page.$eval(
        '[data-settings-resource="your AI gateways"]',
        (resource) => resource.getAttribute('data-resource-state'),
      )).toBe('loading');

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:settings-release')));
      await page.waitForSelector(
        '[data-settings-resource="your AI gateways"][data-resource-state="ready"]',
      );

      // Back on Account, the profile is still ready: the section switch was a
      // render, not a reload.
      await page.click('[data-settings-section="account"]');
      await page.waitForSelector('[data-settings-resource="your profile"][data-resource-state="ready"]');
      await page.close();
    });
  });

  test('a rating landing while the Quality tab is open shows without a reload', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 900, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=qualitylive`, { waitUntil: 'networkidle0' });

      const verdict = () => page.evaluate(() => document.querySelector('[data-quality-live] [data-quality-verdict]')?.textContent ?? '');

      await page.waitForSelector('[data-quality-live] [data-quality-verdict]');
      const before = await verdict();

      await page.click('[data-quality-rate]');
      await page.waitForFunction((was: string) => (document.querySelector('[data-quality-live] [data-quality-verdict]')?.textContent ?? '') !== was, {}, before);
      await page.close();
    });
  });

  test('a failed quality read retries, then shows satisfaction per day', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 900, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=qualityretry`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-quality-retry] button');

      await page.evaluate(() => window.dispatchEvent(new Event('gallery:quality-heal')));
      await page.click('[data-quality-retry] button');
      await page.waitForSelector('[data-quality-retry] [data-quality-verdict]');
      await page.close();
    });
  });
});

test('a long sidebar title stays clipped clear of its row\'s actions', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.setViewport({ width: 1100, height: 1000 });

    try {
      await page.goto(`${origin}/gallery.html?frame=coderendering`, { waitUntil: 'networkidle0' });
      const firstRow = 'aside ul > li:first-child';

      expect(await page.$eval(firstRow + ' a[href^="/workspace/"]', (link) => {
        const title = link.children[1];

        if (title === undefined) throw new Error('workspace title absent');

        return title.scrollWidth > title.clientWidth;
      })).toBeTrue();

      for (const action of ['button[title="Rename"]', 'button[title="Remove"]']) {
        await page.focus(firstRow + ' ' + action);

        const bounds = await page.$eval(firstRow, (row) => {
          const title = row.querySelector('a[href^="/workspace/"]')?.children[1];
          const active = document.activeElement;

          if (title === undefined || active === null) throw new Error('focused row missing');

          return { titleRight: title.getBoundingClientRect().right, actionLeft: active.getBoundingClientRect().left };
        });

        expect(bounds.titleRight).toBeLessThan(bounds.actionLeft);
      }
    } finally {
      await page.close();
    }
  });
});

/** One agent tab, as the browser painted it. */
/**
 * 2026-09-29 (the ci run on 9dd2971ae4): this row hung for 480 s on a waitForSelector the tabs frame always
 * satisfies, and passes alone. A renderer that dies mid-wait was the only way to that shape: puppeteer answers its
 * crash with an `error` event and nothing else, so an unbounded wait on the page never ended. The wait now ends with it.
 */
test('a wait on a page whose renderer crashed ends with the crash, not silence', async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();
    await page.goto(`${origin}/gallery.html?frame=tabs`, { waitUntil: 'networkidle0' });
    const cdp = await page.createCDPSession();
    // Held, not handed to `expect` yet: bun's `.rejects` settles its promise before returning, and nothing has crashed.
    const waiting = page.waitForSelector('[data-tab-strip="never-rendered"]');

    // The session dies with the renderer, so its own answer never comes: the wait's end is what is awaited.
    await Promise.race([cdp.send('Page.crash'), Promise.allSettled([waiting])]);
    await expect(waiting).rejects.toThrow('the page crashed');
  });
});

/** One Work section, as the browser drew it. */
interface WorkSection {
  readonly title: string;
  /** The count beside the heading — the feed's own length, for the journal. */
  readonly badge: string;
  /** Chips the section offers, by their labels. */
  readonly chips: readonly string[];
  /** Retry affordances inside it: one per read that failed. */
  readonly retries: number;
  readonly text: string;
}

/** Every Work section on the page, in the order it was drawn. Only WorkTab
 *  mounts a `<section>` in this column, so the shape of this list IS the
 *  progressive-disclosure rule. */
function workSections(page: Page): Promise<WorkSection[]> {
  return page.$$eval('section', (nodes) => nodes.map((node) => {
    const heading = node.querySelector('[data-section-title]');

    return {
      title: heading?.textContent ?? '',
      badge: node.querySelector('[data-section-badge]')?.textContent ?? '',
      chips: [...node.querySelectorAll('button[aria-pressed]')].map((chip) => chip.textContent?.trim() ?? ''),
      retries: [...node.querySelectorAll('button')].filter((button) => button.textContent?.trim() === 'Retry').length,
      text: node.textContent ?? '',
    };
  }));
}

/** Waits until the Work tab has drawn the section under `title`. */
async function waitForWorkSection(page: Page, title: string): Promise<void> {
  await page.waitForFunction((label: string) => [...document.querySelectorAll('section')]
    .some((node) => node.querySelector('[data-section-title]')?.textContent === label), {}, title);
}

/** Rows the journal is rendering right now: the feed is one group of row
 *  children, so its length is the chip's answer. */
function journalRows(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-journal-row]').length);
}

/**
 * Work is three facets of one question — Needs you, Now, Journal — and a facet
 * with nothing to show is not drawn at all. Only a browser can hold that: every
 * guard reads state that arrives after the effects run, so a static render sees
 * each section in its loading shape and never in the settled one.
 *
 * Three states over the shipped fixtures: nothing in flight, nothing at all,
 * and the plan read refusing. The fourth row is the journal, whose badge has to
 * count the rows it holds.
 */
describe('WorkTab draws a section only when it has something to show', () => {
  test('nothing in flight draws no Now, and the journal under it still draws', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work&lane=settled`, { waitUntil: 'networkidle0' });
      await waitForWorkSection(page, 'Journal');

      expect(await page.$('[data-section="work-now"]')).toBeNull();
      expect(await journalRows(page)).toBeGreaterThan(0);
      await page.close();
    });
  });

  test('a workspace where nothing has happened draws no section, one empty line and no failure', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 720, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workempty`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.body.textContent?.includes('No work yet') === true);

      const column = await page.evaluate(() => ({
        sections: document.querySelectorAll('section').length,
        lines: document.querySelectorAll('p').length,
        retries: [...document.querySelectorAll('button')].filter((node) => node.textContent?.trim() === 'Retry').length,
        // The change-set tab is GATED on there being changes, and the card
        // reports presence for a FAILED read as well — so a tab here is a read
        // that broke, in the one column with nothing to read.
        diffs: document.querySelector('[aria-label="Changes"]') !== null,
      }));

      // One line: the column's own empty card. The change-set draws nothing
      // while nothing has changed, and its gated tab stays away. Nothing
      // failed, so nothing owes a retry. The last two were the other answer
      // while a fixture handed the change-set's record reader an array.
      expect(column).toEqual({ sections: 0, lines: 1, retries: 0, diffs: false });
      await page.close();
    });
  });

  test('a refused read draws its own section with a retry, and Now keeps the job in hand', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work&lane=failed`, { waitUntil: 'networkidle0' });
      // The plan read failed: Now owes its retry, and it is the only failure on the page.
      await page.waitForFunction(() => [...document.querySelectorAll('section')]
        .filter((node) => [...node.querySelectorAll('button')]
          .some((button) => button.textContent?.trim() === 'Retry')).length === 1);

      const sections = await workSections(page);
      const now = sections[0];

      // The running job is a prop and is still Now's to show, beside the one retry that read owes.
      expect(now?.text).toContain('7c1e4a92');
      expect(now?.retries).toBe(1);
      // Nothing finished, so there is no Journal to draw.
      expect(await journalRows(page)).toBe(0);
      // And nothing outside a section owes one: the change-set card this
      // column always draws reads an EMPTY change-set here, not a broken one.
      expect(await page.$$eval('button', (nodes) => nodes.filter((node) => node.textContent?.trim() === 'Retry').length)).toBe(1);
      await page.close();
    });
  });

  test('the Journal holds every finished row its badge counts, under the day each ended', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 2400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await waitForWorkSection(page, 'Journal');

      const journal = (await workSections(page)).find((section) => section.title === 'Journal');

      expect(journal?.badge).toBe(String(await journalRows(page)));
      await page.close();
    });
  });
});

/** What the running job's card prints, a line per row, with the name it goes by above it. */
function latestOutput(page: Page): Promise<{ name: string; lines: string[] }> {
  return page.$eval('[aria-label="Latest output"]', (output) => ({
    name: output.parentElement?.firstElementChild?.textContent ?? '',
    lines: (output.textContent ?? '').split('\n'),
  }));
}

/**
 * Now shows the work in hand as it runs: a running job prints its last lines, says where its sender dropped bytes
 * and how many, and keeps up as it prints. Under it the journal is every settled thing, newest first, whatever kind.
 */
describe('Work keeps up with what is happening and what happened', () => {
  test('a running job shows its last lines with each drop in place, and moves on as it prints', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      // The sender dropped 1.2 MB before its first line and 4 KB before its fifth.
      await page.goto(`${origin}/gallery.html?frame=work&lane=streaming&lines=6&lost=1258291,0,0,0,4096`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Latest output"]');

      const { name, lines } = await latestOutput(page);

      // Named by its label, then its short id.
      expect(name).toBe('workspace: bun run build4e1a77c0');
      // Four lines of its own; the drop before them is told first and the one between them where it fell.
      expect(lines.filter((line) => !line.includes('omitted'))).toEqual(['warn: chunk vendor.js is 1.4 MB after minify', 'compiled 120 modules', 'compiled 248 modules', 'compiled 377 modules']);
      expect(lines[0]).toContain('1.2 MB');
      expect(lines[3]).toContain('4.0 KB');
      // Only the job still running prints; a settled one shows its outcome.
      expect(await page.$$eval('[aria-label="Latest output"]', (outputs) => outputs.length)).toBe(1);

      await page.goto(`${origin}/gallery.html?frame=work&lane=streaming&lines=4&live=1`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelector('[aria-label="Latest output"]')?.textContent?.endsWith('compiled 248 modules') === true);
      expect((await latestOutput(page)).lines).toEqual(['resolving 412 packages', 'warn: chunk vendor.js is 1.4 MB after minify', 'compiled 120 modules', 'compiled 248 modules']);
      await page.close();
    });
  });

  test('the journal interleaves settled jobs and closed tasks, newest first; the agent\'s self-changes are the Agent tab\'s', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 2400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await waitForWorkSection(page, 'Journal');

      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-journal-row]')].map((row) => row.textContent ?? ''));

      // Each fixture row by something only it says, in the order the fixture's times put them; a closed task names whose it was.
      const order = ['2f8b1d04', 'API docs page · main', '/api/health 500 · main', 'Stage the rollout · courier', '9d3c6e11'];

      expect(rows.map((row) => order.findIndex((marker) => row.includes(marker)))).toEqual(order.map((_, at) => at));
      // The running job is Now's, not the journal's.
      expect(rows.some((row) => row.includes('7c1e4a92'))).toBe(false);
      await page.close();
    });
  });
});

/**
 * The workspace's work is one thing: every actor's plans and tasks on one tab,
 * owners named, and a pending plan's decision one row in Needs you that opens
 * the plan's own page. `?frame=work`'s fixture carries a root plan
 * beside a subagent's and a task that holds the note its agent left.
 */
describe('the Work tab reads the workspace, not the actor', () => {
  test('every actor\'s plans list with owner names, each with its own tasks', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await waitForWorkSection(page, 'Plans');

      const plans = (await workSections(page)).find((section) => section.title === 'Plans');

      if (plans === undefined) throw new Error('the Plans section is missing');
      expect(plans.badge).toBe('2');
      expect(plans.text).toContain('Gateway timeout repair');
      expect(plans.text).toContain('Courier rollout');
      expect(plans.text).toContain('r3 · pending');
      // The courier's task sits under ITS plan with its owner named, and the
      // root's linked task sits under the root's — owners are per-card, not
      // per-tab.
      expect(plans.text).toContain('Stage the rollout');
      expect(plans.text).toContain('courier');

      const now = (await workSections(page)).find((section) => section.title === 'Now');

      if (now === undefined) throw new Error('the Now section is missing');
      expect(now.text).toContain('Patch the gateway timeout');
      expect(now.text).toContain('main');
      await page.close();
    });
  });

  test('a pending plan asks in Needs you, the row opens its own page tab, and Work is one click back', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await waitForWorkSection(page, 'Plans');

      const needs = (await workSections(page)).find((section) => section.title === 'Needs you');

      if (needs === undefined) throw new Error('the Needs you section is missing');
      expect(needs.text).toContain('Gateway timeout repair');

      await page.evaluate(() => {
        const row = [...document.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('Approve the plan'));

        if (row === undefined) throw new Error('the approve row is missing');
        row.click();
      });

      // The review is the plan's own page, its tab current among the pages: the plan list is gone, and what is on
      // screen is the pending revision's own decisions, the way the row promised.
      await page.waitForSelector('[data-plan-review-root]');
      expect(await page.$eval('[data-plan-title]', (element) => element.textContent)).toContain('Gateway');
      expect(await page.$eval('[data-plan-decisions]', (decisions) => decisions.checkVisibility())).toBe(true);
      expect(await page.$eval(`${PAGES_NAV} [aria-current="true"]`, (tab) => tab.getAttribute('aria-label'))).toContain('Gateway');
      expect(await page.$eval('[data-work-plans]', (list) => list.checkVisibility())).toBe(false);

      await page.click('nav[aria-label="Workspace"] button[aria-label="Work"]');
      await page.waitForSelector('[data-work-plans]', { visible: true });
      expect(await page.$eval('[data-plan-review-root]', (review) => review.checkVisibility())).toBe(false);
      await page.close();
    });
  });

  test('a task carrying a note renders it under the title with its owner', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 430, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=work`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelector('[data-work-plans]') !== null);

      const body = await page.evaluate(() => document.body.textContent ?? '');

      expect(body).toContain('Client already bails at 8s');
      await page.close();
    });
  });
  test('what the agent knows lists its saved notes, newest first', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=agent`, { waitUntil: 'networkidle0' });
      const panel = '[data-gallery-panel^="Loaded — everything"]';

      await page.waitForSelector(`${panel} [data-learning]`);
      const rows = await page.$$eval(`${panel} [data-learning]`, (nodes) => nodes.map((node) => node.textContent ?? ''));

      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain('Prompt lanes assemble');
      expect(rows[0]).toContain('2026-09-17 · courier');
      expect(rows[1]).toContain('retry budget');
      expect(rows[1]).toContain('2026-09-15 · main');
      await page.close();
    });
  });
});

/**
 * Model tiers are an open vocabulary (#7, #9, #11). The owner adds a tier by
 * name, it renders beside the builtins with the reasoning levels ITS model
 * documents, and a role can be pointed at it. The row border is the page's
 * border token: the earlier `--c-border-subtle` was never defined, so every
 * tier row drew its border in the text colour.
 */
/** Opens the themed choice named `label`, reads its options, and closes it; a closed popup stays mounted, hidden. */
async function choiceOptions(page: Page, label: string, selector = `[aria-label="${label}"]`): Promise<string[]> {
  await page.click(selector);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

  const options = await page.$$eval('[role="option"]', (nodes) => nodes
    .filter((node) => node.checkVisibility())
    .map((node) => node.textContent?.trim() ?? ''));

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

  return options;
}

/** Opens the themed choice named `label` and picks the visible option reading exactly `text`, with a real click. */
async function chooseOption(page: Page, label: string, text: string): Promise<void> {
  await page.click(`[aria-label="${label}"]`);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

  for (const option of await page.$$('[role="option"]')) {
    if (await option.evaluate((node, wanted) => node.checkVisibility() && node.textContent?.trim() === wanted, text)) {
      await option.click();

      return;
    }
  }

  throw new Error(`${label} offers no ${text}`);
}

describe('model tiers are the owner\'s to add, and each offers its model\'s own levels', () => {
  test('an added tier renders, takes its model\'s levels, and is offered to roles', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      // Adding a tier is one of the Advanced settings, closed until asked for.
      await page.click('[data-section="advanced"] > button');
      await page.waitForSelector('[aria-label="New tier id"]');

      await page.type('[aria-label="New tier id"]', 'review');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-tier="review"] [data-model-picker="review model"]');
      // A new tier starts as a copy of default (a Workers AI model, no levels): no thinking to pick.
      expect(await page.$('[aria-label="review reasoning effort"]')).toBeNull();

      // Point it at a model that documents five levels: the choice offers
      // exactly those, in the model's order, through the combobox every tier row carries.
      // The picker opens on an empty search, so a new choice starts by typing, never by deleting.
      await page.click('[data-tier="review"] [data-model-picker="review model"]');
      await page.waitForSelector('input[aria-label="Search review model"]');
      expect(await page.$eval('input[aria-label="Search review model"]', (input) => (input instanceof HTMLInputElement ? input.value : null))).toBe('');
      await page.keyboard.type('Opus');
      await page.waitForSelector('[role="option"]');
      await page.click('[role="option"]');
      await page.waitForSelector('[aria-label="review reasoning effort"]');
      const levels = () => page.$$eval('[aria-label="review reasoning effort"] [role="tab"]', (tabs) => tabs.map((tab) => tab.textContent?.trim()));

      expect(await levels()).toEqual(['Auto', 'Low', 'Medium', 'High', 'Extra high', 'Max']);

      // Its provider holds two accounts, so the row asks which; the model's levels stay offered on either.
      expect((await choiceOptions(page, 'review model account')).slice(1)).toEqual(['main', 'work']);
      await chooseOption(page, 'review model account', 'work');
      await page.waitForFunction(() => document.querySelector('[aria-label="review model account"]')?.textContent?.trim() === 'work');
      expect(await levels()).toEqual(['Auto', 'Low', 'Medium', 'High', 'Extra high', 'Max']);

      // The role editor lists the new tier.
      expect(await choiceOptions(page, 'Default tier')).toContain('review model');

      // Removing it is one click, and only a non-builtin offers it.
      expect(await page.$('[aria-label="Remove tier default"]')).toBeNull();
      await page.click('[aria-label="Remove tier review"]');
      expect(await page.$('[aria-label="review reasoning effort"]')).toBeNull();
      await page.close();
    });
  });

  test('a tier\'s fallbacks are chosen in order, may run one model on each account, never repeat an entry, and leave by their remove', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1000, height: 1400 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=models`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="default fallbacks"]');

      const chain = () => page.$eval('[aria-label="default fallbacks"]', (group) => [...group.querySelectorAll('[data-spec]')]
        .map((chip) => chip.getAttribute('data-spec') ?? ''));

      // The model picker's trigger is named from inside it; `data-model-picker` is where that name sits.
      const offered = async (label: string) => (await choiceOptions(page, 'default add fallback', '[data-model-picker="default add fallback"]'))
        .some((option) => option.includes(label));

      const settled = (specs: readonly string[]) => page.waitForFunction((wanted) => {
        const chips = [...document.querySelectorAll('[aria-label="default fallbacks"] [data-spec]')].map((chip) => chip.getAttribute('data-spec'));

        return JSON.stringify(chips) === JSON.stringify(wanted);
      }, {}, specs);

      const pick = async (label: string) => {
        await page.click('[data-model-picker="default add fallback"]');
        await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

        for (const option of await page.$$('[role="option"]')) {
          if (await option.evaluate((node, wanted) => node.checkVisibility() && node.textContent?.includes(wanted) === true, label)) {
            await option.click();

            return;
          }
        }

        throw new Error(`no option ${label}`);
      };

      expect(await chain()).toEqual([]);
      expect(await offered('Claude Opus 4.7')).toBe(true);
      await pick('Claude Opus 4.7');
      await settled(['anthropic/claude-opus-4-7']);

      // An entry names its account: switch the first to `work`, then the same model is offered on each account left.
      await chooseOption(page, 'default fallback 1 account', 'work');
      await settled(['anthropic@work/claude-opus-4-7']);

      await pick('Claude Opus 4.7');
      await settled(['anthropic@work/claude-opus-4-7', 'anthropic/claude-opus-4-7']);
      await pick('Claude Opus 4.7');
      await settled(['anthropic@work/claude-opus-4-7', 'anthropic/claude-opus-4-7', 'anthropic@main/claude-opus-4-7']);

      // Every account of it is in the chain now: it is not offered again.
      expect(await offered('Claude Opus 4.7')).toBe(false);
      await pick('Llama 4');
      await settled(['anthropic@work/claude-opus-4-7', 'anthropic/claude-opus-4-7', 'anthropic@main/claude-opus-4-7', 'workers-ai/llama-4']);

      await page.click('[aria-label="Remove anthropic@work/claude-opus-4-7 from the default fallbacks"]');
      await settled(['anthropic/claude-opus-4-7', 'anthropic@main/claude-opus-4-7', 'workers-ai/llama-4']);
      await page.close();
    });
  });
});

/**
 * K-05. A workspace the user has never touched opens its inspector COLLAPSED;
 * the first thing worth seeing opens it on the workspace's behalf. From then
 * on the user's own choice rules: a resize persists across reloads, a collapse
 * persists, and a passive arrival raises a "Preview ready" chip where the
 * reader already is — only an explicit click navigates.
 */
/** Waits until the trailing panel reports `want`; `'open'` is any width past
 *  the 200px an opened column clears. */
/** The trailing panel's widths that read as open and as collapsed: a collapsed column keeps at most its border. */
const INSPECTOR_BOUNDS = { open: 200, collapsed: 2 };

/** Whether the trailing panel reads as open, collapsed, or neither. */
async function inspectorShown(page: Page): Promise<'open' | 'collapsed' | 'between'> {
  return await page.evaluate(({ open, collapsed }) => {
    const width = Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1);

    if (width > open) return 'open';

    return width <= collapsed ? 'collapsed' : 'between';
  }, INSPECTOR_BOUNDS);
}

async function waitForInspectorWidth(page: Page, want: number | 'open'): Promise<void> {
  await page.waitForFunction((target: number | 'open', { open }: typeof INSPECTOR_BOUNDS) => {
    const panels = [...document.querySelectorAll('[data-panel]')];
    const width = Math.round(panels[1]?.getBoundingClientRect().width ?? 0);

    return target === 'open' ? width > open : width === target;
  }, {}, want, INSPECTOR_BOUNDS);
}

/** Waits until two frames report the same trailing-panel width, and that width
 *  is the asked-for state. A commit and any write-back it schedules land inside
 *  one frame, so a width that survives two is the settled one. */
async function inspectorSettled(page: Page, want: 'open' | 'collapsed' | 'any'): Promise<void> {
  await page.waitForFunction((state: 'open' | 'collapsed' | 'any', { open, collapsed }: typeof INSPECTOR_BOUNDS) => {
    const width = () => Math.round(
      document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
    );

    const first = width();
    const wanted = state === 'any' || (state === 'open' ? first > open : first <= collapsed);

    return new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(wanted && width() === first)));
    });
  }, {}, want, INSPECTOR_BOUNDS);
}

/** The trailing panel's rounded width, and every key the page holds in
 *  `localStorage`. `Storage` is read through its own index API: it is a host
 *  object, and spreading it would lose the accessors it is defined with. */
async function readInspectorState(page: Page): Promise<{ width: number; stored: Record<string, string> }> {
  return await page.evaluate(() => {
    const stored: Record<string, string> = {};

    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);

      if (key === null) continue;

      const value = localStorage.getItem(key);

      if (value !== null) stored[key] = value;
    }

    return {
      width: Math.round(document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1),
      stored,
    };
  });
}

/** The separator's centre, once it is on the page: where a drag starts. */
async function separatorCentre(page: Page): Promise<{ x: number; y: number }> {
  const separator = present(await page.waitForSelector('[data-separator]'), 'the inspector separator');
  const box = present(await separator.boundingBox(), 'the separator bounding box');

  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

describe('the workspace inspector at the actual WorkspacePage boundary', () => {
  test('collapsed until something arrives, then resize persists across reload; collapse persists; passive arrival chips, explicit click navigates', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // The first visit has nothing worth showing only until its snapshot lands, and a fixture answers in
      // microseconds, so the snapshot is held: the collapsed state lasts until the gate releases it.
      await page.goto(`${origin}/gallery.html?frame=workspacepage&snapshot=held`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');

      const inspectorWidth = () => page.$$eval('[data-panel]', (panels) => Math.round(panels[1]?.getBoundingClientRect().width ?? -1));

      // The first layout commit is the definite event: a collapsed column behind its handle is asserted, never
      // waited for, so a first visit that opens fails here at once.
      await page.waitForSelector('[data-inspector-commits]');
      expect(await page.$('[data-inspector-expand]')).not.toBeNull();
      expect(await inspectorShown(page)).toBe('collapsed');

      // The snapshot's pending plan needs the person, so its arrival opens the column.
      await page.evaluate(() => { document.documentElement.dataset.snapshotReleased = '1'; });
      await waitForInspectorWidth(page, 'open');

      // The passive arrival is the something worth seeing: the column opens
      // on the workspace's behalf AND raises the chip where the reader is —
      // Work stays current, only the explicit click navigates.
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForSelector('[data-preview-ready]');
      await waitForInspectorWidth(page, 'open');
      expect(await page.$eval('[aria-label="Work"]', (el) => el.getAttribute('aria-current'))).toBe('true');

      await page.click('[data-preview-ready]');
      await page.waitForSelector('[aria-label="Arrived app"][aria-current="true"]');
      expect(await page.$('[data-preview-ready]')).toBeNull();

      // A keyboard resize is an explicit size: it survives a reload. One
      // ArrowRight step is five percentage points, which lands the 340px
      // inspector on its 280px floor; further steps would collapse it, which
      // the collapse leg below covers through the button instead.
      await page.click('[data-separator]');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('[data-panel]')];
        const width = Math.round(panels[1]?.getBoundingClientRect().width ?? -1);

        return width >= 270 && width <= 290;
      });
      const resized = await inspectorWidth();
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await page.waitForFunction((expected: number) => {
        const panels = [...document.querySelectorAll('[data-panel]')];

        return Math.abs(Math.round(panels[1]?.getBoundingClientRect().width ?? -1) - expected) <= 3;
      }, {}, resized);

      // Collapse hides the column behind a visible handle; that stands a reload.
      await page.click('[data-inspector-collapse]');
      await page.waitForSelector('[data-inspector-expand]');
      expect(await inspectorShown(page)).toBe('collapsed');
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-inspector-expand]');
      expect(await inspectorShown(page)).toBe('collapsed');
      await page.click('[data-inspector-expand]');
      await waitForInspectorWidth(page, 'open');

      await page.close();
    });
  });

  test('an oversize saved width constrains on screen but survives in storage with no explicit choice', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // The account holds a 2000px preference (kept from a wider display);
      // this workspace carries no open/close choice of its own.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '2000');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');

      // The signal opens the column on the workspace's behalf; the group
      // cannot fit 2000px beside the chat minimum, so it commits what fits.
      // The column's committed width is stable across frames once the
      // write's commit — and any persist its report triggers — has landed.
      await inspectorSettled(page, 'open');

      const state = await readInspectorState(page);

      // Constrained on screen, preferred in storage, and — nothing here was
      // the user's explicit choice, so no choice is written for this
      // workspace.
      expect(state.width).toBeLessThan(await page.evaluate(() => innerWidth));
      expect(state.stored['kinu.inspector.ashish@example.com']).toBe('2000');
      expect(Object.keys(state.stored).filter((key) => key.startsWith('kinu.inspector.open.'))).toEqual([]);

      await page.close();
    });
  });

  test('a reset to the already-committed width leaves no mark: the next drag persists', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '340');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.api-worker', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await waitForInspectorWidth(page, 340);

      // resetToDefault at the committed 340 issues a no-op write: the
      // library emits nothing, and nothing marks the next emission as
      // ours to swallow.
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-separator]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });

      // A real drag follows: pointerdown marks the input, the release
      // commit persists the width the user's hand chose. The inspector is
      // the trailing panel — dragging the separator right narrows it.
      const { x, y } = await separatorCentre(page);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 60, y, { steps: 4 });
      await page.mouse.up();

      // The release commit and its persist are synchronous in the same
      // dispatch: the width lands at 280 and the store holds it.
      await page.waitForFunction(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) === 280);

      const state = await readInspectorState(page);

      expect(state.width).toBe(Number(state.stored['kinu.inspector.ashish@example.com']));

      await page.close();
    });
  });

  test("a drag's end leaves no rule down the inspector's edge; reaching the handle by keyboard shows it", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '340');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.api-worker', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await waitForInspectorWidth(page, 340);

      // What the reader sees down the column's edge: the handle's own pixels, once its transition has run.
      const edge = async (): Promise<Uint8Array> => {
        await page.waitForFunction(() => document.querySelector('[data-separator] > span')?.getAnimations().length === 0);

        return present(await page.$('[data-separator]'), 'the inspector separator').screenshot();
      };

      const same = (left: Uint8Array, right: Uint8Array): boolean => Buffer.from(left).equals(Buffer.from(right));

      await page.mouse.move(200, 450);
      const untouched = await edge();
      const { x, y } = await separatorCentre(page);

      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 40, y, { steps: 4 });
      await page.mouse.up();
      await page.mouse.move(200, 450);

      // The handle keeps the focus the press gave it; the owner saw that as an accent line standing down the column.
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-separator'))).toBe(true);
      expect(same(await edge(), untouched)).toBe(true);

      await page.keyboard.press('Tab');
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-separator'))).toBe(true);
      expect(same(await edge(), untouched)).toBe(false);

      await page.close();
    });
  });

  test('a viewport narrowing that squeezes the inspector persists nothing and latches no choice', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // The stored 2000px cannot fit beside the chat floor: every committed
      // layout here is the ResizeObserver's constraint, never a gesture.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '2000');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.api-worker', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await waitForInspectorWidth(page, 'open');

      const before = await page.evaluate(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ));

      // Narrowing re-commits a smaller constrained layout: no input mark,
      // so the preferred 2000 stays stored and no new choice is written.
      await page.setViewport({ width: 1100, height: 900 });
      await page.waitForFunction((prev: number) => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) < prev, {}, before);

      const state = await readInspectorState(page);

      expect(state.width).toBeLessThan(before);
      expect(state.stored['kinu.inspector.ashish@example.com']).toBe('2000');
      expect(Object.keys(state.stored).filter((key) => key.startsWith('kinu.inspector.open.')).sort()).toEqual([
        'kinu.inspector.open.ashish@example.com.api-worker',
      ]);

      await page.close();
    });
  });

  test('two desktop↔mobile remounts leave the document and separator listener counts at baseline', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        // Every listener the page registers is counted by target+type; the
        // same accounting on remove keeps a live tally.
        const listeners = new Map<string, number>();

        window.__liveListeners = listeners;

        const tally = (target: EventTarget, type: string, delta: number) => {
          // The separator div carries `data-separator` (the library sets it);
          // `instanceof HTMLElement` narrows it without a cast, and
          // `instanceof Document` covers the ownerDocument listeners. Any
          // other target matches neither and is skipped.
          if (target instanceof HTMLElement && target.dataset['separator'] !== undefined) {
            const key = `sep:${type}`;
            listeners.set(key, (listeners.get(key) ?? 0) + delta);

            return;
          }

          if (target instanceof Document) {
            const key = `doc:${type}`;
            listeners.set(key, (listeners.get(key) ?? 0) + delta);
          }
        };

        const proto: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = EventTarget.prototype;
        const add = proto.addEventListener;
        const remove = proto.removeEventListener;

        EventTarget.prototype.addEventListener = function (type, listener, options) {
          tally(this, type, 1);

          if (listener !== null) add.call(this, type, listener, options);
        };

        EventTarget.prototype.removeEventListener = function (type, listener, options) {
          tally(this, type, -1);

          if (listener !== null) remove.call(this, type, listener, options);
        };

        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '400');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.api-worker', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-separator]');

      const readTally = () => {
        const listeners = window.__liveListeners;

        if (listeners === undefined) throw new Error('the listener tally was never installed');

        return Object.fromEntries(listeners);
      };

      const baseline = await page.evaluate(readTally);

      // Two full remounts: each swap unmounts the separator element, which
      // must detach every listener the hook attached — element and document.
      // The remount states themselves are the wait: the separator is absent
      // on mobile, present on desktop.
      for (let i = 0; i < 2; i++) {
        await page.setViewport({ width: 600, height: 900 });
        await page.waitForFunction(() => document.querySelector('[data-separator]') === null);
        await page.setViewport({ width: 1440, height: 900 });
        await page.waitForSelector('[data-separator]');
      }

      const after = await page.evaluate(readTally);

      expect(after).toEqual(baseline);

      await page.close();
    });
  });

  test('a press retired by a remount cannot mark the next tree\'s commits', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // A stored width with no choice of its own: the signal opens the
      // column on the workspace's behalf without writing a choice.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '300');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-separator]');
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await waitForInspectorWidth(page, 'open');

      // Press without release: the input mark is set and no clear is
      // scheduled — only the separator's own detach can retire it. The
      // release-free move returns the library to inactive with zero
      // commits, which the hook never listens to, so the mark survives.
      await page.evaluate(() => {
        const separator = document.querySelector('[data-separator]');
        separator?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        separator?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      });

      // The swap unmounts the separator; the restore mounts a new tree whose
      // first emission is its own announcement, not a gesture.
      await page.setViewport({ width: 600, height: 900 });
      await page.waitForFunction(() => document.querySelector('[data-separator]') === null);
      await page.setViewport({ width: 1440, height: 900 });
      await page.waitForSelector('[data-separator]');

      // The narrower group re-commits the held pixel width at a new share —
      // twice. The restore's announcement already consumed this tree's first
      // emission (the mode swap resets the measured flag after it), so the
      // first tweak only re-arms; the second is the one that classifies.
      // A retired press is input to no tree, so no choice key can appear.
      // That is a claim about a write that must never come, and geometry
      // cannot synchronize the read (panels reflow through plain CSS ahead
      // of the commit pipeline), so the end condition is the pipeline's own:
      // the group counts the layout commits the hook has classified, and the
      // storage is read once the second tweak's commit has been counted —
      // after which the hook has either persisted or adopted, and nothing
      // more is scheduled.
      const layoutCommits = async (): Promise<number> => page.$eval(
        '[data-inspector-commits]', (panel) => Number(panel.getAttribute('data-inspector-commits')),
      );

      const committedPast = async (previous: number): Promise<void> => {
        await page.waitForFunction((prev: number) => Number(
          document.querySelector('[data-inspector-commits]')?.getAttribute('data-inspector-commits'),
        ) > prev, {}, previous);
      };

      const commitsBefore = await layoutCommits();
      await page.setViewport({ width: 1400, height: 900 });
      await committedPast(commitsBefore);
      const commitsAfterFirst = await layoutCommits();
      await page.setViewport({ width: 1350, height: 900 });
      await committedPast(commitsAfterFirst);

      const openKey = 'kinu.inspector.open.ashish@example.com.api-worker';

      expect(await page.evaluate((key: string) => localStorage.getItem(key), openKey)).toBeNull();

      const { stored } = await readInspectorState(page);

      expect(stored['kinu.inspector.ashish@example.com']).toBe('300');

      await page.close();
    });
  });

  test('the first divider drag after a remount persists its width and choice', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '340');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.api-worker', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await waitForInspectorWidth(page, 340);

      // A full remount: the restored tree's announcement is its own, so the
      // drag below is the first commit anyone could mistake — it must read
      // as the user's and persist, with no warmup commit in between.
      await page.setViewport({ width: 600, height: 900 });
      await page.waitForFunction(() => document.querySelector('[data-separator]') === null);
      await page.setViewport({ width: 1440, height: 900 });
      await page.waitForSelector('[data-separator]');

      // Quiesce the fresh tree so the coordinates below are live. The
      // inspector is the trailing panel — dragging the separator right
      // narrows it from 340 to its 280 floor.
      await inspectorSettled(page, 'any');
      const { x, y } = await separatorCentre(page);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 60, y, { steps: 4 });

      // The held drag must move pixels: a drag the library never hears
      // moves nothing, and must fail loudly here — never silently
      // downstream as a classification result. Live recompute applies
      // styles without committing, so this proves engagement while the
      // release commit is still to come.
      await page.waitForFunction(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) !== 340);
      await page.mouse.up();

      // Settle, then assert: whatever the drag commit classified, every
      // commit it schedules (including a policy write-back) has landed —
      // the settled width plus the stored values pin the classification.
      await inspectorSettled(page, 'any');

      const state = await readInspectorState(page);

      expect(state.width).toBe(Number(state.stored['kinu.inspector.ashish@example.com']));
      expect(Number(state.stored['kinu.inspector.ashish@example.com'])).toBeLessThan(340);
      expect(state.stored['kinu.inspector.open.ashish@example.com.api-worker']).toBe('1');

      await page.close();
    });
  });

  test('the first keyboard resize after a remount persists its width and choice', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '400');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.api-worker', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await waitForInspectorWidth(page, 400);

      await page.setViewport({ width: 600, height: 900 });
      await page.waitForFunction(() => document.querySelector('[data-separator]') === null);
      await page.setViewport({ width: 1440, height: 900 });
      await page.waitForSelector('[data-separator]');

      // Quiesce the fresh tree, then focus the separator that is actually
      // mounted and press: the library reads only key and currentTarget,
      // but a press delivered while focus still sits on the detached old
      // element reaches no handler — that is a fixture outcome, not a
      // product one. One ArrowRight step is five percentage points,
      // landing the 400px inspector near 328 — off the seed, inside
      // bounds, exactly the user's.
      await inspectorSettled(page, 'any');
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-separator]')?.focus();
      });
      await page.keyboard.press('ArrowRight');

      // The keypress must move pixels within a bound: a press the library
      // never hears is a dead tree and fails loudly here.
      await page.waitForFunction(() => Math.round(
        document.querySelectorAll('[data-panel]')[1]?.getBoundingClientRect().width ?? -1,
      ) < 340);

      // Settle, then assert: whatever the keypress commit classified, every
      // commit it schedules (including a policy write-back) has landed.
      await inspectorSettled(page, 'any');

      const state = await readInspectorState(page);

      // Fractional shares round differently across read paths, so the
      // committed width can differ a pixel from the rect read; a stored
      // width off the seed proves the commit was claimed as the user's.
      expect(state.width).toBeCloseTo(Number(state.stored['kinu.inspector.ashish@example.com']), -1);
      expect(Number(state.stored['kinu.inspector.ashish@example.com'])).toBeLessThan(400);
      expect(state.stored['kinu.inspector.open.ashish@example.com.api-worker']).toBe('1');

      await page.close();
    });
  });

  test('an anonymous session reads and writes nothing — the signal still opens the column', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // `anon=1` answers the profile read null, so the hook never resolves an
      // account key and every persist path is a no-op — not "no account yet":
      // there is no account, and the seed row proves nothing wrote one.
      await page.goto(`${origin}/gallery.html?frame=workspacepage&anon=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');

      // The signal opens the policy-collapsed column on the workspace's
      // behalf — with no account it still opens, it just cannot persist.
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await waitForInspectorWidth(page, 'open');

      // The collapse control is still the user's own act; with no account it
      // claims the close for the session and writes nothing anywhere.
      await page.click('[data-inspector-collapse]');
      await page.waitForSelector('[data-inspector-expand]');

      const { stored } = await readInspectorState(page);

      expect(Object.keys(stored).filter((key) => key.startsWith('kinu.inspector.'))).toEqual([]);

      await page.close();
    });
  });

  test('a stored collapse is the user\'s: the arriving signal does not reopen it', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // The workspace's own stored '0' outranks the first-visit signal — the
      // port lands, the column stays behind its expand handle.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '300');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.api-worker', '0');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-inspector-expand]');

      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForSelector('[data-preview-ready]');
      // Settle past the window the signal would have opened in: the panel
      // stays at its collapsed size and the choice is still '0'.
      await inspectorSettled(page, 'collapsed');

      const { stored } = await readInspectorState(page);

      expect(stored['kinu.inspector.open.ashish@example.com.api-worker']).toBe('0');

      await page.close();
    });
  });

  // A preview is only replaced by what the sandbox validly says: a failed or forged answer keeps the last good one and
  // names the problem; an answer of no ports retires it.
  test('a running preview survives a failed or forged listing, and leaves when the sandbox lists no ports', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => { document.documentElement.dataset.previewArrived = '1'; });
      await page.waitForSelector('[data-preview-ready]');
      await page.click('[data-preview-ready]');
      await page.waitForSelector('[aria-label="Arrived app"]');

      const listingSays = (state: string) => page.evaluate((next) => { document.documentElement.dataset.sandboxPorts = next; }, state);

      // The listing's failure line, by what it names; its full message is the line's title.
      const problem = () => page.evaluate(() => [...document.querySelectorAll('[data-failure]')]
        .find((line) => line.textContent?.includes('preview listings'))?.getAttribute('title') ?? null);

      await listingSays('failed');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-failure]')].some((line) => line.textContent?.includes('preview listings')));
      expect(await problem()).toContain('Nimbus is temporarily unavailable');
      expect(await page.$('[aria-label="Arrived app"]')).not.toBeNull();

      await listingSays('forged');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-failure]')].some((line) => line.getAttribute('title')?.includes('invalid preview registration')));
      expect(await page.$eval('[aria-label="Arrived app"]', (tab) => tab.getAttribute('title') ?? tab.textContent ?? '')).not.toContain('evil.example');

      await listingSays('none');
      await page.waitForFunction(() => document.querySelector('[aria-label="Arrived app"]') === null);
      expect(await problem()).toBeNull();
      await page.close();
    });
  });

  test('a collapse issued while a reset is in flight still claims its target', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // Open at 300: the reset's claim and the collapse's claim are both the
      // user's own acts — whichever report lands first, the close is '0' and
      // the resting width is the one the collapse read.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('kinu.inspector.account', 'ashish@example.com');
        localStorage.setItem('kinu.inspector.ashish@example.com', '300');
        localStorage.setItem('kinu.inspector.open.ashish@example.com.api-worker', '1');
      });
      await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[aria-label="Work"]');
      await waitForInspectorWidth(page, 300);

      // One task, two control acts: the dblclick's resetToDefault claims 340
      // and issues the write; the collapse clicks before its report settles
      // and claims the close at call time. If the library commits the resize
      // synchronously the collapse reads 340 and persists it; if the report
      // lands later the collapse read 300. The un-conditional half is the
      // point: the close is '0' and the stored width is the column's own.
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-separator]')
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        document.querySelector<HTMLElement>('[data-inspector-collapse]')?.click();
      });

      await page.waitForSelector('[data-inspector-expand]');

      const state = await readInspectorState(page);

      expect(await inspectorShown(page)).toBe('collapsed');
      expect(state.stored['kinu.inspector.open.ashish@example.com.api-worker']).toBe('0');
      // The stored resting width is the reset's 340 or the pre-reset 300 —
      // the collapse claims whichever the panel answered at call time, and
      // the reset's own emission can never overwrite it.
      expect(['300', '340']).toContain(state.stored['kinu.inspector.ashish@example.com']);

      await page.close();
    });
  });
});

interface CreateProbe {
  posts: number;
  release: (() => void) | null;
}

declare global {
  interface Window {
    __createProbe: CreateProbe;
    /** Create requests the unlisted-account probe answered. */
    __creates: number;
    /** Listener counts by target and type, kept by the patched `EventTarget`. */
    __liveListeners?: Map<string, number>;
  }
}

describe('the home creation form, as a browser submits it', () => {
  test('one gesture in flight means one create request, and a refused create frees a retry', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.evaluateOnNewDocument(() => { localStorage.setItem('theme', 'dark'); });
      await page.goto(`${origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#workspace-mission');

      // The gallery's fetch IS the HTTP boundary for this page — the stub
      // returns a 404 for the create POST, so the probe wraps it to hold the
      // response under explicit test control. Every other request falls
      // through to the gallery's own handling untouched.
      await page.evaluate(() => {
        const inner = window.fetch;
        const probe: CreateProbe = { posts: 0, release: null };

        window.__createProbe = probe;
        // The member the Bun fetch type requires, forwarded from the callable
        // being wrapped — the pattern client-error/feedback-ux already use.
        window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : input.toString();

          if (init?.method === 'POST' && url.includes('/api/user/workspaces')) {
            probe.posts += 1;

            // First POST: refuse it on release. Every later one: the entry the
            // registerWorkspace parse requires, so a retry exercises success.
            const status = probe.posts === 1 ? 500 : 200;

            const body = probe.posts === 1
              ? { error: 'probe: create refused' }
              : { name: 'probe-created', displayName: 'Probe created', createdAt: 1, lastVisited: 1, archivedAt: null };

            return new Promise<Response>((resolve) => {
              probe.release = () => resolve(new Response(
                JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
            });
          }

          return inner(input, init);
        }, { preconnect: inner.preconnect });
      });

      await page.type('#workspace-mission', 'Keep the api Worker deployed and healthy.');
      await page.click('button[type="submit"]');

      // Held request arrived AND the pending paint landed — not a sleep.
      await page.waitForFunction(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent?.includes('Create workspace'));

        const ta = document.querySelector('#workspace-mission');

        return window.__createProbe.posts === 1
          && btn instanceof HTMLButtonElement && btn.disabled
          && ta instanceof HTMLTextAreaElement && ta.disabled
          && btn.querySelector('svg') !== null;
      });

      // A second gesture while the first is held: pointer submit AND the
      // keyboard path. Neither may queue another create.
      await page.click('button[type="submit"]');
      await page.evaluate(() => {
        const mission = document.querySelector('#workspace-mission');

        if (!(mission instanceof HTMLElement)) throw new Error('mission textarea absent');

        mission.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      });
      expect(await page.evaluate(() => window.__createProbe.posts)).toBe(1);

      // Release into a refusal: the notice names it, the fields re-enable.
      await page.evaluate(() => { window.__createProbe.release?.(); });
      await page.waitForFunction(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent?.includes('Create workspace'));

        const ta = document.querySelector('#workspace-mission');

        return document.querySelector('form [role="alert"]') !== null
          && btn instanceof HTMLButtonElement && !btn.disabled
          && ta instanceof HTMLTextAreaElement && !ta.disabled;
      });

      // The deliberate retry fires exactly one more request.
      await page.click('button[type="submit"]');
      await page.waitForFunction(
        () => window.__createProbe.posts === 2 && window.__createProbe.release !== null);
      await page.evaluate(() => { window.__createProbe.release?.(); });

      // The retry's 200 resolves through the real create path: the entry the
      // registry answered with lands in the roster the page reads
      // (roster.upsert runs before the awaited navigate), and no error
      // surface remains. The gallery mounts this page under a MemoryRouter,
      // so navigation itself is unobservable — the roster row is the real
      // product state the create had to produce.
      await page.waitForFunction(
        () => document.querySelector('form [role="alert"]') === null
          && document.body.innerText.includes('Probe created'));
      expect(await page.evaluate(() => window.__createProbe.posts)).toBe(2);
      await page.close();
    });
  });

  test('a model listing that failed leaves the create to the backend, which admits it', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });

      // The only listing failed, so nothing is listed; `defaultSpecFor` counts that provider's models as servable and the
      // create succeeds. Installed before the gallery loads, since the page may read the listing on mount.
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('theme', 'dark');
        const native = window.fetch;
        let gallery: typeof window.fetch | null = null;
        window.__creates = 0;

        const answer = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input.toString(), location.origin);

          if (url.pathname === '/api/user/models') {
            return Promise.resolve(Response.json({ models: [], failures: [{ provider: 'workers-ai', reason: 'the listing timed out' }] }));
          }

          if (init?.method === 'POST' && url.pathname === '/api/user/workspaces') {
            window.__creates += 1;

            return Promise.resolve(Response.json({ name: 'probe-created', displayName: 'Probe created', createdAt: 1, lastVisited: 1 }));
          }

          return (gallery ?? native)(input, init);
        }, { preconnect: native.preconnect });

        // The gallery keeps the fetch it finds for the network, then assigns its own, which this answer fronts.
        Object.defineProperty(window, 'fetch', {
          configurable: true,
          get: () => (gallery === null ? native : answer),
          set: (next: typeof window.fetch) => { gallery = next; },
        });
      });

      await page.goto(`${origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#workspace-mission');
      await page.type('#workspace-mission', 'Keep the api Worker deployed and healthy.');

      // Whatever the page made of the failed listing is painted by now: the create must still be offered.
      expect(await page.$eval('button[type="submit"]', (button) => button instanceof HTMLButtonElement && button.disabled)).toBe(false);
      await page.click('button[type="submit"]');

      // The created entry lands in the roster the page reads.
      await page.waitForFunction(() => window.__creates === 1 && document.body.innerText.includes('Probe created'));
      await page.close();
    });
  });
});

// The owner, 2026-11-04: "unable to open any other kinu views sometimes while on a chat". A send's landing is known only
// when its turn ends; run as a transition, React held every navigation behind it, the sidebar's included.
describe('a turn the chat is waiting on never holds the app on its page', () => {
  test('sent and still running, the sidebar opens the page it names', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`${origin}/gallery.html?frame=workspaceshell`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-composer-root] textarea:not([disabled])');
        await page.evaluate(() => { document.documentElement.dataset.galleryChatHold = '1'; });
        await page.type('[data-composer-root] textarea', 'Read the api Worker logs from the last hour');
        await page.click('[data-composer-root] button[aria-label="Send"]');
        await page.waitForFunction(() => document.documentElement.dataset.galleryChatSends === '1');

        await page.click('[data-rail] nav[aria-label="Primary"] a[href="/workspaces"]');
        // Held behind the turn, the chat stays and this waits out the row.
        await page.waitForSelector('[data-gallery-blank]');
        expect(await page.$('[data-composer-root]')).toBeNull();
      } finally {
        await page.close();
      }
    });
  });
});
