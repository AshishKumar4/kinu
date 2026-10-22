/** Real-browser MCP preset addition, authorization and account holdings at both widths and themes. */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { Page } from 'puppeteer';
import type { JsonValue } from '@kinu.run/core';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';
import { OPEN_MENU, openRowMenu, pressRowMenu, ROW_MENU } from '../../scripts/browser-page';


const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'load' });

  return page;
}


/** The state word one preset row is in. */
const presetStatus = (page: Page, id: string): Promise<string> =>
  page.$eval(`[data-plugin-source="${id}"]`, (el) => el.getAttribute('data-plugin-state') ?? '');

/** Every row the page draws, as a reader meets it: the name it claims, the
 *  text inside it, how many controls its trailing slot offers, and whether a
 *  preset drew it. */
function drawnRows(page: Page): Promise<{ name: string; text: string; buttons: number; preset: boolean }[]> {
  return page.$$eval('[data-plugin]', (nodes) => nodes.map((node) => ({
    name: node.getAttribute('data-plugin') ?? '',
    text: node.textContent ?? '',
    buttons: node.querySelectorAll('button').length,
    preset: node.hasAttribute('data-plugin-source'),
  })));
}

/** Where the tab a click on `selector` opens is sent: the sign-in address the server answered for the card, in a real
 *  tab. The fixture's addresses are this origin's, so nothing past it loads; the tab is closed once it is sent. The
 *  sign-in itself, approved, declined and run again, runs through the Worker in live-app-connect.test.ts. */
async function signInTab(page: Page, selector: string): Promise<string> {
  const opened = page.browser().waitForTarget((target) => target.opener() === page.target());

  await page.click(selector);
  const target = await opened;
  const sent = await page.browser().waitForTarget((each) => each === target && each.url() !== 'about:blank');

  await (await target.page())?.close();

  return new URL(sent.url()).pathname;
}

/** The runs each sign-in the page began was begun for, oldest first, as the fixture recorded their POSTs. */
async function begunRuns(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => localStorage.getItem('gallery-mcp-connects') ?? '');

  return raw.split('\n').filter((line) => line !== '').map((line) => v.parse(v.pipe(v.string(), v.parseJson(), v.object({ run: v.pipe(v.string(), v.uuid()) })), line).run);
}

/** The names in the Connected list, in the order it draws them. */
function connectedList(page: Page): Promise<string[]> {
  return page.$$eval('section[aria-label="Connected"] [data-plugin]',
    (nodes) => nodes.map((node) => node.getAttribute('data-plugin') ?? ''));
}

/** The body the fixture recorded for the page's add POST. The fixture writes
 *  it as JSON; the caller's valibot schema is what shapes the field it needs. */
async function lastMcpAdd(page: Page): Promise<JsonValue> {
  await page.waitForFunction(
    () => localStorage.getItem('gallery-mcp-add') !== null,
  );

  return page.evaluate(() => {
    const raw = localStorage.getItem('gallery-mcp-add');

    return raw === null ? null : JSON.parse(raw);
  });
}

describe('MCP presets', () => {
  test('the plugins page renders all three preset rows Not added, and the add control adds via the RPC', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'plugins', 'dark', 'desktop');

      try {
        await page.waitForSelector('[data-plugin-source="github"]');
        await page.waitForFunction(
          () => document.querySelector('[data-plugin-source="cloudflare"]')?.getAttribute('data-plugin-state') === 'Not added',
        );

        expect(await presetStatus(page, 'github')).toBe('Not added');
        expect(await presetStatus(page, 'cloudflare')).toBe('Not added');
        expect(await presetStatus(page, 'google')).toBe('Not added');

        // Cloudflare is the OAuth preset: one click posts the add, begins its sign-in for a run of the page's own, and
        // sends a tab of its own to the address the server answered.
        const sentTo = await signInTab(page, '[data-plugin-source="cloudflare"] [data-plugin-add]');
        const add = v.parse(v.object({ presetId: v.literal('cloudflare') }), await lastMcpAdd(page));

        expect({ add: add.presetId, sentTo, runs: (await begunRuns(page)).length }).toEqual({ add: 'cloudflare', sentTo: expect.stringMatching(/^\/gallery-sign-in\/srv-add-\d+$/u), runs: 1 });

        // The status the next list read reports, while the sign-in waits.
        await page.waitForFunction(
          () => document.querySelector('[data-plugin-source="cloudflare"]')?.getAttribute('data-plugin-state') === 'Needs sign-in',
        );

        // The added server moves to what the account holds, and the page
        // still draws it once: its own preset row, under Connected alone.
        await page.waitForFunction(() => document.querySelector('section[aria-label="Connected"] [data-plugin="Cloudflare"]') !== null);
        expect(await page.$$('[data-plugin="Cloudflare"]')).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
  });

  test('a token preset opens one field and posts it as the bearer header', async () => {
    await withGallery(async (gallery) => {
      // GitHub without its app: the row falls back to the PAT field. Google
      // stays configured so the split is observable on one page.
      const page = await freshPage(gallery, 'plugins&mcp-preset=open&mcp-secrets=google', 'dark', 'desktop');

      try {
        await page.waitForSelector('[data-plugin-source="github"]');
        await page.waitForFunction(
          () => document.querySelector('[data-plugin-source="github"]')?.getAttribute('data-plugin-state') === 'Not added',
        );

        await page.click('[data-plugin-source="github"] [data-plugin-add]');
        await page.waitForSelector('[aria-label="Personal access token"]');

        // The one control the row offers while it asks drops the field again.
        await page.click('[data-plugin-source="github"] [data-plugin-cancel]');
        expect(await page.$('[aria-label="Personal access token"]')).toBeNull();

        await page.click('[data-plugin-source="github"] [data-plugin-add]');
        await page.waitForSelector('[aria-label="Personal access token"]');
        await page.type('[aria-label="Personal access token"]', 'ghp_fixture');

        const row = await page.$('[data-plugin-source="github"]');
        const connect = await row?.waitForSelector('aria/Connect');
        await connect?.click();

        const add = v.parse(
          v.object({ presetId: v.literal('github'), headers: v.object({ Authorization: v.string() }) }),
          await lastMcpAdd(page),
        );

        expect(add.headers.Authorization).toBe('Bearer ghp_fixture');

        await page.waitForFunction(
          () => document.querySelector('[data-plugin-source="github"]')?.getAttribute('data-plugin-state') === 'Connected',
        );
        expect(await presetStatus(page, 'github')).toBe('Connected');

        // A token add is an add: the same row, under Connected.
        await page.waitForFunction(() => document.querySelector('section[aria-label="Connected"] [data-plugin="GitHub"]') !== null);
        expect(await connectedList(page)).toContain('GitHub');
      } finally {
        await page.close();
      }
    });
  });

  test('an oauth-app row signs in under its app, and hides when it has neither app nor fallback', async () => {
    await withGallery(async (gallery) => {
      // Only GitHub's app is configured: Google has no registered client and
      // no token fallback, so its row is not rendered at all.
      const page = await freshPage(gallery, 'plugins&mcp-preset=open&mcp-secrets=github', 'dark', 'desktop');

      try {
        await page.waitForSelector('[data-plugin-source="github"]');
        await page.waitForFunction(
          () => document.querySelector('[data-plugin-source="github"]')?.getAttribute('data-plugin-state') === 'Not added',
        );

        expect(await page.$('[data-plugin-source="google"]')).toBeNull();

        // GitHub's add is a sign-in, not a token prompt: no field opens, the
        // add posts the preset id alone, and the sign-in opens in its tab.
        const sentTo = await signInTab(page, '[data-plugin-source="github"] [data-plugin-add]');
        const add = v.parse(v.object({ presetId: v.literal('github') }), await lastMcpAdd(page));

        expect({ add: add.presetId, sentTo }).toEqual({ add: 'github', sentTo: expect.stringMatching(/^\/gallery-sign-in\/srv-add-\d+$/u) });

        await page.waitForFunction(
          () => document.querySelector('[data-plugin-source="github"]')?.getAttribute('data-plugin-state') === 'Needs sign-in',
        );

        // Not connected, the card keeps its way to the sign-in, begun again for a run of its own.
        await page.click(`[data-plugin-source="github"] ${ROW_MENU}`);
        await page.waitForSelector(`${OPEN_MENU} [data-plugin-sign-in]`);
        const again = await signInTab(page, `${OPEN_MENU} [data-plugin-sign-in]`);
        const runs = await begunRuns(page);

        expect({ again, runs: runs.length, distinct: new Set(runs).size }).toEqual({ again: sentTo, runs: 2, distinct: 2 });
      } finally {
        await page.close();
      }
    });
  });

  // 26244c765 review: one failed read of the deployment's apps left GitHub's card asking to sign in for good, though
  // the deployment has no GitHub app; the manager had read them again every few seconds.
  test('a failed first read of the deployment\'s apps is asked again, and GitHub then offers its token', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'plugins&mcp-secrets=google&presets=down', 'dark', 'desktop');

      try {
        // Every read on mount fails; once the deployment answers, only a read made after can see it.
        await page.waitForSelector('[data-plugin-add][aria-label="Add GitHub"]');
        const failed = await page.evaluate(() => Number(document.documentElement.dataset.galleryPresetReads ?? '0'));

        await page.evaluate(() => { window.dispatchEvent(new Event('gallery:presets-up')); });
        await page.waitForFunction((after) => Number(document.documentElement.dataset.galleryPresetReads ?? '0') > after, {}, failed);
        await page.click('[data-plugin-add][aria-label="Add GitHub"]');
        await page.waitForSelector('input[aria-label="Personal access token"]');
      } finally {
        await page.close();
      }
    });
  });

  // 26244c765: the manager kept its own list, so a server added there was missing from the page once it closed.
  test('a server added in the manager is on the page once the manager closes', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'plugins', 'dark', 'desktop');

      try {
        // Manage is the page's own action, at the end of its title row.
        const manage = 'xpath/.//header//button[normalize-space()="Manage"]';

        await page.waitForSelector(manage);
        await page.click(manage);
        await page.waitForSelector('[role="dialog"]');
        await page.$$eval('[role="dialog"] button', (buttons) => buttons.find((button) => button.textContent?.includes('Add custom server'))?.click());
        await page.type('[role="dialog"] input[placeholder="github"]', 'tracker');
        await page.type('[role="dialog"] input[placeholder="https://mcp.example.com/v1"]', 'https://mcp.tracker.example/v1');
        await page.$$eval('[role="dialog"] button', (buttons) => buttons.find((button) => button.textContent === 'Add server')?.click());
        await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes('mcp.tracker.example') === true);
        await page.$$eval('[role="dialog"] button', (buttons) => buttons.find((button) => button.textContent === 'Done')?.click());
        await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);

        expect((await drawnRows(page)).map((row) => row.name)).toContain('tracker');
      } finally {
        await page.close();
      }
    });
  });

  // Review finding (2026-10-23): a custom server's sign-in that could not begin was said on the add form, which the add
  // then closed, so the failure went with it.
  test('a custom server whose sign-in cannot begin says so in the manager after its form closes', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'plugins&mcp-sign-in=refused', 'dark', 'desktop');
      const manage = 'xpath/.//header//button[normalize-space()="Manage"]';

      try {
        await page.waitForSelector(manage);
        await page.click(manage);
        await page.waitForSelector('[role="dialog"]');
        await page.$$eval('[role="dialog"] button', (buttons) => buttons.find((button) => button.textContent?.includes('Add custom server'))?.click());
        await page.type('[role="dialog"] input[placeholder="github"]', 'tracker');
        await page.type('[role="dialog"] input[placeholder="https://mcp.example.com/v1"]', 'https://mcp.tracker.example/v1');
        await page.$$eval('[role="dialog"] button', (buttons) => buttons.find((button) => button.textContent === 'Add server')?.click());
        await page.waitForSelector('[role="dialog"] [data-connect-ended="failed"]');

        expect({
          formOpen: await page.$('[role="dialog"] input[placeholder="github"]') !== null,
          said: await page.$eval('[role="dialog"] [data-connect-ended="failed"]', (node) => node.textContent ?? ''),
        }).toEqual({ formOpen: false, said: expect.stringContaining("The MCP server's sign-in could not begin.") });
      } finally {
        await page.close();
      }
    });
  });

  // Sol's review (2026-10-23): every connect opened one named window, so two begun together shared it, each sending it
  // elsewhere and closing it under the other.
  test('two preset sign-ins begun together each get a helper window of their own', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'plugins', 'dark', 'desktop');

      try {
        await page.waitForFunction(() => ['cloudflare', 'github'].every((id) => document.querySelector(`[data-plugin-source="${id}"] [data-plugin-add]`) !== null));
        // Each window a connect opens, by its target name.
        await page.evaluate(() => {
          const open = window.open.bind(window);

          window.open = (url, target, features) => {
            localStorage.setItem('gallery-opened', `${localStorage.getItem('gallery-opened') ?? ''}${String(target)}\n`);

            return open(url, target, features);
          };
        });
        // Two clicks in one task: the second begins before the first's add has answered.
        await page.evaluate(() => {
          for (const id of ['cloudflare', 'github']) document.querySelector<HTMLElement>(`[data-plugin-source="${id}"] [data-plugin-add]`)?.click();
        });
        await page.waitForFunction(() => (localStorage.getItem('gallery-opened') ?? '').split('\n').filter(Boolean).length === 2);

        const targets = (await page.evaluate(() => localStorage.getItem('gallery-opened') ?? '')).split('\n').filter(Boolean);

        expect({ windows: targets.length, distinct: new Set(targets).size }).toEqual({ windows: 2, distinct: 2 });
      } finally {
        for (const opened of await page.browser().pages()) if (opened !== page) await opened.close();
        await page.close();
      }
    });
  });

  // Sol's review (2026-10-23): the Plugins page passes no outcome handler, so a sign-in that did not connect closed its
  // finish page with the only copy of why.
  test('a preset whose sign-in did not connect says why on its row', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'plugins', 'dark', 'desktop');
      const row = '[data-plugin-source="cloudflare"]';

      try {
        await page.waitForSelector(`${row} [data-plugin-add]`);
        const opened = page.browser().waitForTarget((target) => target.opener() === page.target());

        await page.click(`${row} [data-plugin-add]`);
        const helper = await (await opened).page();

        if (helper === null) throw new Error('the sign-in opened no tab');
        await page.waitForFunction(() => (localStorage.getItem('gallery-mcp-connects') ?? '') !== '');
        const [run = ''] = await begunRuns(page);

        // Where the callback sends the helper once the provider declines: the finish page, for this run.
        await Promise.allSettled([helper.goto(`${gallery.origin}/gallery.html?frame=connected&${new URLSearchParams({ run, service: 'Cloudflare', error: 'access_denied: the person declined' }).toString()}`)]);
        await page.waitForSelector(`${row} [data-plugin-error]`);

        // The provider's own reason, as the finish page carried it.
        const said = await page.$eval(`${row} [data-plugin-error]`, (node) => node.textContent ?? '');

        // A retry begun and abandoned (its tab closed with no end): the earlier failure stays, pending and after
        // (Sol's final review: it was cleared as the retry began).
        const signInAgain = async (runs: number) => {
          const retryTarget = page.browser().waitForTarget((target) => target.opener() === page.target());

          await pressRowMenu(page, row, '[data-plugin-sign-in]');
          const tab = await (await retryTarget).page();

          if (tab === null) throw new Error('the sign-in opened no tab');
          await page.waitForFunction((count: number) => (localStorage.getItem('gallery-mcp-connects') ?? '').split('\n').filter(Boolean).length === count, {}, runs);

          return tab;
        };

        const abandoned = await signInAgain(2);
        const keptPending = await page.$(`${row} [data-plugin-error]`) !== null;

        await abandoned.close();
        const keptAbandoned = await page.$(`${row} [data-plugin-error]`) !== null;

        // Signed in again and connected: the earlier failure goes (Sol-round review: it stayed on a ready row).
        const retry = await signInAgain(3);
        const retried = (await begunRuns(page))[2] ?? '';

        await Promise.allSettled([retry.goto(`${gallery.origin}/gallery.html?frame=connected&${new URLSearchParams({ run: retried, service: 'Cloudflare' }).toString()}`)]);
        // The row has heard the retry's end once its helper closed (its finish page closes it after telling the row).
        await new Promise<void>((resolve) => { if (retry.isClosed()) resolve(); else retry.once('close', () => { resolve(); }); });
        await page.waitForFunction(() => new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(true); }); }); }));

        expect({ said: said.includes('access_denied: the person declined'), keptPending, keptAbandoned, cleared: await page.$(`${row} [data-plugin-error]`) === null })
          .toEqual({ said: true, keptPending: true, keptAbandoned: true, cleared: true });
      } finally {
        await page.close();
      }
    });
  });

  // Sol's final review (2026-10-23): an added row's menu offered Sign in by its preset's kind and the deployment's app,
  // so a GitHub added with a token whose server refused it offered a sign-in its token never needs.
  test("an added row offers Sign in only where the account says it signs in", async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'plugins&mcp-preset=token-failed', 'dark', 'desktop');
      const row = '[data-plugin-source="github"]';

      try {
        await page.waitForSelector(`${row} ${ROW_MENU}`);
        await openRowMenu(page, row);

        expect(await page.$(`${OPEN_MENU} [data-plugin-sign-in]`)).toBeNull();
      } finally {
        await page.close();
      }
    });
  });

  test('the preset row renders in the account modal and on the plugins page at both widths in both themes', async () => {
    await withGallery(async (gallery) => {
      

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const modal = await freshPage(gallery, 'setupmodal&panel=mcp&mcp-preset=connected', theme, viewport);

          try {
            await modal.waitForSelector('[role="dialog"]');
            await modal.waitForFunction(
              () => document.querySelector('[data-plugin-source="cloudflare"]')?.getAttribute('data-plugin-state') === 'Needs sign-in',
            );

            const text = await modal.$eval('[role="dialog"]', (el) => el.textContent ?? '');
            expect(text).toContain('GitHub');
            expect(text).toContain('Connected');
            expect(text).toContain('Needs sign-in');
            expect(text).toContain('Add custom server');

            // The unclaimed preset says its state by what it offers: the one
            // control that adds it.
            expect(await presetStatus(modal, 'google')).toBe('Not added');
            expect(await modal.$('[data-plugin-source="google"] [data-plugin-add]')).not.toBeNull();
            
          } finally {
            await modal.close();
          }

          const plugins = await freshPage(gallery, 'plugins&mcp-preset=connected', theme, viewport);

          try {
            await plugins.waitForSelector('[data-plugin-source="github"]');
            await plugins.waitForFunction(
              () => document.querySelector('[data-plugin-source="github"]')?.getAttribute('data-plugin-state') === 'Connected',
            );

            // The row grammar, at this width: the endpoint is gone from every
            // row, a preset's and a server's alike, and each row carries one
            // control: a connected row's ⋯ after its status, an addable
            // preset's add.
            const drawn = await drawnRows(plugins);

            expect(drawn.filter((row) => row.preset).map((row) => row.name))
              .toEqual(['GitHub', 'Cloudflare', 'Gmail']);
            // Services only, skills being in the Drive: what the account holds,
            // then what it can add. The failed server is among them, so its line
            // (a failure, where the endpoint used to be) is under the same rule.
            // A server of its own on a known service's host takes that service's mark and name.
            expect(drawn.map((row) => row.name)).toEqual(['GitHub', 'Cloudflare', 'Linear', 'Notion', 'Gmail']);

            for (const row of drawn) {
              expect(row.text).not.toContain('http');
              expect(row.buttons).toBe(1);
            }

            // What the account holds, once each: both connected presets and both
            // servers of its own; the catalog's last is under Add alone.
            expect(await connectedList(plugins)).toEqual(['GitHub', 'Cloudflare', 'Linear', 'Notion']);
            expect(await plugins.$$eval('section[aria-label="Add"] [data-plugin]', (nodes) => nodes.map((node) => node.getAttribute('data-plugin')))).toEqual(['Gmail']);
            
          } finally {
            await plugins.close();
          }
        }
      }

      
    });
  });
});
