/** Real-browser account panels, viewport boundaries, deletion confirmation and workspace navigation. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { Effect } from 'effect';
import { describe, expect, test } from 'bun:test';
import type { HTTPRequest, Page } from 'puppeteer';
import { detach } from '@kinu.run/core/obs';
import { ONBOARDING_STEPS } from '@kinu.run/core';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';
import { evidenceDir } from '@kinu.run/test-utils';

const ONBOARDING_STEP_IDS = ONBOARDING_STEPS.map((step) => step.id);

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'load' });

  return page;
}

const dialogText = (page: Page) => page.$eval('[role="dialog"]', (element) => element.textContent ?? '');

/** What the page shows a reader when a step stops: the open dialog's name and words, any alert, and where focus is. */
async function pageState(page: Page): Promise<string> {
  return JSON.stringify(await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const focused = document.activeElement;

    return {
      dialogs: dialogs.map((dialog) => `${dialog.getAttribute('aria-label') ?? ''}: ${(dialog.textContent ?? '').replace(/\s+/gu, ' ').slice(0, 400)}`),
      alerts: [...document.querySelectorAll('[role="alert"]')].map((alert) => (alert.textContent ?? '').trim()),
      focus: focused === null ? 'none' : `${focused.tagName.toLowerCase()}${focused.id === '' ? '' : `#${focused.id}`}`,
    };
  }));
}

/**
 * Presses the control whose words begin with `words`, as a reader finds it. The step fails at once, with what the page
 * shows, when the dialog shows an error instead, or when `panel`, the part of the page the control belongs to, is gone.
 */
async function clickByText(page: Page, selector: string, words: string, panel?: string): Promise<void> {
  const seen = await page.waitForFunction((sel, text, within) => {
    if ([...document.querySelectorAll(sel)].some((node) => (node.textContent ?? '').trim().startsWith(text))) return 'shown';

    if (document.querySelector('[role="dialog"] [role="alert"]') !== null) return 'an error shown in its place';

    return within !== null && document.querySelector(within) === null ? `gone with ${within}` : false;
  }, {}, selector, words, panel ?? null).then(async (handle) => handle.jsonValue());

  if (seen !== 'shown') throw new Error(`"${words}" (${selector}) never came: ${String(seen)}; the page shows ${await pageState(page)}`);
  await page.$$eval(selector, (nodes, text) => {
    const target = nodes.find((node) => (node.textContent ?? '').trim().startsWith(text));

    if (!(target instanceof HTMLElement)) throw new Error(`${text} absent`);
    target.click();
  }, words);
}

/** The primary nav, painted, once each row's own colour transition has ended. */
async function navPaint(page: Page): Promise<{ label: string; background: string; ink: string; top: number; bottom: number }[]> {
  return page.$$eval('nav[aria-label="Primary"] a', async (anchors) => {
    await Promise.allSettled(anchors.flatMap((anchor) => anchor.getAnimations().map((animation) => animation.finished)));

    return anchors.map((anchor) => {
      const style = getComputedStyle(anchor);
      const box = anchor.getBoundingClientRect();

      return { label: anchor.textContent?.trim() ?? '', background: style.backgroundColor, ink: style.color, top: box.top, bottom: box.bottom };
    });
  });
}

/** Exactly one primary row is marked current; the caller names the route's row it must be. */
async function activeNavRow(page: Page): Promise<string> {
  const current = await page.$$eval('nav[aria-label="Primary"] a[aria-current="page"]', (rows) => rows.map((row) => row.textContent?.trim() ?? ''));

  if (current.length !== 1) throw new Error(`expected exactly one current nav row, got ${JSON.stringify(current)}`);

  return current[0] ?? '';
}

/** The fixture arms two states for the sibling failure rig: Codex failed and
 *  the gateway read held. This gate wants the settled account, so it heals and
 *  releases them, then retries the failed card's read. */
async function settleAccountFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('gallery:settings-heal'));
    window.dispatchEvent(new Event('gallery:settings-release'));
  });

  const retry = await page.$('[data-settings-resource="your ChatGPT connection"] button');
  await retry?.click();
}

declare global {
  interface Window {
    /** What `holdSignIns` holds, oldest first. */
    __heldAccount?: { readonly key: string; readonly release: (failed: boolean) => Promise<void> }[];
  }
}

const CLAUDE_FINISH = 'POST /api/user/claude/finish';

const CHATGPT_FINISH = 'POST /api/user/chatgpt/paste/finish';

const CREDENTIALS = 'GET /api/user/credentials';

const PLAN = 'GET /api/user/chatgpt';

/**
 * Holds the account's answers to the two sign-ins and to the reads that show them. A sign-in is finished when let
 * through; a read answers as the account stood when it was asked, and arrives when let through.
 */
async function holdSignIns(page: Page): Promise<void> {
  await page.evaluate((reads, finishes) => {
    const inner = window.fetch;
    const held: NonNullable<Window['__heldAccount']> = [];

    window.__heldAccount = held;
    window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${new URL(input instanceof Request ? input.url : String(input), location.href).pathname}`;

      if (!reads.includes(key) && !finishes.includes(key)) return inner(input, init);
      const asked = reads.includes(key) ? inner(input, init) : null;
      const arrived = Promise.withResolvers<Response>();

      held.push({ key, release: async (failed) => {
        const answer = failed ? Response.json({ error: 'the account did not answer' }, { status: 503 }) : await (asked ?? inner(input, init));
        const body = new Uint8Array(await answer.arrayBuffer());
        const read = Promise.withResolvers<void>();

        // Settles once the page has read the whole answer.
        arrived.resolve(new Response(new ReadableStream({ start: (into) => { into.enqueue(body); }, pull: (into) => { into.close(); read.resolve(); } }),
          { status: answer.status, headers: answer.headers }));
        await read.promise;
      } });

      return arrived.promise;
    }, { preconnect: inner.preconnect });
  }, [CREDENTIALS, PLAN], [CLAUDE_FINISH, CHATGPT_FINISH]);
}

/** Lets the newest held `key` through, as a failure when `failed`, and returns once the page has read it. */
async function letThrough(page: Page, key: string, failed = false): Promise<void> {
  await page.evaluate(async (wanted, fail) => {
    const held = window.__heldAccount ?? [];
    const at = held.map((entry) => entry.key).lastIndexOf(wanted);

    if (at < 0) throw new Error(`nothing held for ${wanted}`);
    await held.splice(at, 1)[0]?.release(fail);
  }, key, failed);
}

const heldOf = (page: Page, key: string) => page.evaluate((wanted) => (window.__heldAccount ?? []).filter((entry) => entry.key === wanted).length, key);

/** Workspace entries are complete, the current route is marked, and filters return the requested entries. */
async function checkWorkspacesView(page: Page, view: 'list' | 'tiled', viewport: keyof typeof VIEWPORTS): Promise<void> {
  await page.waitForSelector('[aria-label="Search workspaces"]');
  const body = await page.evaluate(() => document.body.innerText);
  expect(body).toContain('Workspaces');

  for (const name of ['API Worker', 'Dew', 'Support inbox', 'Kinu website']) {
    expect(body).toContain(name);
  }

  expect(await page.$eval('[data-workspaces-view]', (section) => section.getAttribute('data-workspaces-view'))).toBe(view);

  // One state per card, no more: the chip count equals the row count, and the
  // headline words are the shared rule's.
  await page.waitForFunction(
    () => document.querySelectorAll('[data-overview-chip]').length === 5,
  );
  const body2 = await page.evaluate(() => document.body.innerText);
  expect(body2).toContain('Needs you · 2');
  expect(body2).toContain('Last run failed');

  // No tile runs a slate: a live frame on every visit would wake each workspace's sandbox.
  expect(await page.$$('[data-workspaces-view] iframe')).toHaveLength(0);

  // The filter tabs sit in the control row. One create action is in reach, the sidebar's or, on a phone, the page's.
  const tabs = await page.$$eval('[aria-label="Workspace state"] [role="tab"]', (els) => els.map((el) => el.getAttribute('data-segment')));
  expect(tabs).toEqual(['all', 'needs', 'working', 'idle']);
  expect(await page.$$eval(':is(aside, main) :is(a, button)', (controls) => controls.filter((control) => (control.getAttribute('aria-label') ?? control.textContent?.trim()) === 'New workspace'
    && control instanceof HTMLElement && control.offsetParent !== null).length)).toBe(1);

  if (viewport === 'desktop') expect(await activeNavRow(page)).toBe('Workspaces');

  // 'Needs you' holds exactly the workspace whose decisions wait.
  await page.click('[data-segment="needs"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-workspaces-view] a').length === 1,
  );
  expect(await page.$eval('[data-workspaces-view] a', (a) => a.textContent ?? '')).toContain('API Worker');
  await page.click('[data-segment="all"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-workspaces-view] a').length === 5,
  );

  await page.type('[aria-label="Search workspaces"]', 'dew');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-workspaces-view] a').length === 1,
  );
  expect(await page.$eval('[data-workspaces-view] a', (a) => a.textContent ?? '')).toContain('Dew');
}

/** Is the delete-everything button awake? Asked in the page, so the polled
 *  wait and the assertions read the same button. */
const deleteArmed = (): boolean =>
  [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Delete everything') && !b.disabled);

describe('account panels', () => {
  test('the setup modal and the providers section render at both widths in both themes', async () => {
    await withGallery(async (gallery) => {
      

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const providers = await freshPage(gallery, 'setupmodal&panel=providers', theme, viewport);

          try {
            await providers.waitForSelector('[role="dialog"]');
            await settleAccountFixture(providers);
            await providers.waitForFunction(
              () => document.querySelector('[role="dialog"] [data-chatgpt-connect]') !== null,
            );

            const text = await dialogText(providers);
            expect(text).toContain('Cloudflare AI');
            expect(text).toContain('ChatGPT');
            expect(text).toContain('Claude');
            expect(text).toContain('Add an API key');
            
          } finally {
            await providers.close();
          }

          const mcp = await freshPage(gallery, 'setupmodal&panel=mcp', theme, viewport);

          try {
            await mcp.waitForSelector('[role="dialog"]');
            await mcp.waitForFunction(
              () => document.querySelector('[role="dialog"]')?.textContent?.toLowerCase().includes('needs sign-in'),
            );

            const text = await dialogText(mcp);
            expect(text).toContain('github');
            expect(text).toContain('Add custom server');
            expect(text.toLowerCase()).toContain('needs sign-in');

            // A status the layout pushed sideways is textContent that passes
            // while nothing is on screen: the badge must sit inside the
            // dialog's box with nothing between it and the dialog scrolled.
            const statusVisible = await mcp.evaluate(() => {
              const dialog = document.querySelector('[role="dialog"]');

              if (dialog === null) return false;

              const badge = [...dialog.querySelectorAll('span')].find((span) => span.textContent?.toLowerCase().includes('needs sign-in'));

              if (badge === undefined) return false;

              for (let node = badge.parentElement; node !== null && node !== dialog; node = node.parentElement) {
                if (node.scrollLeft !== 0) return false;
              }

              const bounds = badge.getBoundingClientRect();
              const edge = dialog.getBoundingClientRect();

              return bounds.left >= edge.left && bounds.right <= edge.right + 1
                && bounds.top >= edge.top && bounds.bottom <= edge.bottom + 1;
            });

            expect(statusVisible).toBe(true);
            
          } finally {
            await mcp.close();
          }

          const cli = await freshPage(gallery, 'setupmodal&panel=cli', theme, viewport);

          try {
            await cli.waitForSelector('[role="dialog"]');
            await cli.waitForFunction(
              () => document.querySelector('[role="dialog"]')?.textContent?.includes('kinu setup'),
            );

            expect(await dialogText(cli)).toContain('kinu setup');
            
          } finally {
            await cli.close();
          }

          const settings = await freshPage(gallery, 'usersettingsstate&section=providers', theme, viewport);

          try {
            await settings.waitForSelector('[data-settings-section="providers"]');
            await settleAccountFixture(settings);

            const text = await settings.evaluate(() => document.body.innerText);
            expect(text).toContain('Add an API key');
            expect(text).toContain('Manage MCP servers');
            
          } finally {
            await settings.close();
          }
        }
      }

      
    });
  });

  // Kinu's alerts (use-owner-alerts.ts): the sound is this device's to turn off, and a notification waits on the
  // browser's own permission, asked once the owner presses Allow.
  test("Appearance turns this device's alert sound off for good, and says where the browser stands on notifications", async () => {
    await withGallery(async (gallery) => {
      for (const theme of ['dark', 'light'] as const) {
        const page = await freshPage(gallery, 'usersettingsstate&section=appearance', theme, 'desktop');

        try {
          await page.waitForSelector('[data-alerts-sound][aria-checked="true"]');
          // Not yet asked: the browser's own prompt is one press away.
          expect(await page.$('[data-alerts-allow]')).not.toBeNull();
          await page.click('[data-alerts-sound]');
          await page.waitForSelector('[data-alerts-sound][aria-checked="false"]');
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('[data-alerts-sound][aria-checked="false"]');
          await page.click('[data-alerts-sound]');
          await page.waitForSelector('[data-alerts-sound][aria-checked="true"]');

          // Allowed: nothing left to press.
          await page.browserContext().overridePermissions(gallery.origin, ['notifications']);
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('[data-alerts-sound]');
          expect(await page.$('[data-alerts-allow]')).toBeNull();
          await page.browserContext().clearPermissionOverrides();
        } finally {
          await page.close();
        }
      }
    });
  });

  test('the account computer size saves through its picker and survives reload', async () => {
    await withGallery(async (gallery) => {
      const control = '[aria-label="Default computer size"]';

      const page = await freshPage(gallery, 'usersettingsstate&section=computer', 'dark', 'desktop');

      try {
        await page.waitForSelector(control);
        await page.click(control);
        await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

        const options = await page.$$('[role="option"]');
        let picked = -1;

        for (const [index, option] of options.entries()) {
          if (await option.evaluate((node) => node.checkVisibility() && node.getAttribute('aria-selected') !== 'true')) {
            picked = index;
            await option.click();
            break;
          }
        }

        if (picked === -1) throw new Error('the size picker offered no different size');

        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        await page.waitForFunction((selector) => {
          const node = document.querySelector(selector);

          return node !== null && !node.matches(':disabled') && node.getAttribute('aria-disabled') !== 'true';
        }, {}, control);

        await page.click(control);
        await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));
        expect(await page.$$eval('[role="option"]', (nodes) => nodes.findIndex((node) => node.getAttribute('aria-selected') === 'true'))).toBe(picked);
        await page.keyboard.press('Escape');
        expect(await page.$$eval('[role="alert"], [data-failure]', (nodes) => nodes.filter((node) => node.checkVisibility()).length)).toBe(0);
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector(control);
        await page.click(control);
        await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));
        expect(await page.$$eval('[role="option"]', (nodes) => nodes.findIndex((node) => node.getAttribute('aria-selected') === 'true'))).toBe(picked);
        await page.keyboard.press('Escape');
        expect(await page.$$eval('[role="alert"], [data-failure]', (nodes) => nodes.filter((node) => node.checkVisibility()).length)).toBe(0);
      } finally { await page.close(); }
    });
  });

  test('ChatGPT connects two ways: a machine gets its connect command, and an address pasted back here signs in', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'setupmodal&panel=providers', 'dark', 'desktop');

      try {
        await page.waitForSelector('[role="dialog"]');
        await settleAccountFixture(page);
        await page.waitForSelector('[data-chatgpt-connect]');

        // No machine is connected: choosing the PC hands the command that installs Kinu and connects it.
        await clickByText(page, '[data-chatgpt-connect] button', 'Use your PC', '[data-chatgpt-connect]');
        await page.waitForSelector('[data-chatgpt-way="pc"] [data-connect-command]');
        expect(await page.$eval('[data-connect-command]', (code) => code.textContent ?? '')).toContain('--connect');
        await clickByText(page, '[data-chatgpt-connect] button', 'Cancel', '[data-chatgpt-connect]');

        // Here: the sign-in opens at OpenAI, and the address the browser lands on is pasted back. A sign-in
        // cancelled at OpenAI is spent: starting again fetches a fresh link and clears the old address.
        await clickByText(page, '[data-chatgpt-connect] button', 'Sign in here', '[data-chatgpt-connect]');
        await page.waitForSelector('[data-chatgpt-way="here"] input');
        await page.type('[data-chatgpt-way="here"] input', 'http://127.0.0.1:1455/auth/callback?error=access_denied&state=xyz');
        await clickByText(page, '[data-chatgpt-way="here"] button', 'Finish', '[data-chatgpt-way="here"]');
        const starts = await page.evaluate(() => Number(document.documentElement.dataset.galleryPasteStarts ?? '0'));
        await clickByText(page, '[data-chatgpt-way="here"] button', 'Start again', '[data-chatgpt-way="here"]');
        await page.waitForFunction((before) => Number(document.documentElement.dataset.galleryPasteStarts ?? '0') > before, {}, starts);
        await page.waitForSelector('[data-chatgpt-way="here"] input');
        expect(await page.$eval('[data-chatgpt-way="here"] input', (input) => input.value)).toBe('');

        await page.type('[data-chatgpt-way="here"] input', 'http://127.0.0.1:1455/auth/callback?code=abc&state=xyz');
        await clickByText(page, '[data-chatgpt-way="here"] button', 'Finish', '[data-chatgpt-way="here"]');
        // Signed in: the row says so at once, before anything else is touched, and the welcome says what it means.
        await page.waitForFunction(() => document.querySelector('[data-provider="ChatGPT"]')?.textContent?.includes('Connected') === true
          && document.querySelector('[data-chatgpt-connect]') === null);
        await page.waitForFunction(() => document.body.textContent?.includes("You're using your ChatGPT plan") === true);
      } finally {
        await page.close();
      }
    });
  });

  // m2071: after ChatGPT's address was pasted back its row said Not connected until connecting Claude re-read it, with an
  // error beside it. Each sign-in re-reads its own provider at once; a read asked before the other provider finished,
  // arriving late, neither covers the newer answer nor shows its failure.
  test('Claude and ChatGPT sign-ins that overlap and answer out of order each end connected, with no error', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'setupmodal&panel=providers', 'dark', 'desktop');
      const code = '[aria-label="Claude sign-in code"]';

      try {
        await page.waitForSelector('[role="dialog"]');
        await settleAccountFixture(page);
        await page.waitForSelector('[data-chatgpt-connect]');
        await clickByText(page, '[data-chatgpt-connect] button', 'Sign in here', '[data-chatgpt-connect]');
        await page.waitForSelector('[data-chatgpt-way="here"] input');
        await page.type('[data-chatgpt-way="here"] input', 'http://127.0.0.1:1455/auth/callback?code=abc&state=xyz');
        await page.click('[data-provider="Claude"] button');
        await page.waitForSelector(code);
        await page.type(code, 'good-code');

        // ChatGPT's finish is asked first and Claude's second; Claude's answers first, so its reads hold no ChatGPT sign-in.
        await holdSignIns(page);
        await clickByText(page, '[data-chatgpt-way="here"] button', 'Finish', '[data-chatgpt-way="here"]');
        await page.waitForFunction(() => window.__heldAccount?.length === 1);
        await page.focus(code);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__heldAccount?.length === 2);
        await letThrough(page, CLAUDE_FINISH);
        await page.waitForFunction((reads) => reads.every((read) => window.__heldAccount?.some((entry) => entry.key === read)), {}, [CREDENTIALS, PLAN]);
        await letThrough(page, CHATGPT_FINISH);
        await page.waitForSelector('[data-chatgpt-way="here"]', { hidden: true });
        expect(await heldOf(page, PLAN)).toBe(2);

        // The newest reads arrive first; Claude's arrive after them, its plan stale and its credentials refused.
        await letThrough(page, PLAN);
        await letThrough(page, CREDENTIALS);
        await page.waitForFunction(() => ['ChatGPT', 'Claude'].every((name) => document.querySelector(`[data-provider="${name}"] button[aria-label^="Disconnect"]`) !== null));
        await letThrough(page, PLAN);
        await letThrough(page, CREDENTIALS, true);
        await page.evaluate(() => {
          const drawn = Promise.withResolvers<void>();

          requestAnimationFrame(() => { requestAnimationFrame(() => { drawn.resolve(); }); });

          return drawn.promise;
        });

        expect(await page.evaluate(() => ({
          connected: ['ChatGPT', 'Claude'].filter((name) => document.querySelector(`[data-provider="${name}"] button[aria-label^="Disconnect"]`) !== null),
          failures: document.querySelectorAll('[role="dialog"] :is([data-resource-state="error"], [role="alert"])').length,
        }))).toEqual({ connected: ['ChatGPT', 'Claude'], failures: 0 });
      } finally {
        await page.close();
      }
    });
  });

  test('typing in a modal is not taken by the home page arriving behind it', async () => {
    await withGallery(async (gallery) => {
      const held: HTTPRequest[] = [];
      const page = await gallery.newPage();

      // A module only the home page needs is held, so the page behind the modal arrives once the owner is already
      // typing in the modal.
      await page.setViewport(VIEWPORTS.desktop);
      await page.setRequestInterception(true);
      page.on('request', (request) => detach(Effect.promise(async () => {
        if (/\/assets\/WorkspaceOverviewCard-[^/]+\.js$/u.test(new URL(request.url()).pathname)) held.push(request);
        else await request.continue();
      })));
      // Not `load`: the held code is preloaded, and the load event waits for it.
      await page.goto(`${gallery.origin}/gallery.html?frame=setupmodal&panel=providers`, { waitUntil: 'domcontentloaded' });

      try {
        await page.waitForSelector('[role="dialog"]');
        await settleAccountFixture(page);
        await page.waitForSelector('[data-chatgpt-connect]');
        await clickByText(page, '[data-chatgpt-connect] button', 'Sign in here', '[data-chatgpt-connect]');
        await page.waitForSelector('[data-chatgpt-way="here"] input');
        await page.focus('[data-chatgpt-way="here"] input');
        await page.keyboard.type('sk-');

        if (held.length === 0) throw new Error('nothing of the home page was held, so it could not arrive behind the modal');
        await Promise.all(held.splice(0).map(async (request) => request.continue()));
        await page.waitForSelector('#workspace-mission');
        // Typed on without touching anything: every key lands in the modal, none on the page that arrived.
        await page.keyboard.type('after-arrival');

        expect(await page.$eval('[data-chatgpt-way="here"] input', (input) => (input instanceof HTMLInputElement ? input.value : null)))
          .toBe('sk-after-arrival');
        expect(await page.$eval('#workspace-mission', (field) => (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement ? field.value : null)))
          .toBe('');
      } finally {
        await page.close();
      }
    });
  });

  test('a model listing that fails hides no provider, and says so with a retry', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'setupmodal&panel=providers&models=fail', 'dark', 'desktop');

      try {
        await page.waitForSelector('[role="dialog"]');
        await settleAccountFixture(page);
        await page.waitForSelector('[data-provider="Cloudflare AI"]');
        await page.waitForSelector('[data-settings-resource="your connected models"][data-resource-state="error"]');
        expect(await page.$('[data-provider="ChatGPT"]')).not.toBeNull();
      } finally {
        await page.close();
      }
    });
  });

  test('a second account of a provider is listed by name and offered as the default', async () => {
    await withGallery(async (gallery) => {
      const settings = await freshPage(gallery, 'usersettingsstate&section=providers', 'light', 'desktop');

      try {
        await settings.waitForSelector('[aria-label="Anthropic default account"]');
        const text = await settings.evaluate(() => document.body.textContent ?? '');
        expect(text).toContain('Anthropic · work');
        expect(text).toContain('anthropic.bearer@work');

        await settings.click('[aria-label="Anthropic default account"]');
        await settings.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));

        const offered = await settings.$$eval('[role="option"]', (nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => node.textContent?.trim()));
        expect(offered).toEqual(['main', 'work']);
      } finally {
        await settings.close();
      }
    });
  });

  // A custom endpoint's declared window is every listed model's window; blank is unknown and never saved as a value.
  test('an OpenAI-compatible endpoint saves its context window, holds Save on one that is not a whole number, and omits a blank one', async () => {
    await withGallery(async (gallery) => {
      const settings = await freshPage(gallery, 'usersettingsstate&section=providers', 'dark', 'desktop');

      const addEndpoint = async (name: string, window: string) => {
        await settings.click('input[placeholder^="Search providers"]');
        await settings.type('input[placeholder^="Search providers"]', 'OpenAI-compatible');
        await settings.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));
        await settings.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.checkVisibility())?.click());
        await settings.waitForSelector('input[aria-label="Endpoint name"]');
        await settings.type('input[aria-label="Endpoint name"]', name);
        await settings.type('input[aria-label="Base URL"]', 'http://localhost:8080/v1');
        await settings.type('input[aria-label="API key"]', 'sk-local');
        await settings.type('input[aria-label="Context window in tokens"]', window);
      };

      const saveEnabled = () => settings.$eval('form button[type="submit"]', (button) => button.disabled === false);

      const saved = async () => v.parse(v.record(v.string(), v.looseObject({ kind: v.string(), baseURL: v.string(), contextWindow: v.optional(v.number()) })),
        JSON.parse(await settings.evaluate(() => document.documentElement.dataset.gallerySavedCredentials ?? '{}')));

      try {
        await settings.waitForSelector('input[placeholder^="Search providers"]');
        await addEndpoint('local', '12.5');
        expect(await saveEnabled()).toBe(false);

        await settings.$eval('input[aria-label="Context window in tokens"]', (input) => { input.select(); });
        await settings.type('input[aria-label="Context window in tokens"]', '131072');
        expect(await saveEnabled()).toBe(true);
        await settings.click('form button[type="submit"]');
        await settings.waitForFunction(() => document.documentElement.dataset.gallerySavedCredentials?.includes('openai-compat.local') === true);

        await addEndpoint('remote', '');
        await settings.click('form button[type="submit"]');
        await settings.waitForFunction(() => document.documentElement.dataset.gallerySavedCredentials?.includes('openai-compat.remote') === true);

        const bodies = await saved();
        expect(bodies['openai-compat.local']).toMatchObject({ kind: 'openai-compat', baseURL: 'http://localhost:8080/v1', contextWindow: 131072 });
        expect(bodies['openai-compat.remote']).toMatchObject({ kind: 'openai-compat', baseURL: 'http://localhost:8080/v1' });
        expect(bodies['openai-compat.remote']).not.toHaveProperty('contextWindow');
      } finally {
        await settings.close();
      }
    });
  });

  test('the usage section lists each account across workspaces with its quota, and names a workspace it could not read', async () => {
    await withGallery(async (gallery) => {
      const usage = await freshPage(gallery, 'usersettingsstate&section=usage', 'dark', 'mobile');

      try {
        // The inputs are the gallery's `/api/user/usage`: four accounts (402, 214, 38 and 93 calls, the last with no
        // account), four workspaces read and `old-bot` not, and Claude's `work` account unreadable with its reason.
        await usage.waitForFunction(() => /\d+% used/.test(document.body.innerText));
        const lines = (await usage.evaluate(() => document.body.innerText)).split('\n');

        // Each line a pattern matches, with the numbers it read there.
        const read = (pattern: RegExp): { line: string; values: number[] }[] => lines.flatMap((line) => {
          const hit = pattern.exec(line);

          return hit === null ? [] : [{ line, values: hit.slice(1).map(Number) }];
        });

        // Every account is listed, the one with no account among them, and the count of workspaces read is said.
        expect(read(/×(\d+)/).map(({ values }) => values[0]).sort((a = 0, b = 0) => a - b)).toEqual([38, 93, 214, 402]);
        expect(read(/Across (\d+) workspace/).map(({ values }) => values[0])).toEqual([4]);

        // Each limit window's two shares make the whole, and each says when it resets.
        const shares = read(/(\d+)% used\D+(\d+)% left/);

        expect(shares.length).toBeGreaterThan(0);

        for (const { line, values: [used = NaN, left = NaN] } of shares) {
          expect(used + left).toBe(100);
          expect(line).toContain('reset');
        }

        // A metered credit adds up; an account's own quota leaves no more than its limit, and resets.
        const [credit] = read(/\$([\d.]+) used\D+\$([\d.]+) of \$([\d.]+) left/);
        const [spent = NaN, remaining = NaN, total = NaN] = credit?.values ?? [];

        expect(spent + remaining).toBeCloseTo(total, 2);
        const quotas = read(/(\d+) of (\d+) requests left/);

        expect(quotas.length).toBeGreaterThan(0);

        for (const { line, values: [left = NaN, limit = NaN] } of quotas) {
          expect(left).toBeLessThanOrEqual(limit);
          expect(line).toContain('reset');
        }

        // What could not be read is named, the account with the provider's own reason, not dropped.
        expect(lines.some((line) => line.includes('old-bot'))).toBe(true);
        expect(lines.some((line) => line.includes('work') && line.includes('HTTP 401'))).toBe(true);
      } finally {
        await usage.close();
      }
    });
  });

  test('setup asks for a default model from the connected ones, and saves it as the account default', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, `welcome&step=${String(ONBOARDING_STEP_IDS.indexOf('model'))}`, 'dark', 'desktop');

      try {
        await page.waitForSelector('[data-welcome-step="model"] [data-model-picker="Default model"]');
        await page.click('[data-welcome-step="model"] [data-model-picker="Default model"]');
        await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.checkVisibility()));
        await clickByText(page, '[role="option"]', 'Claude Opus 4.7');
        await page.waitForSelector('[data-default-model="anthropic/claude-opus-4-7"]');

        const saved = await page.evaluate(async () => {
          const envelope: unknown = await (await fetch('/api/user/profile-catalog')).json();

          return JSON.stringify(envelope);
        });

        expect(saved).toContain('"default":{"model":"anthropic/claude-opus-4-7"');
      } finally {
        await page.close();
      }
    });
  });

  test('setup offers an address from the name just given, checked as typed, and Next creates it with its mailbox', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'welcome', 'light', 'desktop');
      const field = '[data-welcome-step="mail"] [aria-label="Username"]';
      const shown = (id: string) => page.waitForFunction((want) => document.querySelector(`[data-welcome-step="${want}"]`)?.getAttribute('aria-hidden') !== 'true', {}, id);
      const nextDisabled = () => page.$$eval('button', (nodes) => nodes.some((node) => node.textContent?.trim() === 'Next' && node instanceof HTMLButtonElement && node.disabled));

      // Typed over what is there, as a person selects all and types.
      const retype = async (selector: string, text: string) => {
        await page.click(selector);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.type(selector, text);
      };

      try {
        await page.waitForSelector('[data-welcome-step="profile"] input');
        await retype('[data-welcome-step="profile"] input', 'Lucía Ferreira');
        await clickByText(page, 'button', 'Next');
        await shown('mail');
        await page.waitForSelector('[data-welcome-step="mail"] [data-mail-address-state="available"]');
        expect(await page.$eval(field, (input) => input instanceof HTMLInputElement ? input.value : '')).toBe('lucia');

        await retype(field, 'dana');
        await page.waitForSelector('[data-welcome-step="mail"] [data-mail-address-state="taken"]');
        expect(await nextDisabled()).toBe(true);

        await retype(field, 'lucia');
        await page.waitForSelector('[data-welcome-step="mail"] [data-mail-address-state="available"]');
        await clickByText(page, 'button', 'Next');
        await shown('providers');
        expect(await page.evaluate(() => document.documentElement.dataset.galleryMailCreated)).toBe('lucia@kinu.run');
      } finally {
        await page.close();
      }
    });
  });

  test('the address step can be passed by unmade, and a deployment with no mail never offers it', async () => {
    await withGallery(async (gallery) => {
      // One page at a time: a page behind another runs no animation frames, which its waits poll on.
      const skipped = await freshPage(gallery, `welcome&step=${String(ONBOARDING_STEP_IDS.indexOf('mail'))}`, 'dark', 'mobile');

      try {
        await skipped.waitForSelector('[data-welcome-step="mail"] [data-mail-address-state="available"]');
        await skipped.click('[data-mail-not-now]');
        await skipped.waitForFunction(() => document.querySelector('[data-welcome-step="providers"]')?.getAttribute('aria-hidden') !== 'true');
        expect(await skipped.evaluate(() => document.documentElement.dataset.galleryMailCreated ?? null)).toBeNull();
      } finally {
        await skipped.close();
      }

      const off = await freshPage(gallery, 'welcome&mail=off', 'dark', 'mobile');

      try {
        await off.waitForSelector('[data-welcome-step="profile"]');
        await off.waitForFunction((count) => document.querySelectorAll('[aria-label="Setup steps"] li').length === count, {}, ONBOARDING_STEP_IDS.length - 1);
        expect(await off.$('[data-welcome-step="mail"]')).toBeNull();
      } finally {
        await off.close();
      }
    });
  });

  test('setup offers tools to connect, and every step can be passed by', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'welcome&step=1', 'light', 'mobile');

      try {
        for (const id of ONBOARDING_STEP_IDS.slice(1)) {
          await page.waitForFunction((want) => document.querySelector(`[data-welcome-step="${want}"]`)?.getAttribute('aria-hidden') !== 'true', {}, id);

          if (id === 'tools') await page.waitForSelector('[data-welcome-step="tools"] [data-plugin-source]');

          // The address it offers is checked first: Next creates it once it reads available.
          if (id === 'mail') await page.waitForSelector('[data-welcome-step="mail"] [data-mail-address-state="available"]');

          // Web search opens on the default already chosen, so Next passes it with nothing to pick.
          if (id === 'search') await page.waitForSelector('[data-welcome-step="search"] [data-web-search-tile="cloudflare"] input:checked');

          if (id !== 'showcase') await clickByText(page, 'button', 'Next');
        }

        expect(await page.$$eval('button', (nodes) => nodes.some((node) => node.textContent?.trim() === 'Finish setup'))).toBe(true);
      } finally {
        await page.close();
      }
    });
  });

  // Production, 2026-10-08: connecting Cloudflare during setup ended on the setup's first step, in a new tab.
  // The owner's report (2026-10-20): connecting a service during setup left its tab open, landed on setup's first step.
  test('connecting a service from setup\'s tools step: its tab closes, and the step shows it connected', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, `welcome&route=${encodeURIComponent('/welcome?step=tools')}`, 'dark', 'desktop');

      try {
        const tools = '[data-welcome-step="tools"]';

        // The wizard opens on the step its address names.
        await page.waitForFunction((at) => document.querySelector(at)?.getAttribute('aria-hidden') !== 'true', {}, tools);
        const row = `${tools} [data-plugin-source="cloudflare"]`;
        await page.waitForSelector(`${row} [data-plugin-add]`);
        const at = page.url();
        const opened = page.browser().waitForTarget((target) => target.opener() === page.target());
        await page.click(`${row} [data-plugin-add]`);
        const helperPage = await (await opened).page();

        if (helperPage === null) throw new Error('the connect opened no tab');
        const closed = new Promise<void>((resolve) => { helperPage.once('close', () => { resolve(); }); });

        // The provider's consent page: approved, its callback sends the tab to the finish page.
        await helperPage.waitForSelector('[data-authorize="approve"]');
        await helperPage.click('[data-authorize="approve"]');
        await closed;
        await page.waitForSelector(`${row}[data-plugin-state="Connected"]`);

        // Updated in place: the same step, the same address, no reload.
        expect({ shown: await page.$eval(tools, (step) => step.getAttribute('aria-hidden') !== 'true'), at: page.url() })
          .toEqual({ shown: true, at });
      } finally {
        await page.close();
      }
    });
  });

  // Its address names a service and nothing to go to: a `next` someone wrote into it, off this site or not, is not read.
  test('a finish page no script opened says the service connected and stays, never routing into the app', async () => {
    await withGallery(async (gallery) => {
      const page = await gallery.newPage();
      const at = '?frame=connected&service=Cloudflare&next=%2F%2Fevil.example';

      try {
        await page.goto(`${gallery.origin}/gallery.html${at}`, { waitUntil: 'load' });
        await page.waitForFunction(() => document.body.textContent?.includes('You can close this tab') === true);

        expect({ said: (await page.$eval('[data-connect-finished]', (node) => node.textContent ?? '')).trim(), at: new URL(page.url()).search })
          .toEqual({ said: 'Connected to Cloudflare. You can close this tab.', at });
      } finally {
        await page.close();
      }
    });
  });

  // Production, 2026-10-08: its one sign-in, Cloudflare, shares no name for most accounts; nothing guesses one.
  test('an account its provider shared no name for starts blank, says which provider, wears its email\'s letter, and saves no empty name', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'welcome&step=0&noname=1', 'dark', 'desktop');

      try {
        await page.waitForSelector('[aria-label="Your name"]');
        expect(await page.$eval('[aria-label="Your name"]', (el) => (el instanceof HTMLInputElement ? el.value : null))).toBe('');
        expect(await page.$eval('[data-welcome-step="profile"] [data-avatar]', (el) => el.textContent?.trim())).toBe('N');
        await page.waitForFunction(() => (document.querySelector('[data-welcome-step="profile"]')?.textContent ?? '').includes('Cloudflare'));

        // Typed and cleared again: Next moves on, and no empty name reaches the account.
        await page.type('[aria-label="Your name"]', 'x');
        await page.keyboard.press('Backspace');
        await clickByText(page, 'button', 'Next');
        await page.waitForFunction(() => document.querySelector('[data-welcome-step="profile"]')?.getAttribute('aria-hidden') === 'true');
        expect(await page.evaluate(() => document.documentElement.dataset.galleryProfilePatches ?? '0')).toBe('0');
      } finally {
        await page.close();
      }
    });
  });

  test('the account section names the owner and arms the delete only on the typed email', async () => {
    await withGallery(async (gallery) => {
      

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const page = await freshPage(gallery, 'usersettingsstate&section=account', theme, viewport);

          try {
            await page.waitForSelector('[aria-label="Your name"]');
            const body = await page.evaluate(() => document.body.innerText);
            expect(body).toContain('owner@example.com');
            expect(body).toContain('Delete this account');
            

            // The danger button sleeps until the phrase is the account's own
            // email; a wrong phrase leaves it asleep, and case does not count.
            await page.evaluate(() => {
              const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Delete account'));

              if (button === undefined) throw new Error('no delete button');
              button.click();
            });
            await page.waitForSelector('[aria-label="Confirm your email"]');

            expect(await page.evaluate(deleteArmed)).toBe(false);
            await page.type('[aria-label="Confirm your email"]', 'someone@else.com');
            expect(await page.evaluate(deleteArmed)).toBe(false);
            await page.$eval('[aria-label="Confirm your email"]', (input) => { if (input instanceof HTMLInputElement) input.value = ''; });
            await page.type('[aria-label="Confirm your email"]', 'Owner@Example.com');
            await page.waitForFunction(deleteArmed);
            expect(await page.evaluate(deleteArmed)).toBe(true);
            
          } finally {
            await page.close();
          }
        }
      }

      
    });
  });

  test('the primary nav, the workspaces page, the plugins page and the Shared tab render at both widths in both themes', async () => {
    await withGallery(async (gallery) => {
      

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          // The nav lives inside the existing rail, which the phone keeps in a
          // drawer: its links are asserted at desktop width, where it is drawn.
          if (viewport === 'desktop') {
            const home = await freshPage(gallery, 'home', theme, viewport);

            try {
              await home.waitForSelector('nav[aria-label="Primary"] a[aria-current="page"]');

              const links = await home.$$eval('nav[aria-label="Primary"] a', (anchors) =>
                anchors.map((a) => ({ href: a.getAttribute('href'), current: a.getAttribute('aria-current') })));

              // Settings, Mail and Devices are the sidebar footer's: the account
              // menu, and the icons beside it. The nav carries no row for them.
              expect(links.map((link) => link.href).sort((left, right) => String(left).localeCompare(String(right)))).toEqual(['/', '/drive', '/explore', '/plugins', '/workspaces']);
              expect(links[0]?.current).toBe('page');
              expect(await activeNavRow(home)).toBe('Home');
              // The rail's own furniture is untouched around it: the account
              // menu in its footer, the roster eyebrow above the rows.
              const rail = await home.evaluate(() => document.querySelector('aside')?.innerText ?? '');
              expect(rail).toContain('WORKSPACES');
              expect(rail).toContain('API Worker');
              expect(await home.$('aside [data-account-menu]')).not.toBeNull();
              

              // The row under the pointer is painted too, but never as the open row: not its ground, not its ink,
              // and never touching it. Lit alike and 2 px apart, the two once read as one block.
              await home.hover('nav[aria-label="Primary"] a[href="/workspaces"]');
              const rows = await navPaint(home);
              const open = rows.find((row) => row.label === 'Home');
              const hovered = rows.find((row) => row.label === 'Workspaces');
              const resting = rows.find((row) => row.label === 'Plugins');

              expect(hovered?.background).not.toBe(resting?.background);
              expect(hovered?.background).not.toBe(open?.background);
              expect(hovered?.ink).not.toBe(open?.ink);
              expect(hovered?.top ?? Number.NaN).toBeGreaterThan(open?.bottom ?? Number.NaN);
            } finally {
              await home.close();
            }
          }

          for (const view of ['list', 'tiled'] as const) {
            const page = await freshPage(gallery, view === 'list' ? 'workspaces&view=list' : 'workspaces', theme, viewport);

            try {
              await checkWorkspacesView(page, view, viewport);
            } finally {
              await page.close();
            }
          }

          const plugins = await freshPage(gallery, 'plugins', theme, viewport);

          try {
            await plugins.waitForFunction(
              () => document.querySelectorAll('[data-plugin]').length >= 4,
            );
            const body = await plugins.evaluate(() => document.body.innerText);

            // Section eyebrows are uppercased by the CSS role, and innerText
            // reads them as drawn.
            for (const text of ['MCP SERVERS', 'github', 'Needs sign-in']) {
              expect(body.toLowerCase()).toContain(text.toLowerCase());
            }

            if (viewport === 'desktop') expect(await activeNavRow(plugins)).toBe('Plugins');
            
            await plugins.evaluate(() => {
              const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Manage');

              if (button === undefined) throw new Error('no manage button');
              button.click();
            });
            await plugins.waitForSelector('[role="dialog"]');
            expect(await dialogText(plugins)).toContain('Add custom server');
          } finally {
            await plugins.close();
          }

          const devices = await freshPage(gallery, 'devices', theme, viewport);

          try {
            await devices.waitForFunction(() => document.body.innerText.includes('Workstation'));
            const body = await devices.evaluate(() => document.body.innerText);

            // Each machine's link state, then the grant state per workspace.
            for (const text of ['Workstation', 'connected', 'Owner laptop', 'offline', 'api-worker', 'Denied']) {
              expect(body.toLowerCase()).toContain(text.toLowerCase());
            }

            // Devices is the footer's icon, not a nav row: the icon is the open page, and no nav row is.
            if (viewport === 'desktop') {
              expect(await devices.$('[data-footer-devices][aria-current="page"]')).not.toBeNull();
              expect(await devices.$$('nav[aria-label="Primary"] a[aria-current="page"]')).toHaveLength(0);
            }
            
          } finally {
            await devices.close();
          }

          const shared = await freshPage(gallery, 'shared', theme, viewport);

          try {
            await shared.waitForSelector('[data-drive-section="Shared with you"]');
            const body = await shared.evaluate(() => document.body.innerText);

            // The Drive's third place, after My stuff and Slates, in its column or below `lg` its switch: what others shared first, then what the owner shared.
            const place = viewport === 'desktop' ? 'data-drive-place' : 'data-drive-tab';

            expect(await shared.$$eval(`[${place}]`, (tabs, name) => tabs.map((tab) => [tab.getAttribute(name), tab.getAttribute('aria-current')]), place))
              .toEqual([['mine', null], ['slates', null], ['shared', 'page']]);
            expect(body.indexOf('Shared with you')).toBeLessThan(body.indexOf('Shared by you'));

            // The Drive row stays lit on /shared: it is the Drive, not another page.
            if (viewport === 'desktop') expect(await activeNavRow(shared)).toBe('Drive');
            
          } finally {
            await shared.close();
          }
        }
      }

      
    });
  });
});

/** A machine's Sandbox switch is its setting: turning it off drops the GPU line and survives a reload, and a machine
 *  linked from / cannot claim a sandbox it does not have. */
describe('a machine\'s Sandbox switch on the Devices page', () => {
  test('it turns off, takes the GPU with it, stays off after a reload; a whole-machine link cannot turn it on', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'devices', 'dark', 'desktop');
      const workstation = 'button[role="switch"][aria-label="Sandbox on Workstation"]';

      const row = () => page.$eval(workstation, (button) => ({
        on: button.getAttribute('aria-checked'),
        gpu: (button.closest('li, [data-device]') ?? button.parentElement?.parentElement?.parentElement)?.textContent?.includes('GPU:') ?? false,
      }));

      try {
        await page.evaluate(() => localStorage.removeItem('gallery-device-tier'));
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector(workstation);
        expect(await row()).toEqual({ on: 'true', gpu: true });

        // Turning it off is asked first, in the page: the agent would run as the person, with full access.
        await page.click(workstation);
        await page.waitForSelector('[role="dialog"]');
        expect(await page.$eval('[role="dialog"]', (dialog) => dialog.textContent ?? '')).toContain('full access');
        await clickByText(page, '[role="dialog"] button', 'Turn off');
        await page.waitForFunction((at) => document.querySelector(at)?.getAttribute('aria-checked') === 'false', {}, workstation);
        expect(await row()).toEqual({ on: 'false', gpu: false });

        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector(workstation);
        expect((await row()).on).toBe('false');

        expect(await page.$eval('button[role="switch"][aria-label="Sandbox on Owner laptop"]', (button) => button instanceof HTMLButtonElement && button.disabled)).toBe(true);
      } finally {
        await page.evaluate(() => localStorage.removeItem('gallery-device-tier'));
        await page.close();
      }
    });
  });
});

describe('what the Devices page says about a machine\'s history', () => {
  test('a refused update names its reason, and a machine listed before sandboxes were recorded still lists, switch on', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'devices&devices=history', 'dark', 'desktop');

      try {
        await page.waitForSelector('button[role="switch"][aria-label="Sandbox on Old box"]');
        expect(await page.evaluate(() => document.body.innerText)).toContain('Bun 1.4.2 install failed: permission denied');
        expect(await page.$eval('button[role="switch"][aria-label="Sandbox on Old box"]', (button) => button.getAttribute('aria-checked'))).toBe('true');
      } finally {
        await page.close();
      }
    });
  });
});

const MEMORY_SHOTS = evidenceDir('account-memory');

// rc28 walkthrough: Models was headed Models twice, its card under the section's own heading.
describe('Settings sections', () => {
  test("each is named once: no panel under a section's heading carries that heading again", async () => {
    await withGallery(async (gallery) => {
      const rail = await freshPage(gallery, 'usersettingsstate', 'dark', 'desktop');
      const sections = await rail.$$eval('[data-settings-section]', (links) => links.map((link) => link.getAttribute('data-settings-section') ?? ''));

      await rail.close();
      expect(sections.length).toBeGreaterThan(1);

      const repeated: string[] = [];

      for (const section of sections) {
        const page = await freshPage(gallery, `usersettingsstate&section=${section}`, 'dark', 'desktop');

        try {
          await page.waitForSelector(`[data-settings-section="${section}"][aria-current="true"]`);
          await page.waitForSelector('[data-settings-head] h2');
          await settleAccountFixture(page);
          repeated.push(...await page.evaluate((name) => {
            const heading = document.querySelector('[data-settings-head] h2')?.textContent?.trim() ?? '';
            const panels = [...document.querySelectorAll('h2, h3')].filter((title) => title.closest('[data-settings-head]') === null);

            return panels.filter((title) => title.textContent?.trim() === heading).map(() => `${name}: ${heading}`);
          }, section));
        } finally {
          await page.close();
        }
      }

      expect(repeated).toEqual([]);
    });
  });
});

describe('Settings → Memory', () => {
  test('lists what waits on the owner, each kept fact with who said it, its revisions, and the notes, at both widths', async () => {
    await withGallery(async (gallery) => {
      mkdirSync(MEMORY_SHOTS, { recursive: true });

      for (const viewport of ['desktop', 'mobile'] as const) {
        const page = await freshPage(gallery, 'usersettingsstate&section=memory&memory=timezone', 'light', viewport);

        try {
          await page.waitForSelector('[data-account-memory]');
          await page.click('[data-account-memory-fact="reply_language"] button[aria-expanded]');
          await page.waitForSelector('[data-account-memory-history="reply_language"]');
          const text = await page.$eval('[data-account-memory]', (node) => node.textContent ?? '');

          expect(text).toContain('Waiting for you');
          expect(text).toContain('Keep for every workspace');
          expect(text).toContain('Noticed in API Worker in your own words');
          expect(text).toContain('Said in Support inbox, kept by main');
          expect(text).toContain('You promoted it from API Worker');
          expect(text).toContain('Invoices go to accounts@example.com');

          const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));

          expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
          await page.screenshot({ path: join(MEMORY_SHOTS, `settings-memory-${viewport}.png`), fullPage: true });
        } finally {
          await page.close();
        }
      }
    });
  });

  // 26244c765 review: a proposal kept from the attention stack left Settings' facts as they were; the account's
  // frame now reads the whole memory again.
  test('a proposal kept elsewhere is a kept fact in Settings at once', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'usersettingsstate&section=memory&memory=waiting', 'light', 'desktop');

      try {
        await page.waitForSelector('[data-account-memory-proposal="amp_city"]');
        expect(await page.$('[data-account-memory-fact="owner_city"]')).toBeNull();

        // Kept as the stack keeps it: the route, not this page's button.
        await page.evaluate(async () => {
          await fetch('/api/user/memory/proposals/amp_city', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accept' }) });
        });
        await page.waitForSelector('[data-account-memory-fact="owner_city"]');
        expect(await page.$('[data-account-memory-proposal="amp_city"]')).toBeNull();
      } finally {
        await page.close();
      }
    });
  });

  // e83e0797e review: with the roster upgrade refused, what waits was the first read for good, so a proposal kept here
  // stayed on the list after Settings read the memory again.
  test('a proposal kept in Settings leaves what waits when the roster socket cannot open', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'usersettingsstate&section=memory&memory=waiting&rosterSocket=refused', 'light', 'desktop');

      try {
        await page.waitForSelector('[data-account-memory-proposal="amp_city"] button');
        await page.click('[data-account-memory-proposal="amp_city"] button');
        await page.waitForSelector('[data-account-memory-fact="owner_city"]');
        await page.waitForFunction(() => document.querySelector('[data-account-memory-proposal="amp_city"]') === null);
      } finally {
        await page.close();
      }
    });
  });

  // 26244c765: Settings kept its own copy of what waits, read once, so a proposal filed while it was open never showed.
  test('a proposal filed while Settings is open joins what waits, as the attention stack shows it', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'usersettingsstate&section=memory&memory=timezone', 'light', 'desktop');

      try {
        await page.waitForSelector('[data-account-memory-proposal="amp_1"]');
        await page.evaluate(() => { window.dispatchEvent(new Event('gallery:memory-proposal')); });
        await page.waitForSelector('[data-account-memory-proposal="amp_city"]');
        expect(await page.$$eval('[data-account-memory-proposal]', (rows) => rows.map((row) => row.getAttribute('data-account-memory-proposal'))))
          .toEqual(['amp_1', 'amp_city']);
      } finally {
        await page.close();
      }
    });
  });

  // 26244c765: Settings read the profile beside the shell's read and read it again after a save, so the shell kept
  // the old name until its own next read.
  test('Settings shows the shell\'s account, and a saved name is that account at once', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'usersettingsstate&shell=1', 'light', 'desktop');

      try {
        await page.waitForSelector('input[aria-label="Your name"]');
        // Settings is one reader of the shell's account; no other surface shows the name, so the frame mounts one.
        const held = () => page.$eval('[data-gallery-account-name]', (reader) => reader.textContent);

        expect(await held()).toBe('Owner');
        const reads = () => page.evaluate(() => Number(document.documentElement.dataset.galleryProfileReads ?? '0'));

        const before = await reads();

        await page.click('input[aria-label="Your name"]', { count: 3 });
        await page.keyboard.type('Ada');
        await page.$$eval('button', (buttons) => buttons.find((button) => button.textContent?.trim() === 'Save')?.click());
        await page.waitForFunction(() => document.documentElement.dataset.galleryProfilePatches === '1');
        // Saved once the name can be edited again: the account takes the answer in that render. Save alone is disabled
        // from the press, while the patch is out, so a read then saw the old name (tier, b69e13df2: "Owner").
        await page.waitForSelector('input[aria-label="Your name"]:not(:disabled)');
        await page.waitForFunction(() => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save')?.disabled === true);
        // The saved profile is the account's answer: nothing reads it again, and every reader holds it at once.
        expect(await reads()).toBe(before);
        expect(await held()).toBe('Ada');
      } finally {
        await page.close();
      }
    });
  });
});
