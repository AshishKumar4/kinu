/**
 * The account panels as shared surfaces, in a real browser: the setup modal
 * over the home chrome (providers, MCP servers, CLI install) and the settings
 * page's providers section, each at desktop and phone width in dark and light.
 *
 * What only a browser can say here: that the SAME panels render inside the
 * shipped modal at both widths, that the panel reads publish against the
 * account fixture, and that the sectioned settings page still lands a deep
 * link on the providers section. The codex fixture is healed and the held
 * gateway read released so the screenshots show the connected states, not the
 * failure rig the sibling gate drives. Screenshots land in
 * ~/kinu-logs/account-ux/ (outside the worktree).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from './gallery-harness';

const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'account-ux');

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

const dialogText = (page: Page) => page.$eval('[role="dialog"]', (element) => element.textContent ?? '');

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

describe('account panels', () => {
  test('the setup modal and the providers section render at both widths in both themes', async () => {
    await withGallery(async (gallery) => {
      const shots: string[] = [];

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const providers = await freshPage(gallery, 'setupmodal&panel=providers', theme, viewport);

          try {
            await providers.waitForSelector('[role="dialog"]', { timeout: 10_000 });
            await settleAccountFixture(providers);
            await providers.waitForFunction(
              () => document.querySelector('[role="dialog"]')?.textContent?.includes('Connect ChatGPT'),
              { timeout: 10_000 },
            );

            const text = await dialogText(providers);
            expect(text).toContain('Cloudflare AI');
            expect(text).toContain('ChatGPT (Codex)');
            expect(text).toContain('API keys');
            shots.push(await shoot(providers, `setupmodal-providers-${viewport}-${theme}`));
          } finally {
            await providers.close();
          }

          const mcp = await freshPage(gallery, 'setupmodal&panel=mcp', theme, viewport);

          try {
            await mcp.waitForSelector('[role="dialog"]', { timeout: 10_000 });
            await mcp.waitForFunction(
              () => document.querySelector('[role="dialog"]')?.textContent?.includes('auth needed'),
              { timeout: 10_000 },
            );

            const text = await dialogText(mcp);
            expect(text).toContain('github');
            expect(text).toContain('Add MCP server');
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
            shots.push(await shoot(mcp, `setupmodal-mcp-${viewport}-${theme}`));
          } finally {
            await mcp.close();
          }

          const cli = await freshPage(gallery, 'setupmodal&panel=cli', theme, viewport);

          try {
            await cli.waitForSelector('[role="dialog"]', { timeout: 10_000 });
            await cli.waitForFunction(
              () => document.querySelector('[role="dialog"]')?.textContent?.includes('kinu setup'),
              { timeout: 10_000 },
            );

            expect(await dialogText(cli)).toContain('kinu setup');
            shots.push(await shoot(cli, `setupmodal-cli-${viewport}-${theme}`));
          } finally {
            await cli.close();
          }

          const settings = await freshPage(gallery, 'usersettingsstate&section=providers', theme, viewport);

          try {
            await settings.waitForSelector('[data-settings-section="providers"]', { timeout: 10_000 });
            await settleAccountFixture(settings);

            const text = await settings.evaluate(() => document.body.innerText);
            expect(text).toContain('API keys');
            expect(text).toContain('Manage MCP servers');
            shots.push(await shoot(settings, `settings-providers-${viewport}-${theme}`));
          } finally {
            await settings.close();
          }
        }
      }

      expect(shots.length).toBe(16);
      process.stdout.write(`account-ux: ${String(shots.length)} screenshots under ${SHOTS}\n`);
    });
  }, 240_000);
});
