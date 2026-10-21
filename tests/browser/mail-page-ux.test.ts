/** The production Mail page against its HTTP contract: scope, read state, sends, drafts and phone navigation. */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { evidenceDir } from '@kinu.run/test-utils';
import { withGallery, type Gallery } from '../../scripts/gallery-harness';

const CallSchema = v.object({ method: v.string(), path: v.string(), body: v.unknown() });

const calls = async (page: Page) => v.parse(v.array(CallSchema), JSON.parse(await page.$eval('html', (root) => root.dataset.mailCalls ?? '[]')));

async function open(gallery: Gallery, query = '', width = 1440, theme = 'light'): Promise<Page> {
  const page = await gallery.newPage();
  await page.setViewport({ width, height: 1000 });
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${gallery.origin}/gallery.html?frame=mailpage${query}`, { waitUntil: 'networkidle0' });
  expect(await page.$('[data-mail-page]')).not.toBeNull();

  return page;
}

async function view(page: Page, name: string): Promise<void> {
  await page.click(`[aria-label="Mail views"] [data-segment="${name}"]`);
  await page.waitForFunction((wanted) => document.querySelector('[data-mail-list]')?.getAttribute('aria-label') === wanted, {}, name);
}

async function pick(page: Page, label: string, words: string): Promise<void> {
  const selector = `[aria-label="${label}"]`;
  await page.click(selector);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((option) => option.checkVisibility()));

  for (const option of await page.$$('[role="option"]')) {
    if (!await option.evaluate((node, wanted) => node.checkVisibility() && node.textContent?.trim() === wanted, words)) continue;
    await option.click();
    await page.waitForFunction((control, wanted) => document.querySelector(control)?.textContent?.includes(wanted), {}, selector, words);
    expect(await page.$eval(selector, (trigger) => trigger.textContent ?? '')).toContain(words);

    return;
  }

  throw new Error(`no choice ${words}`);
}

/** An action by its words: a button, a link, or an item of the menu that is open (it draws once its trigger is pressed). */
async function action(page: Page, words: string): Promise<void> {
  const shown = (wanted: string) => [...document.querySelectorAll('button, a, [role="menu"][data-open] [role="menuitem"]')]
    .some((item) => item.textContent?.trim() === wanted && item instanceof HTMLElement && item.offsetParent !== null);

  await page.waitForFunction(shown, {}, words);
  await page.$$eval('button, a, [role="menu"][data-open] [role="menuitem"]', (buttons, wanted) => {
    const button = buttons.find((item) => item.textContent?.trim() === wanted && item instanceof HTMLElement && item.offsetParent !== null);

    if (!(button instanceof HTMLElement)) throw new Error(`no action ${wanted}`);
    button.click();
  }, words);
}

const rows = (page: Page) => page.$$eval('[data-mail-list] [data-mail-thread], [data-mail-list] [data-important-mail]', (items) => items.map((item) => item.getAttribute('data-mail-thread') ?? item.getAttribute('data-important-mail')));

async function reader(page: Page, id: string): Promise<void> {
  await page.waitForSelector(`[data-mail-reader="${id}"]`);
}

/** The open thread, sent through its menu to the workspace found by `typed`, named `workspace`. */
async function handTo(page: Page, typed: string, workspace: string): Promise<void> {
  await page.waitForSelector('[data-mail-reader]');
  await page.click('[aria-label="More for Thread"]');
  await action(page, 'Send to a workspace…');
  await page.waitForSelector('[data-mail-hand] input');
  await page.type('[data-mail-hand] input', typed);
  await page.waitForFunction((name) => [...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes(name)), {}, workspace);
  await page.$$eval('[role="option"]', (options, name) => { options.find((option) => option.textContent?.includes(name))?.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, workspace);
  await page.click('[data-mail-hand-commit]');
}

describe('Mail', () => {
  test('the approved wireframe still opens the Mail page and workspace mail', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1440, height: 1000 });
      await page.goto(`${origin}/gallery.html?frame=mail&view=all&thread=t-dana`, { waitUntil: 'networkidle0' });
      expect(await page.$('[data-mail-reader="t-dana"]')).not.toBeNull();
      await page.goto(`${origin}/gallery.html?frame=mail&at=workspace`, { waitUntil: 'networkidle0' });
      expect((await page.$$('[data-mail-pill]')).length).toBeGreaterThan(0);
      await page.close();
    });
  });

  test('five views, Important unread and Draft counts, address scope and server search', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '', 390);
      expect(await page.$$eval('[aria-label="Mail views"] [role="tab"]', (tabs) => tabs.map((tab) => tab.getAttribute('data-segment')))).toEqual(['important', 'all', 'sent', 'drafts', 'trash']);
      expect(await page.$eval('[data-segment="important"]', (tab) => tab.textContent)).toContain('3');
      expect(await page.$eval('[data-segment="drafts"]', (tab) => tab.textContent)).toContain('2');
      expect(await rows(page)).toEqual(['t-priya', 't-github', 't-registrar', 't-lisbon']);
      await view(page, 'sent');
      expect(await rows(page)).toContain('t-dana');
      await view(page, 'drafts');
      expect(await rows(page)).toEqual(['t-priya', 't-lisbon']);
      await view(page, 'trash');
      expect(await rows(page)).toEqual(['t-linkedin']);
      await view(page, 'all');
      await pick(page, 'Address', 'scout · api-worker');
      await page.waitForFunction(() => document.querySelectorAll('[data-mail-list] [data-mail-thread]').length === 1);
      expect(await rows(page)).toEqual(['t-dana']);
      await pick(page, 'Address', 'All addresses');
      await page.type('[aria-label="Search mail"]', 'Gmail');
      expect(await page.$eval('[aria-label="Search mail"]', (input) => input instanceof HTMLInputElement ? input.value : '')).toBe('Gmail');
      await page.waitForFunction(() => document.querySelectorAll('[data-mail-list] [data-mail-thread]').length === 1);
      expect(await rows(page)).toEqual(['t-priya']);
      expect((await calls(page)).some((call) => call.path.includes('q=Gmail'))).toBe(true);
      await page.close();
    });
  });

  test('opening a deep-linked thread marks it read and replies from that box, not the person', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&view=all&thread=t-dana');
      await reader(page, 't-dana');
      expect(await calls(page)).toContainEqual({ method: 'PATCH', path: '/api/user/mail/threads/t-dana', body: { read: true } });
      expect(await page.$$('[data-mail-message][data-folded]')).toHaveLength(2);
      await page.click('[data-mail-show-quote]');
      expect(await page.$eval('[data-mail-quote]', (quote) => quote.textContent)).toContain('Northwind-Signature');
      await page.click('[data-mail-reply]');
      await page.type('textarea[aria-label="Reply"]', 'The fix is live. Please replay the events.');
      await page.click('[data-mail-send]');
      await page.waitForFunction(() => document.querySelector('[data-mail-reply-box]') === null);
      const sent = (await calls(page)).find((call) => call.path === '/api/user/mail/send');
      expect(sent?.body).toEqual({ path: 'scout.api-worker', to: ['dana@northwind.io'], subject: 'Re: Webhook deliveries to /hooks/v2 failing with 500 since Tuesday', text: 'The fix is live. Please replay the events.', threadId: 't-dana' });
      await page.close();
    });
  });

  test('deleting removes a thread from All, and restoring removes it from Trash', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&view=all&thread=t-dana');
      await reader(page, 't-dana');
      await page.click('[aria-label="More for Thread"]');
      await action(page, 'Delete');
      await page.waitForFunction(() => document.querySelector('[data-mail-thread="t-dana"]') === null);
      await view(page, 'trash');
      await page.click('[data-mail-thread="t-dana"]');
      await reader(page, 't-dana');
      await page.click('[aria-label="More for Thread"]');
      await action(page, 'Restore');
      await page.waitForFunction(() => document.querySelector('[data-mail-thread="t-dana"]') === null);
      expect((await calls(page)).filter((call) => call.method === 'PATCH' && v.is(v.object({ trashed: v.boolean() }), call.body)).map((call) => call.body)).toEqual([{ trashed: true }, { trashed: false }]);
      await page.close();
    });
  });

  test('Send to a workspace hands the thread to the chosen workspace and opens its chat; one not taken stays open with why', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&view=all&thread=t-dana');
      await handTo(page, 'API', 'api-worker');
      await page.waitForSelector('[data-gallery-workspace-chat="api-worker"]');
      expect((await calls(page)).filter((call) => call.path.startsWith('/api/workspaces/'))).toEqual([{ method: 'POST', path: '/api/workspaces/api-worker/mail', body: { thread: 't-dana' } }]);
      await page.close();

      const refused = await open(gallery, '&view=all&thread=t-dana&fail=hand');
      await handTo(refused, 'Dew', 'perf-audit');
      await refused.waitForSelector('[data-mail-hand] [role="alert"]');
      expect(await refused.$eval('[data-mail-hand] [role="alert"]', (alert) => alert.textContent)).toBe('Dew did not take it.');
      expect(await refused.$('[data-gallery-workspace-chat]')).toBeNull();
      await refused.close();
    });
  });

  test('Compose sends from its chosen address; saving and sending an assistant draft use the drafts API', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery);
      await page.click('[data-mail-compose]');
      await pick(page, 'From', 'api-worker.ashish@kinu.run');
      await page.type('[aria-label="To"]', 'dana@northwind.io');
      await page.type('[aria-label="Subject"]', 'Webhook update');
      await page.type('[aria-label="Message"]', 'The endpoint is healthy.');
      await action(page, 'Save draft');
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      expect((await calls(page)).find((call) => call.path === '/api/user/mail/drafts')?.body).toEqual({ path: 'api-worker', to: ['dana@northwind.io'], subject: 'Webhook update', text: 'The endpoint is healthy.' });
      await page.click('[data-mail-compose]');
      await pick(page, 'From', 'scout.api-worker.ashish@kinu.run');
      await page.type('[aria-label="To"]', 'dana@northwind.io');
      await page.type('[aria-label="Subject"]', 'Replay');
      await page.type('[aria-label="Message"]', 'Please replay now.');
      await action(page, 'Send');
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      expect((await calls(page)).find((call) => call.path === '/api/user/mail/send')?.body).toEqual({ path: 'scout.api-worker', to: ['dana@northwind.io'], subject: 'Replay', text: 'Please replay now.' });
      await view(page, 'drafts');
      await page.click('[data-mail-thread="t-priya"]');
      await reader(page, 't-priya');
      expect(await page.$eval('[aria-label="Reply"]', (input) => input instanceof HTMLTextAreaElement ? input.value : '')).toContain('You didn\'t miss a step');
      await page.click('[data-mail-send]');
      await page.waitForFunction(() => document.querySelector('[data-mail-thread="t-priya"]') === null);
      expect((await calls(page)).filter((call) => call.path === '/api/user/mail/send').at(-1)?.body).toMatchObject({ path: '', to: ['priya@raman.dev'], threadId: 't-priya' });
      await page.close();
    });
  });

  test('with no address, Mail offers it in place: their first name, checked as they type, created at once', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&account=new');
      const field = '[data-mail-create] [aria-label="Username"]';

      // Typed over what is there, as a person selects all and types.
      const retype = async (text: string) => {
        await page.click(field);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.type(field, text);
      };

      await page.waitForSelector('[data-mail-create] [data-mail-address-state="available"]');
      expect(await page.$eval(field, (input) => input instanceof HTMLInputElement ? input.value : '')).toBe('ashish');
      await retype('priya');
      await page.waitForSelector('[data-mail-create] [data-mail-address-state="taken"]');
      expect(await page.$eval('[data-mail-create] button[type="submit"]', (button) => button instanceof HTMLButtonElement && button.disabled)).toBe(true);
      await retype('ashish');
      await page.waitForSelector('[data-mail-create] [data-mail-address-state="available"]');
      await page.click('[data-mail-create] button[type="submit"]');
      await page.waitForSelector('[data-mail-list]');
      expect((await calls(page)).filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/user/mail/address', body: { username: 'ashish' } }]);
      await page.close();
      const member = await open(gallery, '&account=member');
      expect(await member.$('[aria-label="Username"]')).toBeNull();
      await member.close();
    });
  });

  test('Important offers the assistant when absent and its modal leads to Explore', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&assistant=none');
      expect(await page.$('[data-mail-no-assistant]')).not.toBeNull();
      await action(page, 'Set up your assistant');
      await page.waitForSelector('[role="dialog"]');
      expect(await page.$eval('[role="dialog"] a', (link) => link.getAttribute('href'))).toBe('/explore');
      await page.close();
    });
  });

  test('an unverified owner claim is labelled; HTML is sealed and remote images are blocked', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&view=all&thread=t-forged');
      await reader(page, 't-forged');
      expect(await page.$('[data-mail-unverified-banner]')).not.toBeNull();
      const fetched: string[] = [];
      const blocked: string[] = [];
      const images = new Set<string>();
      const network = await page.createCDPSession();
      await network.send('Network.enable');
      network.on('Network.requestWillBeSent', (event) => {
        if (event.request.url.startsWith('https://avatars.githubusercontent.com/')) images.add(event.requestId);
      });
      network.on('Network.loadingFailed', (event) => {
        if (event.blockedReason === 'csp' && images.has(event.requestId)) blocked.push(event.requestId);
      });
      page.on('requestfinished', (request) => { if (request.url().startsWith('https://avatars.githubusercontent.com/')) fetched.push(request.url()); });
      await page.click('[data-mail-thread="t-github"]');
      await reader(page, 't-github');
      expect(await page.$eval('iframe[data-mail-sealed]', (iframe) => ({ sandbox: iframe.getAttribute('sandbox'), sealed: iframe.getAttribute('srcdoc')?.includes("default-src 'none'") }))).toEqual({ sandbox: '', sealed: true });
      const frame = await (await page.$('iframe[data-mail-sealed]'))?.contentFrame();

      if (frame === null || frame === undefined) throw new Error('no sealed mail frame');
      await frame.waitForFunction(() => document.readyState === 'complete');
      expect(await frame.$eval('img', (img) => img instanceof HTMLImageElement && img.naturalWidth === 0)).toBe(true);
      expect(blocked).toHaveLength(1);
      expect(fetched).toEqual([]);
      await page.close();
    });
  });

  test('on a phone only the chosen reader is shown, and Back returns to the filtered list', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&view=all', 390);
      expect(await page.$('[data-mail-reader]')).toBeNull();
      await pick(page, 'Address', 'scout · api-worker');
      await page.waitForFunction(() => document.querySelectorAll('[data-mail-list] [data-mail-thread]').length === 1);
      await page.click('[data-mail-thread="t-dana"]');
      await reader(page, 't-dana');
      expect(await page.$eval('[data-mail-list]', (list) => list instanceof HTMLElement && list.offsetParent === null)).toBe(true);
      await page.click('[data-mail-back]');
      await page.waitForFunction(() => document.querySelector('[data-mail-reader]') === null);
      expect(await page.$eval('[data-mail-list]', (list) => list instanceof HTMLElement && list.offsetParent !== null)).toBe(true);
      expect(await rows(page)).toEqual(['t-dana']);
      await page.close();
    });
  });

  test('a refused reader still offers Back to the list on a phone', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&view=all&thread=t-dana&fail=thread', 390);
      await page.waitForSelector('[data-failure]');
      expect(await page.$('[data-mail-back]')).not.toBeNull();
      await page.click('[data-mail-back]');
      await page.waitForSelector('[data-mail-list]');
      expect(await rows(page)).toContain('t-dana');
      await page.close();
    });
  });

  test('a refused send keeps the reply and reports the reason; it can still be saved as a draft', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&view=all&thread=t-dana&fail=send');
      await reader(page, 't-dana');
      await page.click('[data-mail-reply]');
      await page.type('[aria-label="Reply"]', 'Keep this reply.');
      await page.click('[data-mail-send]');
      await page.waitForSelector('[data-mail-reply-box] [role="alert"]');
      expect(await page.$eval('[data-mail-reply-box] [role="alert"]', (alert) => alert.textContent)).toContain('The mail server refused this request.');
      expect(await page.$eval('[aria-label="Reply"]', (input) => input instanceof HTMLTextAreaElement ? input.value : '')).toBe('Keep this reply.');
      expect((await calls(page)).filter((call) => call.path === '/api/user/mail/send')).toHaveLength(1);
      await action(page, 'Save draft');
      await page.waitForFunction(() => document.querySelector('[data-mail-reply-box]') === null);
      expect((await calls(page)).find((call) => call.path === '/api/user/mail/drafts')?.body).toMatchObject({ path: 'scout.api-worker', text: 'Keep this reply.', threadId: 't-dana' });
      await page.close();
    });
  });

  test('on a deployment with no mail domain, Mail is off: no footer icon, the page says so, no address offered', async () => {
    await withGallery(async (gallery) => {
      const page = await open(gallery, '&account=new&mail=off');

      await page.waitForFunction(() => document.querySelector('[data-mail-off]') !== null);
      expect(await page.$('[data-footer-mail]')).toBeNull();
      expect(await page.$('[data-footer-devices]')).not.toBeNull();
      expect(await page.$('[data-mail-page] form')).toBeNull();
      await page.close();
    });
  });

  test('Mail renders in both themes at desktop and phone widths', async () => {
    await withGallery(async (gallery) => {
      const dir = evidenceDir('mail-page');
      mkdirSync(dir, { recursive: true });

      for (const theme of ['light', 'dark']) {
        for (const width of [1440, 390]) {
          const page = await open(gallery, '&view=all', width, theme);
          await page.screenshot({ path: join(dir, `${theme}-${String(width)}-list.png`), fullPage: true });
          await page.click('[data-mail-thread="t-dana"]');
          await reader(page, 't-dana');
          await page.screenshot({ path: join(dir, `${theme}-${String(width)}-reader.png`), fullPage: true });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.close();
        }
      }
    });
  });
});
