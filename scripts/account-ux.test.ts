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

  test('the welcome wizard renders each step at both widths in both themes', async () => {
    await withGallery(async (gallery) => {
      const shots: string[] = [];

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          for (const step of [0, 1, 2, 3] as const) {
            const page = await freshPage(gallery, `welcome&step=${String(step)}`, theme, viewport);

            try {
              // The slide is an inert track: every step's text is in the DOM,
              // so the honest read of "this step is showing" is the panel that
              // is neither hidden nor inert.
              await page.waitForSelector('h1', { timeout: 10_000 });
              // Step 1's providers read the account fixture: the sibling gate
              // arms Codex failed and the gateway held, so heal and release
              // them before the settled screenshot means anything.

              if (step === 1) await settleAccountFixture(page);

              const body = await page.evaluate(() => document.body.innerText);
              expect(body).toContain("Let's set up your account");

              const active = await page.evaluate(() => {
                const panel = [...document.querySelectorAll('[data-welcome-step]')].find(
                  (el) => el instanceof HTMLElement && !el.inert && el.getAttribute('aria-hidden') !== 'true',
                );

                return panel?.textContent ?? '';
              });

              if (step === 0) {
                expect(await page.$('[aria-label="Your name"]')).not.toBeNull();
                expect(active).toContain('Your name');
              } else if (step === 1) {
                expect(active).toContain('Model tiers');
                expect(active).toContain('API keys');
              } else if (step === 2) {
                expect(active).toContain('Add MCP server');
                expect(active).toContain('kinu setup');
              } else {
                // The three showcase cards fade in staggered; a capture taken
                // mid-transition photographs the last one translucent.
                await page.waitForFunction(
                  () => [...document.querySelectorAll('[data-welcome-step="showcase"] > div > div')]
                    .every((el) => getComputedStyle(el).opacity === '1'),
                  { timeout: 10_000 },
                );

                expect(active).toContain('Work that runs without you');
                expect(active).toContain('Live apps, not just answers');
                expect(active).toContain('Your machines, when you want them');
                expect(body).toContain('Create your first workspace');
              }

              shots.push(await shoot(page, `welcome-step${String(step)}-${viewport}-${theme}`));
            } finally {
              await page.close();
            }
          }
        }
      }

      expect(shots.length).toBe(16);
      process.stdout.write(`account-ux welcome: ${String(shots.length)} screenshots under ${SHOTS}\n`);
    });
  }, 240_000);

  test('the account section names the owner and arms the delete only on the typed email', async () => {
    await withGallery(async (gallery) => {
      const shots: string[] = [];

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const page = await freshPage(gallery, 'usersettingsstate&section=account', theme, viewport);

          try {
            await page.waitForSelector('[aria-label="Your name"]', { timeout: 10_000 });
            const body = await page.evaluate(() => document.body.innerText);
            expect(body).toContain('owner@example.com');
            expect(body).toContain('Delete this account');
            shots.push(await shoot(page, `settings-account-${viewport}-${theme}`));

            // The danger button sleeps until the phrase is the account's own
            // email; a wrong phrase leaves it asleep, and case does not count.
            await page.evaluate(() => {
              const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Delete account'));

              if (button === undefined) throw new Error('no delete button');
              button.click();
            });
            await page.waitForSelector('[aria-label="Confirm your email"]', { timeout: 10_000 });

            const armed = (): Promise<boolean> => page.evaluate(() =>
              [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Delete everything') && !b.disabled));

            expect(await armed()).toBe(false);
            await page.type('[aria-label="Confirm your email"]', 'someone@else.com');
            expect(await armed()).toBe(false);
            await page.$eval('[aria-label="Confirm your email"]', (input) => { if (input instanceof HTMLInputElement) input.value = ''; });
            await page.type('[aria-label="Confirm your email"]', 'Owner@Example.com');
            await page.waitForFunction(
              () => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Delete everything') && !b.disabled),
              { timeout: 10_000 },
            );
            expect(await armed()).toBe(true);
            shots.push(await shoot(page, `settings-account-armed-${viewport}-${theme}`));
          } finally {
            await page.close();
          }
        }
      }

      expect(shots.length).toBe(8);
      process.stdout.write(`account-ux account: ${String(shots.length)} screenshots under ${SHOTS}\n`);
    });
  }, 240_000);
});
