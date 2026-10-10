/** Real-browser account panels, viewport boundaries, deletion confirmation and workspace navigation. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { ONBOARDING_STEPS } from '@kinu.run/core';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

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

/** Presses the control whose words begin with `words`, as a reader finds it. */
async function clickByText(page: Page, selector: string, words: string): Promise<void> {
  await page.waitForFunction((sel, text) => [...document.querySelectorAll(sel)].some((node) => (node.textContent ?? '').trim().startsWith(text)), {}, selector, words);
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

/** Workspace entries are complete, the current route is marked, and filters return the requested entries. */
async function checkWorkspacesView(page: Page, view: 'list' | 'tiled', viewport: keyof typeof VIEWPORTS): Promise<void> {
  await page.waitForSelector('[aria-label="Search workspaces"]');
  const body = await page.evaluate(() => document.body.innerText);
  expect(body).toContain('Workspaces');

  for (const name of ['Storefront', 'Dew', 'Support inbox', 'Kinu website']) {
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

  // The filter tabs and the page's own create action sit in the control row;
  // the count is a tabular "N of M", not a sentence.
  const tabs = await page.$$eval('[aria-label="Workspace state"] [role="tab"]', (els) => els.map((el) => el.getAttribute('data-segment')));
  expect(tabs).toEqual(['all', 'needs', 'working', 'idle']);
  expect(await page.$$eval('main button', (buttons) => buttons.filter((button) => button.textContent?.trim() === 'New workspace').length)).toBe(1);
  expect(body2).toContain('5 of 5');

  if (viewport === 'desktop') expect(await activeNavRow(page)).toBe('Workspaces');

  // 'Needs you' holds exactly the workspace whose decisions wait.
  await page.click('[data-segment="needs"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-workspaces-view] a').length === 1,
  );
  expect(await page.$eval('[data-workspaces-view] a', (a) => a.textContent ?? '')).toContain('Storefront');
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
              () => document.querySelector('[role="dialog"]')?.textContent?.includes('auth needed'),
            );

            const text = await dialogText(mcp);
            expect(text).toContain('github');
            expect(text).toContain('Add custom server');
            expect(text).toContain('auth needed');

            // A status the layout pushed sideways is textContent that passes
            // while nothing is on screen: the badge must sit inside the
            // dialog's box with nothing between it and the dialog scrolled.
            const statusVisible = await mcp.evaluate(() => {
              const dialog = document.querySelector('[role="dialog"]');

              if (dialog === null) return false;

              const badge = [...dialog.querySelectorAll('span')].find((span) => span.textContent?.includes('auth needed'));

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

  test('ChatGPT connects two ways: a machine gets its connect command, and an address pasted back here signs in', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'setupmodal&panel=providers', 'dark', 'desktop');

      try {
        await page.waitForSelector('[role="dialog"]');
        await settleAccountFixture(page);
        await page.waitForSelector('[data-chatgpt-connect]');

        // No machine is connected: choosing the PC hands the command that installs Kinu and connects it.
        await clickByText(page, '[data-chatgpt-connect] button', 'Use your PC');
        await page.waitForSelector('[data-chatgpt-way="pc"] [data-connect-command]');
        expect(await page.$eval('[data-connect-command]', (code) => code.textContent ?? '')).toContain('--connect');
        await clickByText(page, '[data-chatgpt-connect] button', 'Cancel');

        // Here: the sign-in opens at OpenAI, and the address the browser lands on is pasted back. A sign-in
        // cancelled at OpenAI is spent: starting again fetches a fresh link and clears the old address.
        await clickByText(page, '[data-chatgpt-connect] button', 'Sign in here');
        await page.waitForSelector('[data-chatgpt-way="here"] input');
        await page.type('[data-chatgpt-way="here"] input', 'http://127.0.0.1:1455/auth/callback?error=access_denied&state=xyz');
        await clickByText(page, '[data-chatgpt-way="here"] button', 'Finish');
        const starts = await page.evaluate(() => Number(document.documentElement.dataset.galleryPasteStarts ?? '0'));
        await clickByText(page, '[data-chatgpt-way="here"] button', 'Start again');
        await page.waitForFunction((before) => Number(document.documentElement.dataset.galleryPasteStarts ?? '0') > before, {}, starts);
        await page.waitForSelector('[data-chatgpt-way="here"] input');
        expect(await page.$eval('[data-chatgpt-way="here"] input', (input) => input.value)).toBe('');

        await page.type('[data-chatgpt-way="here"] input', 'http://127.0.0.1:1455/auth/callback?code=abc&state=xyz');
        await clickByText(page, '[data-chatgpt-way="here"] button', 'Finish');
        // Signed in: the row says so at once, before anything else is touched, and the welcome says what it means.
        await page.waitForFunction(() => document.querySelector('[data-provider="ChatGPT"]')?.textContent?.includes('Connected') === true
          && document.querySelector('[data-chatgpt-connect]') === null);
        await page.waitForFunction(() => document.body.textContent?.includes("You're using your ChatGPT plan") === true);
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

  test('setup offers tools to connect, and every step can be passed by', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'welcome&step=1', 'light', 'mobile');

      try {
        for (const id of ['providers', 'model', 'tools', 'showcase']) {
          await page.waitForFunction((want) => document.querySelector(`[data-welcome-step="${want}"]`)?.getAttribute('aria-hidden') !== 'true', {}, id);

          if (id === 'tools') await page.waitForSelector('[data-welcome-step="tools"] [data-plugin-source]');

          if (id !== 'showcase') await clickByText(page, 'button', 'Next');
        }

        expect(await page.$$eval('button', (nodes) => nodes.some((node) => node.textContent?.trim() === 'Finish setup'))).toBe(true);
      } finally {
        await page.close();
      }
    });
  });

  // Production, 2026-10-08: connecting Cloudflare during setup ended on the setup's first step, in a new tab.
  test('connecting Cloudflare runs in a helper window that closes itself, and setup returns to the step it was on', async () => {
    await withGallery(async (gallery) => {
      const route = '/welcome?step=providers';
      const page = await freshPage(gallery, `welcome&cloudflare=off&route=${encodeURIComponent(route)}`, 'dark', 'desktop');

      try {
        // The wizard opens on the step its address names, as a sign-in returning to it reads it.
        await page.waitForFunction(() => document.querySelector('[data-welcome-step="providers"]')?.getAttribute('aria-hidden') !== 'true');

        // The connect a reader sees on this step: the one drawn, of the links into Cloudflare's sign-in.
        const connect = '[data-welcome-step="providers"] a[href*="/auth/cloudflare/start"]';
        await page.waitForFunction((links) => [...document.querySelectorAll(links)].some((link) => link.getClientRects().length > 0), {}, connect);
        const opened = page.browser().waitForTarget((target) => target.opener() === page.target() && target.url().includes('/auth/cloudflare/start'));

        await page.evaluate((links) => {
          const link = [...document.querySelectorAll(links)].find((each) => each.getClientRects().length > 0);

          if (link instanceof HTMLElement) link.click();
        }, connect);
        const helper = await opened;

        // The sign-in is told to end on the connected page, and that page to send the owner back to this step.
        const started = new URL(helper.url());
        expect({ path: started.pathname, ends: started.searchParams.get('return_to') })
          .toEqual({ path: '/auth/cloudflare/start', ends: `/connected?${new URLSearchParams({ next: route }).toString()}` });

        const helperPage = await helper.page();

        if (helperPage === null) throw new Error('the helper window has no page');
        const closed = new Promise<void>((resolve) => { helperPage.once('close', () => { resolve(); }); });

        const back = page.waitForRequest((request) => request.isNavigationRequest() && request.frame() === page.mainFrame());

        // Where Cloudflare sends the helper once the owner has signed in.
        await Promise.allSettled([helperPage.goto(`${gallery.origin}/gallery.html?frame=connected&next=${encodeURIComponent(route)}`)]);
        await closed;
        const returned = new URL((await back).url());

        expect(`${returned.pathname}${returned.search}`).toBe(route);
      } finally {
        await page.close();
      }
    });
  });

  test('a sign-in that ends in a tab the browser opened sends that tab to the step it began on', async () => {
    await withGallery(async (gallery) => {
      const route = '/welcome?step=providers';
      const page = await gallery.newPage();

      try {
        // Not a window this page's script opened, so it may not close itself: it goes where the connect began.
        const onward = page.waitForRequest((request) => request.isNavigationRequest() && !request.url().includes('frame=connected'));
        // The page leaves as soon as it has drawn, so its own load may be cut short.
        await Promise.allSettled([page.goto(`${gallery.origin}/gallery.html?frame=connected&next=${encodeURIComponent(route)}`, { waitUntil: 'load' })]);
        const reached = new URL((await onward).url());

        expect(`${reached.pathname}${reached.search}`).toBe(route);
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

              // Account settings is reached from the gear at the foot of the
              // rail, so the nav carries no row of its own for it.
              expect(links.map((link) => link.href).sort((left, right) => String(left).localeCompare(String(right)))).toEqual(['/', '/devices', '/drive', '/plugins', '/workspaces']);
              expect(links[0]?.current).toBe('page');
              expect(await activeNavRow(home)).toBe('Home');
              // The rail's own furniture is untouched around it: the roster
              // eyebrow above the rows, the account row at the foot. (The New
              // workspace button is absent on the home route by design.)
              const rail = await home.evaluate(() => document.querySelector('aside')?.innerText ?? '');
              expect(rail).toContain('WORKSPACES');
              expect(rail).toContain('Storefront');
              expect(rail).toContain('ashish@example.com');
              

              // The row under the pointer is painted too, but never as the open row: not its ground, not its ink,
              // and never touching it. Lit alike and 2 px apart, the two once read as one block.
              await home.hover('nav[aria-label="Primary"] a[href="/workspaces"]');
              const rows = await navPaint(home);
              const open = rows.find((row) => row.label === 'Home');
              const hovered = rows.find((row) => row.label === 'Workspaces');
              const resting = rows.find((row) => row.label === 'Devices');

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
            for (const text of ['MCP SERVERS', 'github', 'auth needed']) {
              expect(body).toContain(text);
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
            for (const text of ['Workstation', 'connected', 'Owner laptop', 'offline', 'checkout-fixes', 'Denied']) {
              expect(body).toContain(text);
            }

            if (viewport === 'desktop') expect(await activeNavRow(devices)).toBe('Devices');
            
          } finally {
            await devices.close();
          }

          const shared = await freshPage(gallery, 'shared', theme, viewport);

          try {
            await shared.waitForSelector('[data-drive-section="Shared with you"]');
            const body = await shared.evaluate(() => document.body.innerText);

            // The Drive's second tab: what others shared first, then what the owner shared.
            expect(await shared.$$eval('[data-drive-tab]', (tabs) => tabs.map((tab) => [tab.getAttribute('data-drive-tab'), tab.getAttribute('aria-current')])))
              .toEqual([['mine', null], ['shared', 'page']]);
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

const MEMORY_SHOTS = join(import.meta.dir, '..', '..', '..', 'kinu-logs', 'account-memory');

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
          expect(text).toContain('Noticed in Storefront in your own words');
          expect(text).toContain('Said in Support inbox, kept by main');
          expect(text).toContain('You promoted it from Storefront');
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
