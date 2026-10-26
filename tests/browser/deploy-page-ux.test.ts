/**
 * The deploy page (`/deploy`): the real page over the gallery's door (gallery-deploy-fixture.ts), whose answers are
 * core's own types, its runs core's `deployRunView` and its refusals core's `judgeRefusal`. What the page sends is read
 * by core's `DeployRunRequestSchema`, so a body the backend would refuse fails here first.
 */
import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { DeployRunRequestSchema, judgeRefusal } from '@kinu.run/core/deploy';

import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const SOON = { timeout: 15_000 } as const;

/** The fixture's first account (gallery-deploy-fixture.ts). */
const ACCOUNT = '4b1ad7e0c3f24f6c9a51d2e8b7c60a13';

async function opened(gallery: Gallery, state: string, at = '/deploy'): Promise<Page> {
  const page = await gallery.newPage();

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${gallery.origin}/gallery.html?frame=deploy&deploy=${state}&at=${encodeURIComponent(at)}`, { waitUntil: 'load' });

  return page;
}

const screenOf = (page: Page) => page.$eval('[data-deploy-screen]', (root) => root.getAttribute('data-deploy-screen'));

async function screenBecomes(page: Page, screen: string): Promise<void> {
  try {
    await page.waitForSelector(`[data-deploy-screen="${screen}"]`, SOON);
  } catch (cause) {
    throw new Error(`the page stayed on ${String(await screenOf(page).catch(() => 'nothing'))}, never ${screen}`, { cause });
  }
}

const AskedSchema = v.array(v.object({ route: v.string(), body: v.unknown() }));

/** What the page asked the door, in order. */
async function asked(page: Page): Promise<v.InferOutput<typeof AskedSchema>> {
  return v.parse(AskedSchema, JSON.parse(await page.$eval('html', (root) => root.dataset.deployAsked ?? '[]')));
}

/** The run the page asked for, read as the backend reads it. */
async function runAsked(page: Page): Promise<v.InferOutput<typeof DeployRunRequestSchema>> {
  await page.waitForFunction(() => (document.documentElement.dataset.deployAsked ?? '').includes('"route":"runs"'), SOON);
  const run = (await asked(page)).find((each) => each.route === 'runs');

  return v.parse(DeployRunRequestSchema, run?.body);
}

async function press(page: Page, selector: string): Promise<void> {
  await page.waitForSelector(`${selector}:not([disabled])`, SOON);
  await page.click(selector);
}

/** Presses the enabled button whose whole text is `name`, once there is one. */
async function pressNamed(page: Page, name: string): Promise<void> {
  await page.waitForFunction((wanted) => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === wanted && !button.disabled), SOON, name);
  await page.evaluate((wanted) => {
    [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === wanted && !button.disabled)?.click();
  }, name);
}

describe('the deploy page', () => {
  test('signed out, it starts with the sign-in; signing in comes back ready to deploy on workers.dev', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'start');

      await screenBecomes(page, 'start');
      expect(await page.$('[data-deploy-refusal]')).toBeNull();
      await pressNamed(page, 'Continue with Cloudflare');
      await screenBecomes(page, 'ready');
      await page.waitForSelector('[data-deploy-address]', SOON);
      expect(await page.$eval('[data-deploy-address]', (address) => address.textContent)).toBe('kinu.ada.workers.dev');
    });
  });

  test('a declined consent shows Cloudflare\'s words and offers the sign-in again', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'declined', '/deploy?error=access_denied&error_description=The+user+denied+the+request.');

      await screenBecomes(page, 'start');
      await page.waitForSelector('[data-deploy-refusal] [data-deploy-words]', SOON);
      expect(await page.$eval('[data-deploy-words]', (words) => words.textContent ?? '')).toContain('access_denied');
    });
  });

  test('a Kinu with no OAuth client says so where the sign-in would begin', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'unconfigured');

      await pressNamed(page, 'Continue with Cloudflare');
      await page.waitForSelector('[data-deploy-refusal][role="alert"]', SOON);
      expect(await screenOf(page)).toBe('start');
    });
  });

  test('Deploy asks for a new Kinu on workers.dev, follows the run through its phases and lands live with the setup link', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'ready');

      await press(page, '[data-deploy-go]');
      expect(await runAsked(page)).toEqual({ kind: 'new', account: ACCOUNT, name: 'kinu', address: { kind: 'workers' }, computer: false, mail: null });
      await screenBecomes(page, 'deploying');
      await page.waitForSelector('[data-deploy-run="running"] [role="progressbar"]', SOON);
      await screenBecomes(page, 'live');
      expect(await page.$eval('[data-deploy-open]', (open) => open.getAttribute('href'))).toBe('https://kinu.ada.workers.dev/setup#seat-7f3a91');
      expect(await page.$eval('[data-deploy-live-address]', (address) => address.textContent)).toBe('kinu.ada.workers.dev');
    });
  });

  test('a domain in the account moves the address onto it and makes mail available, read before it is asked', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'ready');

      await pressNamed(page, 'Use your own domain');
      await screenBecomes(page, 'domain');
      await page.waitForSelector('[data-deploy-domain="flourandhearth.com"] button', SOON);
      await page.click('[data-deploy-domain="flourandhearth.com"] button');
      await screenBecomes(page, 'ready');
      expect(await page.$eval('[data-deploy-address]', (address) => address.textContent)).toBe('kinu.flourandhearth.com');
      await press(page, 'button[aria-label="Mail at your domain"]');
      await page.waitForSelector('[data-deploy-mail="flourandhearth.com"] details', SOON);
      await press(page, '[data-deploy-go]');
      expect(await runAsked(page)).toEqual({
        kind: 'new', account: ACCOUNT, name: 'kinu', computer: false,
        address: { kind: 'domain', zone: '0c5e9a1d7b2f4e6a8c3d1f0b9e7a5c42', host: 'kinu.flourandhearth.com' },
        mail: { host: 'flourandhearth.com' },
      });
    });
  });

  test('a domain that already gets mail elsewhere keeps it: Kinu\'s mail goes on the subdomain the preview suggests', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'mail-conflict');

      await pressNamed(page, 'Use your own domain');
      await page.waitForSelector('[data-deploy-domain="flourandhearth.com"] button', SOON);
      await page.click('[data-deploy-domain="flourandhearth.com"] button');
      await press(page, 'button[aria-label="Mail at your domain"]');
      await page.waitForSelector('[data-deploy-mail="mail.flourandhearth.com"]', SOON);
      await press(page, '[data-deploy-go]');
      const run = await runAsked(page);

      expect(run.kind === 'new' && run.mail).toEqual({ host: 'mail.flourandhearth.com' });
    });
  });

  test('a mail subdomain that gets mail elsewhere too is said and holds Deploy back, never stepped past', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'mail-conflict-both');

      await pressNamed(page, 'Use your own domain');
      await page.waitForSelector('[data-deploy-domain="flourandhearth.com"] button', SOON);
      await page.click('[data-deploy-domain="flourandhearth.com"] button');
      await press(page, 'button[aria-label="Mail at your domain"]');
      await page.waitForSelector('[data-deploy-mail="mail.flourandhearth.com"] [role="alert"]', SOON);
      expect(await page.$('[data-deploy-mail="mail.mail.flourandhearth.com"]')).toBeNull();
      expect(await page.$('[data-deploy-go][disabled]')).not.toBeNull();
    });
  });

  test('a domain registered elsewhere is asked by name: the run adds it and Kinu starts on workers.dev', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'ready');

      await pressNamed(page, 'Use your own domain');
      await page.waitForSelector('input[aria-label="Find a domain"]', SOON);
      await page.type('input[aria-label="Find a domain"]', 'ada.dev');
      await page.waitForSelector('[data-deploy-domain="ada.dev"] button', SOON);
      await page.click('[data-deploy-domain="ada.dev"] button');
      await screenBecomes(page, 'ready');
      expect(await page.$('button[aria-label="Mail at your domain"][disabled]')).not.toBeNull();
      await press(page, '[data-deploy-go]');
      const run = await runAsked(page);

      expect(run.kind === 'new' && run.address).toEqual({ kind: 'domain', domain: 'ada.dev', host: 'kinu.ada.dev' });
    });
  });

  test('a prerequisite holds Deploy back and hands off to the dashboard page the catalog names', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'r2');
      const r2 = judgeRefusal({ message: 'R2', code: 10_042, status: 403, endpoint: `/accounts/${ACCOUNT}/r2/buckets` }, ACCOUNT);

      await page.waitForSelector('[data-deploy-lack="r2"] [data-deploy-handoff]', SOON);
      expect(await page.$eval('[data-deploy-lack="r2"] [data-deploy-handoff]', (button) => button.getAttribute('data-deploy-handoff'))).toBe('need' in r2 ? r2.need.action.href ?? null : null);
      expect(await page.$('[data-deploy-go][disabled]')).not.toBeNull();

      // Cloudflare will not be framed: the hand-off opens its own window over the page, which waits on it.
      const window = page.browser().waitForTarget((target) => target.opener() === page.target(), SOON);

      await page.click('[data-deploy-lack="r2"] [data-deploy-handoff]');
      await (await (await window).page())?.close();
      await page.waitForSelector('[data-deploy-lack="r2"]:not([data-done])', SOON);
    });
  });

  test('a run paused past an hour asks for a sign-in; back from it, the run carries on where it stopped', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'paused-signin');

      // Found waiting on a sign-in, it is carried on at once; refused for want of one, it asks for it, once.
      await page.waitForSelector('[data-deploy-need="signin-again"]', SOON);
      expect(await page.$$eval('[data-deploy-need="signin-again"]', (needs) => needs.length)).toBe(1);
      expect((await asked(page)).map((each) => each.route)).toEqual(['runs/current/continue']);
      await pressNamed(page, 'Sign in again');
      // Signed in in Cloudflare's window, whose end the page hears: the run is carried on again, and goes live.
      await page.waitForFunction(() => (document.documentElement.dataset.deployAsked ?? '').split('runs/current/continue').length > 2, SOON);
      expect((await asked(page)).map((each) => each.route)).toEqual(['runs/current/continue', 'signin', 'runs/current/continue']);
      await screenBecomes(page, 'live');
    });
  });

  test('a refused step is retried by the person, never by itself', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'refused');

      await page.waitForSelector('[data-deploy-run="refused"]', SOON);
      expect(await asked(page)).toEqual([]);
      await press(page, '[data-deploy-retry]');
      await page.waitForFunction(() => (document.documentElement.dataset.deployAsked ?? '').includes('continue'), SOON);
      expect((await asked(page)).map((each) => each.route)).toEqual(['runs/current/continue']);
    });
  });

  test('a domain still moving lists its nameservers; once it points at Cloudflare, a sign-in moves Kinu onto it', async () => {
    await withGallery(async (gallery) => {
      const moving = await opened(gallery, 'live-pending');

      await moving.waitForSelector('[data-deploy-pending="waiting"]', SOON);
      expect(await moving.$$eval('[data-deploy-pending] li', (servers) => servers.length)).toBe(2);

      const ready = await opened(gallery, 'live-pending-ready');

      await ready.waitForSelector('[data-deploy-pending="ready"]', SOON);
      expect(await ready.$('[data-deploy-refusal], [data-deploy-need]')).toBeNull();
      await pressNamed(ready, 'Sign in again');
      // Signed in in Cloudflare's window, whose end the page hears: the run carries on onto the domain.
      await ready.waitForFunction(() => (document.documentElement.dataset.deployAsked ?? '').includes('"route":"signin"'), SOON);
      await ready.waitForSelector('[data-deploy-live-address]', SOON);
      await ready.waitForFunction(() => document.querySelector('[data-deploy-live-address]')?.textContent === 'kinu.ada.dev', SOON);
    });
  });

  test('a read of the run the door refuses is said, and the run is read again rather than left where it was', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'running-hiccup');

      await page.waitForSelector('[data-deploy-run="running"] [data-deploy-refusal]', SOON);
      await screenBecomes(page, 'live');
      expect(await page.$('[data-deploy-refusal]')).toBeNull();
    });
  });

  test('an account whose Kinus could not be read is said on Ready, in Cloudflare\'s words', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'unreadable');

      await screenBecomes(page, 'ready');
      await page.waitForSelector('[data-deploy-unreadable] [data-deploy-words]', SOON);
    });
  });

  test('an existing Kinu offers its changes: an update asks for one in place, a new link asks for a change', async () => {
    await withGallery(async (gallery) => {
      const update = await opened(gallery, 'manage');

      await press(update, '[data-deploy-change="update"]');
      expect(await runAsked(update)).toEqual({ kind: 'update', account: ACCOUNT, name: 'kinu' });

      const relink = await opened(gallery, 'manage');

      await press(relink, '[data-deploy-change="link"]');
      expect(await runAsked(relink)).toEqual({ kind: 'change', account: ACCOUNT, name: 'kinu', setupLink: true });
      await screenBecomes(relink, 'live');
      expect(await relink.$('[data-deploy-open][href*="/setup#"]')).not.toBeNull();
    });
  });

  test('a release channel it cannot read is said, never called up to date; mail waits for a domain', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'manage-unread');

      await page.waitForSelector('[data-deploy-change="update"]', SOON);
      expect(await page.$eval('[data-deploy-change="update"]', (button) => button.hasAttribute('disabled'))).toBe(true);
      expect(await page.$('[data-deploy-update="current"]')).toBeNull();
      expect(await page.$eval('[data-deploy-change="mail"]', (button) => button.hasAttribute('disabled'))).toBe(true);
    });
  });

  test('two Kinus are listed first, and each opens its own changes', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'manage-two');

      await page.waitForSelector('[data-deploy-change="pick"]', SOON);
      expect(await page.$$eval('[data-deploy-change="pick"]', (kinus) => kinus.length)).toBe(2);
      await page.click('[data-deploy-change="pick"]');
      await page.waitForSelector('[data-deploy-kinu="kinu"]', SOON);
    });
  });

  test('Start says what Kinu costs and offers a Cloudflare account to someone with none, in Cloudflare\'s own window', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'start');

      await page.waitForSelector('[data-deploy-price]', SOON);
      expect(await page.$eval('[data-deploy-price]', (price) => price.textContent ?? '')).toContain('Workers Paid');
      const window = page.browser().waitForTarget((target) => target.opener() === page.target(), SOON);

      await pressNamed(page, 'Create one, free');
      await (await (await window).page())?.close();
      await page.waitForSelector('[data-deploy-window]', SOON);
      expect(await screenOf(page)).toBe('start');
    });
  });

  test('a free account lists Workers Paid and R2 before deploying, and Deploy waits for both', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'free');

      await page.waitForSelector('[data-deploy-lack="plan"]', SOON);
      expect(await page.$$eval('[data-deploy-lack]', (rows) => rows.map((row) => [row.getAttribute('data-deploy-lack'), row.hasAttribute('data-done')])))
        .toEqual([['plan', false], ['r2', false]]);
      expect(await page.$('[data-deploy-go][disabled]')).not.toBeNull();
    });
  });

  test('a lack met on Cloudflare ticks off when the page reads the account again, and the rest stays', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'upgrading');

      await page.waitForSelector('[data-deploy-lack="plan"]:not([data-done])', SOON);
      // Back from Cloudflare's window: the page has the focus again, and reads the account.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForSelector('[data-deploy-lack="plan"][data-done]', SOON);
      expect(await page.$('[data-deploy-lack="r2"]:not([data-done])')).not.toBeNull();
      expect(await page.$('[data-deploy-go][disabled]')).not.toBeNull();
    });
  });

  test('a login with no Cloudflare account behind it is asked to make one first', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'no-account');

      await page.waitForSelector('[data-deploy-lack="account"] [data-deploy-handoff]', SOON);
      expect(await page.$eval('[data-deploy-lack="account"] [data-deploy-handoff]', (button) => button.getAttribute('data-deploy-handoff'))).toBe('https://dash.cloudflare.com/');
      expect(await page.$('[data-deploy-go][disabled]')).not.toBeNull();
    });
  });

  // Review, 2026-10-26: API Tokens is required at the consent (core deploy/pkce.ts), so turning the computer on asks
  // for nothing more; the run is asked for it.
  test('the computer turned on lets Deploy go, and the run asks for it', async () => {
    await withGallery(async (gallery) => {
      const page = await opened(gallery, 'ready');

      await page.waitForSelector('[role="switch"]', SOON);
      await page.click('[role="switch"]');
      await page.waitForSelector('[data-deploy-go]:not([disabled])', SOON);
      await press(page, '[data-deploy-go]');
      expect(await runAsked(page)).toMatchObject({ kind: 'new', computer: true });
    });
  });
});
