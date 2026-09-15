/**
 * The one-click MCP presets, in a real browser: the three cards on the Plugins
 * page and inside the account modal's MCP panel, the OAuth preset's add call,
 * and the token preset's single field — each at desktop and phone width in
 * dark and light.
 *
 * What only a browser can say here: that the cards sit in the shipped grid at
 * both widths, that Connect POSTs the preset id to the real add route (the
 * fixture keeps the roster, so the follow-up list read is what flips the
 * card's status), and that the authorize URL the server returns is what
 * `window.open` is handed. Screenshots land in ~/kinu-logs/mcp-presets/
 * (outside the worktree).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { Page } from 'puppeteer';
import type { JsonValue } from '@kinu.run/core';

import { withGallery, type Gallery } from './gallery-harness';

const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'mcp-presets');

mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 390, height: 844 } } as const;

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.browser.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'networkidle0' });

  return page;
}

async function shoot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });

  return path;
}

/** The status word one preset card shows. */
const presetStatus = (page: Page, id: string): Promise<string> =>
  page.$eval(`[data-mcp-preset-status="${id}"]`, (el) => el.textContent ?? '');

/** The body the fixture recorded for the page's add POST. The fixture writes
 *  it as JSON; the caller's valibot schema is what shapes the field it needs. */
async function lastMcpAdd(page: Page): Promise<JsonValue> {
  await page.waitForFunction(
    () => localStorage.getItem('gallery-mcp-add') !== null, { timeout: 10_000 },
  );

  return page.evaluate(() => {
    const raw = localStorage.getItem('gallery-mcp-add');

    return raw === null ? null : JSON.parse(raw);
  });
}

describe('MCP presets', () => {
  test('the plugins page renders all three preset cards Not added, and Connect adds via the RPC', async () => {
    await withGallery(async (gallery) => {
      const page = await freshPage(gallery, 'plugins', 'dark', 'desktop');

      try {
        await page.waitForSelector('[data-mcp-preset="github"]', { timeout: 10_000 });
        await page.waitForFunction(
          () => document.querySelector('[data-mcp-preset-status="cloudflare"]')?.textContent === 'Not added',
          { timeout: 10_000 },
        );

        expect(await presetStatus(page, 'github')).toBe('Not added');
        expect(await presetStatus(page, 'cloudflare')).toBe('Not added');
        expect(await presetStatus(page, 'google')).toBe('Not added');

        // The authorize tab: a real `window.open` navigation would hang the
        // fixture, so the capture replaces it — into the same localStorage
        // pocket the fixture uses — and the assertion reads what the card
        // would have opened.
        await page.evaluate(() => {
          localStorage.setItem('gallery-mcp-opened', '');
          window.open = (url?: string | URL) => {
            localStorage.setItem('gallery-mcp-opened',
              `${localStorage.getItem('gallery-mcp-opened') ?? ''}${String(url)}\n`);

            return null;
          };
        });

        // Cloudflare is the OAuth preset: one click posts the add.
        await page.click('[data-mcp-preset="cloudflare"] button');

        const add = v.parse(v.object({ presetId: v.literal('cloudflare') }), await lastMcpAdd(page));

        expect(add.presetId).toBe('cloudflare');

        await page.waitForFunction(
          () => localStorage.getItem('gallery-mcp-opened') !== '',
          { timeout: 10_000 },
        );

        const opened = v.parse(
          v.string(),
          await page.evaluate(() => localStorage.getItem('gallery-mcp-opened')),
        );

        expect(opened.trim()).toBe('https://mcp.cloudflare.com/authorize?srv-add-3');

        // The status the next list read reports — the same poll the panel runs.
        await page.waitForFunction(
          () => document.querySelector('[data-mcp-preset-status="cloudflare"]')?.textContent === 'Needs sign-in',
          { timeout: 10_000 },
        );
        expect(await presetStatus(page, 'cloudflare')).toBe('Needs sign-in');

        // The added preset is a server row like any other.
        expect(await page.$eval('[data-plugin="Cloudflare"]', (el) => el.textContent ?? ''))
          .toContain('https://mcp.cloudflare.com/mcp');
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('a token preset opens one field and posts it as the bearer header', async () => {
    await withGallery(async (gallery) => {
      // GitHub without its app: the card falls back to the PAT field. Google
      // stays configured so the split is observable on one page.
      const page = await freshPage(gallery, 'plugins&mcp-preset=open&mcp-secrets=google', 'dark', 'desktop');

      try {
        await page.waitForSelector('[data-mcp-preset="github"]', { timeout: 10_000 });
        await page.waitForFunction(
          () => document.querySelector('[data-mcp-preset-status="github"]')?.textContent === 'Not added',
          { timeout: 10_000 },
        );

        await page.click('[data-mcp-preset="github"] button');
        await page.waitForSelector('[aria-label="Personal access token"]', { timeout: 10_000 });
        await page.type('[aria-label="Personal access token"]', 'ghp_fixture');

        const card = await page.$('[data-mcp-preset="github"]');
        const connect = await card?.waitForSelector('aria/Connect');
        await connect?.click();

        const add = v.parse(
          v.object({ presetId: v.literal('github'), headers: v.object({ Authorization: v.string() }) }),
          await lastMcpAdd(page),
        );

        expect(add.headers.Authorization).toBe('Bearer ghp_fixture');

        await page.waitForFunction(
          () => document.querySelector('[data-mcp-preset-status="github"]')?.textContent === 'Connected',
          { timeout: 10_000 },
        );
        expect(await presetStatus(page, 'github')).toBe('Connected');
        expect(await page.$eval('[data-plugin="GitHub"]', (el) => el.textContent ?? ''))
          .toContain('api.githubcopilot.com');
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('an oauth-app card signs in under its app, and hides when it has neither app nor fallback', async () => {
    await withGallery(async (gallery) => {
      // Only GitHub's app is configured: Google has no registered client and
      // no token fallback, so its card is not rendered at all.
      const page = await freshPage(gallery, 'plugins&mcp-preset=open&mcp-secrets=github', 'dark', 'desktop');

      try {
        await page.waitForSelector('[data-mcp-preset="github"]', { timeout: 10_000 });
        await page.waitForFunction(
          () => document.querySelector('[data-mcp-preset-status="github"]')?.textContent === 'Not added',
          { timeout: 10_000 },
        );

        expect(await page.$('[data-mcp-preset="google"]')).toBeNull();

        await page.evaluate(() => {
          localStorage.setItem('gallery-mcp-opened', '');
          window.open = (url?: string | URL) => {
            localStorage.setItem('gallery-mcp-opened',
              `${localStorage.getItem('gallery-mcp-opened') ?? ''}${String(url)}\n`);

            return null;
          };
        });

        // GitHub's Connect is a sign-in, not a token prompt: no field opens
        // and the add posts the preset id alone.
        await page.click('[data-mcp-preset="github"] button');

        const add = v.parse(
          v.object({ presetId: v.literal('github') }),
          await lastMcpAdd(page),
        );

        expect(add.presetId).toBe('github');

        await page.waitForFunction(
          () => localStorage.getItem('gallery-mcp-opened') !== '',
          { timeout: 10_000 },
        );

        const opened = v.parse(
          v.string(),
          await page.evaluate(() => localStorage.getItem('gallery-mcp-opened')),
        );

        expect(opened.trim()).toBe('https://api.githubcopilot.com/authorize?srv-add-2');

        await page.waitForFunction(
          () => document.querySelector('[data-mcp-preset-status="github"]')?.textContent === 'Needs sign-in',
          { timeout: 10_000 },
        );
      } finally {
        await page.close();
      }
    });
  }, 60_000);

  test('the preset row renders in the account modal and on the plugins page at both widths in both themes', async () => {
    await withGallery(async (gallery) => {
      const shots: string[] = [];

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const modal = await freshPage(gallery, 'setupmodal&panel=mcp&mcp-preset=connected', theme, viewport);

          try {
            await modal.waitForSelector('[role="dialog"]', { timeout: 10_000 });
            await modal.waitForFunction(
              () => document.querySelector('[data-mcp-preset-status="cloudflare"]')?.textContent === 'Needs sign-in',
              { timeout: 10_000 },
            );

            const text = await modal.$eval('[role="dialog"]', (el) => el.textContent ?? '');
            expect(text).toContain('GitHub');
            expect(text).toContain('Connected');
            expect(text).toContain('Needs sign-in');
            expect(text).toContain('Not added');
            expect(text).toContain('Add custom server');
            shots.push(await shoot(modal, `setupmodal-mcp-${viewport}-${theme}`));
          } finally {
            await modal.close();
          }

          const plugins = await freshPage(gallery, 'plugins&mcp-preset=connected', theme, viewport);

          try {
            await plugins.waitForSelector('[data-mcp-preset="github"]', { timeout: 10_000 });
            await plugins.waitForFunction(
              () => document.querySelector('[data-mcp-preset-status="github"]')?.textContent === 'Connected',
              { timeout: 10_000 },
            );
            shots.push(await shoot(plugins, `plugins-mcp-${viewport}-${theme}`));
          } finally {
            await plugins.close();
          }
        }
      }

      expect(shots.length).toBe(8);
    });
  }, 120_000);
});
