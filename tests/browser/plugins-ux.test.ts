/** Real-browser MCP preset addition, authorization and account holdings at both widths and themes. */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { Page } from 'puppeteer';
import type { JsonValue } from '@kinu.run/core';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';


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

/** Capture the tabs a row opens: a real `window.open` navigation would hang
 *  the fixture, so the capture writes each URL into the same localStorage
 *  pocket the fixture uses, newest last. */
async function captureOpenedTabs(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('gallery-mcp-opened', '');
    window.open = (url?: string | URL) => {
      localStorage.setItem('gallery-mcp-opened',
        `${localStorage.getItem('gallery-mcp-opened') ?? ''}${String(url)}\n`);

      return null;
    };
  });
}

/** The names in the Installed strip, in the order it draws them. */
function installedStrip(page: Page): Promise<string[]> {
  return page.$$eval('[data-installed-strip] [data-installed]',
    (nodes) => nodes.map((node) => node.getAttribute('data-installed') ?? ''));
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

        await captureOpenedTabs(page);

        // Cloudflare is the OAuth preset: one click posts the add.
        await page.click('[data-plugin-source="cloudflare"] [data-plugin-add]');

        const add = v.parse(v.object({ presetId: v.literal('cloudflare') }), await lastMcpAdd(page));

        expect(add.presetId).toBe('cloudflare');

        await page.waitForFunction(
          () => localStorage.getItem('gallery-mcp-opened') !== '',
        );

        const opened = v.parse(
          v.string(),
          await page.evaluate(() => localStorage.getItem('gallery-mcp-opened')),
        );

        // The authorize server is the preset's own, and the URL carries the
        // row the add created — whose id is the fixture's own counter.
        expect(opened.trim()).toMatch(/^https:\/\/mcp\.cloudflare\.com\/authorize\?srv-add-\d+$/);

        // The status the next list read reports — the same poll the panel runs.
        await page.waitForFunction(
          () => document.querySelector('[data-plugin-source="cloudflare"]')?.getAttribute('data-plugin-state') === 'Needs sign-in',
        );
        expect(await presetStatus(page, 'cloudflare')).toBe('Needs sign-in');

        // The added server joins the strip of what the account holds, and the
        // page still draws it once: its own preset row, not a second copy in
        // the servers list.
        await page.waitForFunction(() => document.querySelector('[data-installed="Cloudflare"]') !== null);
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

        // A token add is an add: the same row, and the same strip.
        await page.waitForFunction(() => document.querySelector('[data-installed="GitHub"]') !== null);
        expect(await installedStrip(page)).toContain('GitHub');
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

        await captureOpenedTabs(page);

        // GitHub's add is a sign-in, not a token prompt: no field opens and
        // the add posts the preset id alone.
        await page.click('[data-plugin-source="github"] [data-plugin-add]');

        const add = v.parse(
          v.object({ presetId: v.literal('github') }),
          await lastMcpAdd(page),
        );

        expect(add.presetId).toBe('github');

        await page.waitForFunction(
          () => localStorage.getItem('gallery-mcp-opened') !== '',
        );

        const opened = v.parse(
          v.string(),
          await page.evaluate(() => localStorage.getItem('gallery-mcp-opened')),
        );

        expect(opened.trim()).toMatch(/^https:\/\/api\.githubcopilot\.com\/authorize\?srv-add-\d+$/);

        await page.waitForFunction(
          () => document.querySelector('[data-plugin-source="github"]')?.getAttribute('data-plugin-state') === 'Needs sign-in',
        );
      } finally {
        await page.close();
      }
    });
  });

  // 26244c765 review: one failed read of the deployment's apps left GitHub's card asking to sign in for good, though
  // the deployment has no GitHub app; the manager had read them again every few seconds.
  test('a failed first read of the deployment\'s apps is asked again, and GitHub then offers its token', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'plugins&mcp-secrets=google&presets=fail-first', 'dark', 'desktop');

      try {
        await page.waitForFunction(() => Number(document.documentElement.dataset.galleryPresetReads ?? '0') >= 2);
        await page.waitForSelector('[data-plugin-add][aria-label="Add GitHub"]');
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
        await page.waitForSelector('[aria-label="MCP servers"] button');
        await page.click('[aria-label="MCP servers"] button');
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
            // trailing control, which is the preset rows' add or menu button
            // and nobody else's.
            const drawn = await drawnRows(plugins);

            expect(drawn.filter((row) => row.preset).map((row) => row.name))
              .toEqual(['GitHub', 'Cloudflare', 'Gmail']);
            // Services only, skills being in the Drive: the presets, then the
            // account's own servers. The failed one is among them, so its line
            // (a failure, where the endpoint used to be) is under the same rule.
            expect(drawn.map((row) => row.name)).toEqual(['GitHub', 'Cloudflare', 'Gmail', 'linear', 'notion']);

            for (const row of drawn) {
              expect(row.text).not.toContain('http');
              expect(row.buttons).toBe(row.preset ? 1 : 0);
            }

            // What the account holds, as the strip draws it: both connected
            // presets and both servers of its own.
            expect(await installedStrip(plugins)).toEqual(['GitHub', 'Cloudflare', 'linear', 'notion']);
            
          } finally {
            await plugins.close();
          }
        }
      }

      
    });
  });
});
