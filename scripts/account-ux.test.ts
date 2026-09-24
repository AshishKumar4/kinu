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

/** The app the workspaces tile photographs — the coupon-board slate is a
 *  gallery frame of its own (`?frame=couponboard` in `gallery.tsx`), served
 *  same-origin so the tile's iframe draws a real page, not a white hold. */
const SLATE_FIXTURE_URL = '/gallery.html?frame=couponboard';

async function freshPage(gallery: Gallery, query: string, theme: 'dark' | 'light', viewport: keyof typeof VIEWPORTS): Promise<Page> {
  const page = await gallery.newPage();
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

/** The rail's primary nav, as drawn: which rows carry the active token (the
 *  elevated background class every active row shares) and which one react-
 *  router marks current. Exactly one row may be lit, and it must be the page's. */
async function activeNavRow(page: Page): Promise<string> {
  const rows = await page.$$eval('nav[aria-label="Primary"] a', (anchors) => anchors.map((a) => ({
    label: a.textContent?.trim() ?? '',
    lit: a.className.includes('bg-[var(--c-elevated)]') && !a.className.includes('hover:bg-[var(--c-elevated)]'),
    current: a.getAttribute('aria-current') === 'page',
  })));

  const lit = rows.filter((row) => row.lit);
  const current = rows.filter((row) => row.current);

  if (lit.length !== 1 || current.length !== 1 || lit[0]?.label !== current[0]?.label) {
    throw new Error(`expected exactly one lit and current nav row, got ${JSON.stringify(rows)}`);
  }

  return lit[0].label;
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

/** What one welcome step shows: the panel that is neither hidden nor inert
 *  carries that step's own copy, and the first step's name field is prefilled. */
async function expectWelcomeStep(page: Page, step: 0 | 1 | 2, active: string): Promise<void> {
  if (step === 0) {
    expect(await page.$('[aria-label="Your name"]')).not.toBeNull();
    expect(active).toContain('Your name');

    const field = await page.$eval('[aria-label="Your name"]', (el) => {
      if (!(el instanceof HTMLInputElement)) throw new Error('the name field is not an input');

      return el.value;
    });

    expect(field).toBe('Owner');

    return;
  }

  if (step === 1) {
    expect(active).toContain('API keys');

    return;
  }

  // The three showcase cards fade in staggered; a capture taken mid-transition
  // photographs the last one translucent.
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-welcome-step="showcase"] > div > div')]
      .every((el) => getComputedStyle(el).opacity === '1'),
  );

  expect(await page.$eval('[data-welcome-step="showcase"]', (el) => el instanceof HTMLElement && !el.inert)).toBe(true);
}

/** What one view of the Workspaces page draws for a reader, and the shot of
 *  it taken where a reader meets it: before the filter tabs are exercised. */
async function checkWorkspacesView(
  page: Page, view: 'list' | 'tiled', viewport: keyof typeof VIEWPORTS, theme: 'dark' | 'light',
): Promise<string> {
  await page.waitForSelector('[aria-label="Search workspaces"]');
  const body = await page.evaluate(() => document.body.innerText);
  expect(body).toContain('Workspaces');

  for (const name of ['Checkout coupon bug', 'Perf audit', 'Email triage automation', 'Design system v2']) {
    expect(body).toContain(name);
  }

  expect(await page.$eval('[aria-pressed="true"]', (button) => button.getAttribute('aria-label')))
    .toBe(view === 'tiled' ? 'Tiled view' : 'List view');
  expect(await page.$eval('[data-workspaces-view]', (section) => section.getAttribute('data-workspaces-view'))).toBe(view);

  // One state per card, no more: the chip count equals the row count, and the
  // headline words are the shared rule's.
  await page.waitForFunction(
    () => document.querySelectorAll('[data-overview-chip]').length === 5,
  );
  const body2 = await page.evaluate(() => document.body.innerText);
  expect(body2).toContain('Needs you · 2');
  expect(body2).toContain('Last run failed');

  // The tile of the one workspace with a primary slate holds the slate itself
  // — live, and inert in every direction a reader could touch it. The other
  // four tiles, and every row of the list, hold no frame at all.
  const frames = await page.$$eval('[data-workspaces-view] iframe', (nodes) => nodes.map((node) => ({
    src: node.getAttribute('src'),
    tabIndex: node.tabIndex,
    pointerEvents: getComputedStyle(node).pointerEvents,
    card: node.closest('[data-slate-frame]')?.parentElement?.textContent ?? '',
  })));

  expect(frames.length).toBe(view === 'tiled' ? 1 : 0);

  if (view === 'tiled') {
    expect(frames[0]?.src).toBe(SLATE_FIXTURE_URL);
    expect(frames[0]?.tabIndex).toBe(-1);
    expect(frames[0]?.pointerEvents).toBe('none');
    expect(frames[0]?.card).toContain('Checkout coupon bug');
  }

  // The filter tabs and the page's own create action sit in the control row;
  // the count is a tabular "N of M", not a sentence.
  const tabs = await page.$$eval('[aria-label="Workspace state"] [role="tab"]', (els) => els.map((el) => el.textContent?.trim() ?? ''));
  expect(tabs).toEqual(['All', 'Needs you', 'Working', 'Idle']);
  expect(await page.$$eval('main button', (buttons) => buttons.filter((button) => button.textContent?.trim() === 'New workspace').length)).toBe(1);
  expect(body2).toContain('5 of 5');

  if (viewport === 'desktop') expect(await activeNavRow(page)).toBe('Workspaces');

  const shot = await shoot(page, `workspaces-${view}-${viewport}-${theme}`);

  // 'Needs you' holds exactly the workspace whose decisions wait.
  await page.click('[data-segment="needs"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-workspaces-view] a').length === 1,
  );
  expect(await page.$eval('[data-workspaces-view] a', (a) => a.textContent ?? '')).toContain('Checkout coupon bug');
  await page.click('[data-segment="all"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-workspaces-view] a').length === 5,
  );

  await page.type('[aria-label="Search workspaces"]', 'perf');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-workspaces-view] a').length === 1,
  );
  expect(await page.$eval('[data-workspaces-view] a', (a) => a.textContent ?? '')).toContain('Perf audit');

  return shot;
}

/** Is the delete-everything button awake? Asked in the page, so the polled
 *  wait and the assertions read the same button. */
const deleteArmed = (): boolean =>
  [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Delete everything') && !b.disabled);

describe('account panels', () => {
  test('the setup modal and the providers section render at both widths in both themes', async () => {
    await withGallery(async (gallery) => {
      const shots: string[] = [];

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const providers = await freshPage(gallery, 'setupmodal&panel=providers', theme, viewport);

          try {
            await providers.waitForSelector('[role="dialog"]');
            await settleAccountFixture(providers);
            await providers.waitForFunction(
              () => document.querySelector('[role="dialog"]')?.textContent?.includes('Connect ChatGPT'),
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
            shots.push(await shoot(mcp, `setupmodal-mcp-${viewport}-${theme}`));
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
            shots.push(await shoot(cli, `setupmodal-cli-${viewport}-${theme}`));
          } finally {
            await cli.close();
          }

          const settings = await freshPage(gallery, 'usersettingsstate&section=providers', theme, viewport);

          try {
            await settings.waitForSelector('[data-settings-section="providers"]');
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

  test('the usage section lists each account across workspaces with its quota, and names a workspace it could not read', async () => {
    await withGallery(async (gallery) => {
      const usage = await freshPage(gallery, 'usersettingsstate&section=usage', 'dark', 'mobile');

      try {
        await usage.waitForFunction(() => document.body.textContent?.includes('Across 4 workspaces') === true);
        const text = await usage.evaluate(() => document.body.textContent ?? '');
        expect(text).toContain('anthropic · work');
        expect(text).toContain('3 of 50 requests left, resets in');
        expect(text).toContain('41% of the 5h window used');
        expect(text).toContain('No account recorded');
        expect(text).toContain('could not be read: old-bot');
        expect(text).toContain('$4.12 of $10.00 left, resets monthly');
        await shoot(usage, 'settings-usage-mobile-dark');
      } finally {
        await usage.close();
      }
    });
  });

  test('the welcome wizard renders each step at both widths in both themes', async () => {
    await withGallery(async (gallery) => {
      const shots: string[] = [];

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          for (const step of [0, 1, 2] as const) {
            const page = await freshPage(gallery, `welcome&step=${String(step)}`, theme, viewport);

            try {
              // The slide is an inert track: every step's text is in the DOM,
              // so the honest read of "this step is showing" is the panel that
              // is neither hidden nor inert.
              await page.waitForSelector('h1');

              const body = await page.evaluate(() => document.body.innerText);
              expect(body).toContain("Let's set up your account");

              const active = await page.evaluate(() => {
                const panel = [...document.querySelectorAll('[data-welcome-step]')].find(
                  (el) => el instanceof HTMLElement && !el.inert && el.getAttribute('aria-hidden') !== 'true',
                );

                return panel?.textContent ?? '';
              });

              await expectWelcomeStep(page, step, active);

              shots.push(await shoot(page, `welcome-step${String(step)}-${viewport}-${theme}`));
            } finally {
              await page.close();
            }
          }
        }
      }

      expect(shots.length).toBe(12);
      process.stdout.write(`account-ux welcome: ${String(shots.length)} screenshots under ${SHOTS}\n`);
    });
  });

  test('the account section names the owner and arms the delete only on the typed email', async () => {
    await withGallery(async (gallery) => {
      const shots: string[] = [];

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          const page = await freshPage(gallery, 'usersettingsstate&section=account', theme, viewport);

          try {
            await page.waitForSelector('[aria-label="Your name"]');
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
            await page.waitForSelector('[aria-label="Confirm your email"]');

            expect(await page.evaluate(deleteArmed)).toBe(false);
            await page.type('[aria-label="Confirm your email"]', 'someone@else.com');
            expect(await page.evaluate(deleteArmed)).toBe(false);
            await page.$eval('[aria-label="Confirm your email"]', (input) => { if (input instanceof HTMLInputElement) input.value = ''; });
            await page.type('[aria-label="Confirm your email"]', 'Owner@Example.com');
            await page.waitForFunction(deleteArmed);
            expect(await page.evaluate(deleteArmed)).toBe(true);
            shots.push(await shoot(page, `settings-account-armed-${viewport}-${theme}`));
          } finally {
            await page.close();
          }
        }
      }

      expect(shots.length).toBe(8);
      process.stdout.write(`account-ux account: ${String(shots.length)} screenshots under ${SHOTS}\n`);
    });
  });

  test('the primary nav, the workspaces page, the plugins page and the blueprints folder render at both widths in both themes', async () => {
    await withGallery(async (gallery) => {
      const shots: string[] = [];

      for (const theme of ['dark', 'light'] as const) {
        for (const viewport of ['desktop', 'mobile'] as const) {
          // The nav lives inside the existing rail, which the phone keeps in a
          // drawer: its links are asserted at desktop width, where it is drawn.
          if (viewport === 'desktop') {
            const home = await freshPage(gallery, 'home', theme, viewport);

            try {
              const links = await home.$$eval('nav[aria-label="Primary"] a', (anchors) =>
                anchors.map((a) => ({ label: a.textContent?.trim() ?? '', current: a.getAttribute('aria-current') })));

              // Account settings is reached from the gear at the foot of the
              // rail, so the nav carries no row of its own for it.
              expect(links.map((link) => link.label)).toEqual(['Home', 'Workspaces', 'Drive', 'Devices', 'Plugins']);
              expect(links[0]?.current).toBe('page');
              expect(await activeNavRow(home)).toBe('Home');
              // The rail's own furniture is untouched around it: the roster
              // eyebrow above the rows, the account row at the foot. (The New
              // workspace button is absent on the home route by design.)
              const rail = await home.evaluate(() => document.querySelector('aside')?.innerText ?? '');
              expect(rail).toContain('WORKSPACES');
              expect(rail).toContain('Checkout coupon bug');
              expect(rail).toContain('ashish@example.com');
              shots.push(await shoot(home, `sidebar-nav-${theme}`));
            } finally {
              await home.close();
            }
          }

          for (const view of ['list', 'tiled'] as const) {
            const page = await freshPage(gallery, view === 'list' ? 'workspaces&view=list' : 'workspaces', theme, viewport);

            try {
              shots.push(await checkWorkspacesView(page, view, viewport, theme));
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
            for (const text of ['MCP SERVERS', 'github', 'auth needed',
              'SKILLS', 'audit-implementation', 'built in']) {
              expect(body).toContain(text);
            }

            if (viewport === 'desktop') expect(await activeNavRow(plugins)).toBe('Plugins');
            shots.push(await shoot(plugins, `plugins-${viewport}-${theme}`));
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
            const body = await devices.evaluate(() => document.body.innerText);

            // Each machine's link state, then the grant state per workspace.
            for (const text of ['Workstation', 'connected', 'Owner laptop', 'offline', 'checkout-fixes', 'Denied']) {
              expect(body).toContain(text);
            }

            if (viewport === 'desktop') expect(await activeNavRow(devices)).toBe('Devices');
            shots.push(await shoot(devices, `devices-${viewport}-${theme}`));
          } finally {
            await devices.close();
          }

          const shared = await freshPage(gallery, 'shared', theme, viewport);

          try {
            const body = await shared.evaluate(() => document.body.innerText);

            // One grid behind five counted segments — the lists are tabs now,
            // drawn as the Drive's blueprints folder.
            expect(body).toContain('Drive');
            expect(body).toContain('blueprints');
            expect(await shared.$$eval('[aria-label="Shared lists"] [role="tab"]', (els) => els.length)).toBe(5);

            for (const label of ['All', 'Mine', 'With me', 'Public', 'People I know']) expect(body).toContain(label);

            if (viewport === 'desktop') expect(await activeNavRow(shared)).toBe('Drive');
            shots.push(await shoot(shared, `shared-segments-${viewport}-${theme}`));
          } finally {
            await shared.close();
          }

          // Before anything is shared, each segment says its own empty line.
          const empty = await freshPage(gallery, 'shared-empty', theme, viewport);

          try {
            const body = await empty.evaluate(() => document.body.innerText);

            expect(body).toContain('Nothing shared yet');
            expect(await empty.$$eval('[data-open-live]', (buttons) => buttons.length)).toBe(0);

            for (const [segment, line] of [
              ['received', 'Nothing shared with you'],
              ['public', 'Nothing public'],
              ['known', 'Nothing from people you know'],
            ] as const) {
              await empty.click(`[data-segment="${segment}"]`);
              await empty.waitForFunction(
                (expected) => document.body.innerText.includes(expected), {}, line,
              );
            }
          } finally {
            await empty.close();
          }
        }
      }

      expect(shots.length).toBe(22);
      process.stdout.write(`account-ux nav: ${String(shots.length)} screenshots under ${SHOTS}\n`);
    });
  });
});
