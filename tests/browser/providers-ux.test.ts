/** The providers list in a real browser: Claude's sign-in, pasted code and all, against the gallery's account. */
import { describe, expect, test } from 'bun:test';

import type { Page } from 'puppeteer';

import { withGallery } from '../../scripts/gallery-harness';

const CLAUDE = '[data-provider="Claude"]';

const CHATGPT = '[data-provider="ChatGPT"]';

/** Stands in for the browser's windows on `page`: each sign-in window it asks for is recorded, with where it was sent and
 *  whether the page closed it, or refused when `refused`; a link's own tab is recorded as let or kept, and never opens. */
async function rigSignInWindows(page: Page, refused = false): Promise<void> {
  await page.evaluate((refusing) => {
    const seen = document.documentElement.dataset;
    const popup = { opener: null, location: { set href(at: string) { seen.signInAt = at; } }, close() { seen.signInClosed = 'yes'; } };

    window.open = (_url, _target, features) => {
      if (refusing) return null;
      seen.signInWindow = String(features);

      // SAFETY: constructed above with every member `openProviderWindow` and its callers use of a window: `opener`,
      // `location.href` and `close`.
      return popup as Window;
    };


    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element) || event.target.closest('a') === null) return;
      seen.linkOpensTab = String(!event.defaultPrevented);
      event.preventDefault();
    });
  }, refused);
}

async function signInWindowSeen(page: Page): Promise<{ window: string | null; at: string | null; closed: boolean; linkOpensTab: string | null }> {
  return await page.evaluate(() => {
    const seen = document.documentElement.dataset;

    return { window: seen.signInWindow ?? null, at: seen.signInAt ?? null, closed: seen.signInClosed === 'yes', linkOpensTab: seen.linkOpensTab ?? null };
  });
}

/** The providers list with ChatGPT's entry read, at `query`'s account. */
async function chatGptEntry(page: Page, origin: string, query: string): Promise<void> {
  await page.setViewport({ width: 1280, height: 1100 });
  await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers${query}`, { waitUntil: 'networkidle0' });
  // The fixture's Codex read fails until healed, for the sibling failure rig.
  await page.evaluate(() => { window.dispatchEvent(new Event('gallery:settings-heal')); });
  await page.click('[data-settings-resource="your ChatGPT connection"] button');
  await page.waitForSelector(`${CHATGPT} button`);
}

const POPUP = expect.stringContaining('popup,width=520,height=720');

describe('the providers list', () => {
  // Review finding (2026-10-23): a Cloudflare connect that failed ended on the finish page, which closed with the only
  // copy of why. The page that began it says so now. The server half, a decline ending on the finish page with its
  // reason, is unit-auth-cloudflare-login.test.ts; here the tab is sent where that callback sends it.
  test('a Cloudflare connect that did not connect says why on the page that began it', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const entry = '[data-provider="Cloudflare AI"]';
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers&cloudflare=off`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(`${entry} [data-connect-cloudflare]`);

      const opened = page.browser().waitForTarget((target) => target.opener() === page.target());
      await page.click(`${entry} [data-connect-cloudflare]`);
      const target = await opened;
      const sent = new URL((await page.browser().waitForTarget((each) => each === target && each.url() !== 'about:blank')).url());
      const helper = await target.page();

      if (helper === null) throw new Error('the connect opened no tab');
      const closed = new Promise<void>((resolve) => { helper.once('close', () => { resolve(); }); });
      const ended = new URLSearchParams({ run: sent.searchParams.get('run') ?? '', service: 'Cloudflare', error: 'access_denied: the person declined' });

      await Promise.allSettled([helper.goto(`${origin}/gallery.html?frame=connected&${ended.toString()}`)]);
      await closed;
      await page.waitForSelector(`${entry} [data-connect-failed]`);

      expect({ path: sent.pathname, intent: sent.searchParams.get('intent'), said: await page.$eval(`${entry} [data-connect-failed]`, (node) => node.textContent ?? '') })
        .toEqual({ path: '/auth/cloudflare/start', intent: 'connect', said: expect.stringContaining('access_denied: the person declined') });

      await page.close();
    });
  });

  // The owner's rule (2026-10-21): a sign-in opens in a popup first, centred over the page that began it, so it reads as
  // part of the flow.
  test("a connect's window opens sized for its sign-in, centred over the page that began it", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const entry = '[data-provider="Cloudflare AI"]';
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers&cloudflare=off`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(`${entry} [data-connect-cloudflare]`);
      // The page's window placed off the screen's corner, with room around it for a popup centred over it.
      const cdp = await page.createCDPSession();
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 300, top: 100, width: 1100, height: 900 } });

      const opened = page.browser().waitForTarget((target) => target.opener() === page.target());
      await page.click(`${entry} [data-connect-cloudflare]`);
      const helper = await (await opened).page();

      if (helper === null) throw new Error('the connect opened no window');
      // The windows' own bounds: Puppeteer lays each page out at a size of its own, so `innerHeight` is not the window's.
      const bounds = () => ({ x: screenX, y: screenY, width: outerWidth, height: outerHeight });
      const [began, popup] = [await page.evaluate(bounds), await helper.evaluate(bounds)];
      const across = Math.abs(popup.x + popup.width / 2 - (began.x + began.width / 2));
      const down = Math.abs(popup.y + popup.height / 2 - (began.y + began.height / 2));

      // Its page 520 by 720, under a title and address bar the size it asks for leaves out (34px here, and under 100 on
      // any browser); the window centred to the pixel across, and down within half that bar.
      const bar = popup.height - 720;

      expect({ width: popup.width, bar: bar >= 0 && bar < 100, across: across <= 1, down: down <= bar / 2 + 1 })
        .toEqual({ width: 520, bar: true, across: true, down: true });
      await helper.close();
      await page.close();
    }, { browserArgs: ['--screen-info={0,0 1920x1200}'] });
  });

  // Review finding (2026-10-23): with its popup blocked, a connect run in the tab itself came back without the address's
  // hash, so `/user/settings#search` returned to the account section.
  test('a Cloudflare connect run in the tab itself comes back to the address it left, hash and all', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      const left = `${origin}/gallery.html?frame=usersettingsstate&section=providers&cloudflare=off#search`;
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(left, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-provider="Cloudflare AI"] [data-connect-cloudflare]');
      // A popup blocker's answer: no helper tab, so the connect runs here.
      await page.evaluate(() => { window.open = () => null; });

      // The gallery serves no `/auth/` route, so the start is read off the tab's request for it.
      const started = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === '/auth/cloudflare/start');
      await page.click('[data-provider="Cloudflare AI"] [data-connect-cloudflare]');
      const run = new URL((await started).url()).searchParams.get('run') ?? '';

      // Where the callback sends the tab once Cloudflare answers: the finish page, for the run this tab began. Loaded
      // again for the same run, as `vite dev`'s reload of a page whose imports it just optimized loads it, it goes back
      // again rather than read as another tab's end.
      const finished = `${origin}/gallery.html?frame=connected&${new URLSearchParams({ run, service: 'Cloudflare' }).toString()}`;
      const back: string[] = [];

      for (const visit of ['first', 'again']) {
        await page.goto(finished);
        // Back where it left, or saying its end and staying, as a page that tells another tab does.
        await page.waitForFunction((at: string) => location.href === at || document.querySelector('[data-connect-finished] p') !== null, {}, left);
        back.push(`${visit} ${page.url() === left ? 'back' : 'stayed'}`);
      }

      expect(back).toEqual(['first back', 'again back']);
      await page.close();
    });
  });

  test('Claude connects from a pasted code, warns first, says why a code fails, and then offers Disconnect', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(CLAUDE);


      // Not connected, its one button is the sign-in: its page opens with that click, then its code is pasted back.
      await rigSignInWindows(page);
      await page.click(`${CLAUDE} button`);
      await page.waitForSelector(`${CLAUDE} [data-sign-in-paste] input`);
      await page.type(`${CLAUDE} [data-sign-in-paste] input`, 'stale-code');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (document.querySelector('[data-provider="Claude"]')?.textContent ?? '').includes('Invalid authorization code'));

      await page.click(`${CLAUDE} [data-sign-in-paste] input`, { count: 3 });
      await page.type(`${CLAUDE} [data-sign-in-paste] input`, 'good-code');
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${CLAUDE} button[aria-label="Disconnect Claude"]`);

      await page.close();
    });
  });

  // The owner's rule (2026-10-21): a sign-in whose end the page learns itself, by its poll or the code pasted back, opens
  // in its popup at the link's click, and the page closes it at that end.
  test("ChatGPT's sign-in through a machine opens in its popup, which closes once the machine reports it", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await chatGptEntry(page, origin, '&chatgpt=device');
      await rigSignInWindows(page);
      // Use your PC: the machine opens its sign-in, and the page offers the link to it, still after its next poll.
      await page.click(`${CHATGPT} button`);
      await page.waitForSelector(`${CHATGPT} [data-chatgpt-state="open"] a`);
      const reads = await page.evaluate(() => Number(document.documentElement.dataset.galleryChatgptReads ?? '0'));

      await page.waitForFunction((before: number) => Number(document.documentElement.dataset.galleryChatgptReads ?? '0') > before, {}, reads);
      await page.click(`${CHATGPT} [data-chatgpt-state="open"] a`);
      const opened = await signInWindowSeen(page);

      await page.evaluate(() => { window.dispatchEvent(new Event('gallery:chatgpt-signed-in')); });
      await page.waitForSelector(`${CHATGPT} button[aria-label="Disconnect ChatGPT"]`);

      expect({ opened, ended: await signInWindowSeen(page) }).toEqual({
        opened: { window: POPUP, at: 'about:blank', closed: false, linkOpensTab: 'false' },
        ended: { window: POPUP, at: 'about:blank', closed: true, linkOpensTab: 'false' },
      });
      await page.close();
    });
  });

  // The owner, 2026-10-23, over the rule above for this one sign-in: its page ends on an address to copy, so it opens in a
  // tab of its own, which the page leaves open, and what to copy is not read only once a popup has closed.
  test("ChatGPT's sign-in pasted back opens in a tab of its own, which the page leaves open", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await chatGptEntry(page, origin, '');
      await rigSignInWindows(page);
      await page.$$eval(`${CHATGPT} button`, (buttons) => buttons.find((button) => button.textContent?.includes('Sign in here'))?.click());
      await page.waitForSelector(`${CHATGPT} [data-chatgpt-way="here"] [data-sign-in-open]`);
      await page.click(`${CHATGPT} [data-chatgpt-way="here"] [data-sign-in-open]`);
      const opened = await signInWindowSeen(page);

      await page.type(`${CHATGPT} [data-sign-in-paste] input`, 'http://127.0.0.1:1455/auth/callback?code=gallery');
      await page.$$eval(`${CHATGPT} button`, (buttons) => buttons.find((button) => button.textContent === 'Finish')?.click());
      await page.waitForSelector(`${CHATGPT} button[aria-label="Disconnect ChatGPT"]`);

      expect({ opened, ended: (await signInWindowSeen(page)).closed }).toEqual({
        opened: { window: null, at: null, closed: false, linkOpensTab: 'true' }, ended: false,
      });
      await page.close();
    });
  });

  // The owner, 2026-10-24: "why do i have to click twice on the claude button?" One click opens the popup, at Claude's
  // address once the sign-in has it, and the page goes straight to the code.
  test("Claude's sign-in opens in its popup at one click, which closes once the pasted code connects", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(CLAUDE);
      await rigSignInWindows(page);

      await page.click(`${CLAUDE} button`);
      await page.waitForSelector(`${CLAUDE} [data-sign-in-paste] input`);
      const opened = await signInWindowSeen(page);

      await page.type(`${CLAUDE} [data-sign-in-paste] input`, 'good-code');
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${CLAUDE} button[aria-label="Disconnect Claude"]`);

      expect({ opened, ended: (await signInWindowSeen(page)).closed }).toEqual({
        opened: {
          window: POPUP, at: 'https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=gallery',
          closed: false, linkOpensTab: null,
        },
        ended: true,
      });
      await page.close();
    });
  });

  // A popup the browser refused: a tab a script opens is refused as one is, so the link opens its own.
  test('a sign-in whose popup the browser refused is left to its link, which opens a tab', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(CLAUDE);
      await rigSignInWindows(page, true);
      await page.click(`${CLAUDE} button`);
      const link = await page.waitForSelector(`${CLAUDE} [data-sign-in-open]`);
      const href = await link?.evaluate((open) => open.getAttribute('href'));

      await page.click(`${CLAUDE} [data-sign-in-open]`);

      expect({ href, seen: await signInWindowSeen(page) }).toEqual({
        href: expect.stringMatching(/^https:\/\/claude\.ai\/oauth\/authorize\?/u), seen: { window: null, at: null, closed: false, linkOpensTab: 'true' },
      });
      await page.close();
    });
  });

  // A sign-in that could not start closes the popup its click opened, and says why where it began.
  test("Claude's sign-in that cannot start closes its popup and says so", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers&claude=down`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(CLAUDE);
      await rigSignInWindows(page);
      await page.click(`${CLAUDE} button`);
      await page.waitForSelector(`${CLAUDE} [data-claude-connect="start"] [role="alert"]`);

      expect({ seen: await signInWindowSeen(page), steps: await page.$(`${CLAUDE} [data-claude-connect="paste"]`) }).toEqual({
        seen: { window: POPUP, at: null, closed: true, linkOpensTab: null }, steps: null,
      });
      await page.close();
    });
  });

  test('a ChatGPT plan connected on the page is in the model menus without a reload', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers&chatgpt=device`, { waitUntil: 'networkidle0' });
      // The fixture's Codex read fails until healed, for the sibling failure rig.
      await page.evaluate(() => { window.dispatchEvent(new Event('gallery:settings-heal')); });
      await page.click('[data-settings-resource="your ChatGPT connection"] button');
      await page.waitForSelector('[data-provider="ChatGPT"] button');

      // The sign-in opens its own window; the page polls the machine until it reports the plan.
      await page.click('[data-provider="ChatGPT"] button');
      await page.evaluate(() => { window.dispatchEvent(new Event('gallery:chatgpt-signed-in')); });
      await page.waitForSelector('[data-provider="ChatGPT"] button[aria-label="Disconnect ChatGPT"]');

      // The sign-in's own tab took the front; a background tab draws no frames to click through.
      for (const other of await page.browser().pages()) if (other !== page) await other.close();

      await page.bringToFront();

      await page.click('[data-settings-section="models"]');
      await page.waitForSelector('[data-model-picker="default model"]');
      await page.click('[data-model-picker="default model"]');
      await page.waitForSelector('[role="option"]');

      expect(await page.$$eval('[role="option"]', (options) => options.map((option) => option.textContent ?? '').join(' | '))).toContain('GPT-5.5');
      await page.close();
    });
  });

  test("a catalog provider's key brings its model into the menus as the default, and disconnecting takes both away", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=usersettingsstate&section=providers`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => { window.dispatchEvent(new Event('gallery:settings-heal')); });

      // Groq from the catalog, by its name, and its key.
      await page.waitForSelector('input[placeholder^="Search providers"]');
      await page.type('input[placeholder^="Search providers"]', 'Groq');
      await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.trim() === 'Groq'));
      await page.$$eval('[role="option"]', (options) => {
        const groq = options.find((option) => option.textContent?.trim() === 'Groq');

        if (groq instanceof HTMLElement) groq.click();
      });
      await page.waitForSelector('input[aria-label="API key"]');
      await page.type('input[aria-label="API key"]', 'gsk_gallery');
      await page.click('input[aria-label="API key"] ~ button[type="submit"]');
      await page.waitForSelector('[data-provider="Groq"] button[aria-label="Disconnect Groq"]');

      // Its model is offered, and chosen as the account's default it is saved as such.
      const menu = async () => {
        await page.click('[data-settings-section="models"]');
        await page.waitForSelector('[data-model-picker="default model"]');
        await page.click('[data-model-picker="default model"]');
        await page.waitForSelector('[role="option"]');

        return page.$$eval('[role="option"]', (options) => options.map((option) => option.textContent?.trim() ?? ''));
      };

      // Each option also carries its own Test control; the model is the name it starts with.
      const offersLlama = (labels: readonly string[]) => labels.some((label) => label.startsWith('Llama 3.3 70B'));

      expect(offersLlama(await menu())).toBe(true);
      await page.$$eval('[role="option"]', (options) => {
        const llama = options.find((option) => option.textContent?.trim().startsWith('Llama 3.3 70B') === true);

        if (llama instanceof HTMLElement) llama.click();
      });
      // The tier is a draft until saved: the save bar offers Save while it is; saved, it says so and leaves.
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('[data-save-bar] button')].some((button) => button.textContent?.trim() === 'Save' && !button.disabled));
      await page.$$eval('[data-save-bar] button', (buttons) => {
        const save = buttons.find((button) => button.textContent?.trim() === 'Save');

        if (save instanceof HTMLElement) save.click();
      });
      await page.waitForFunction(() => {
        const bar = document.querySelector('[data-save-bar]');

        return bar === null || bar.textContent?.includes('Saved') === true;
      });
      expect(await page.evaluate(async () => JSON.stringify(await (await fetch('/api/user/profile-catalog')).json())))
        .toContain('"default":{"model":"groq/llama-3.3-70b-versatile"');

      // Disconnected after its warning, the key and the model go together.
      await page.keyboard.press('Escape');
      await page.click('[data-settings-section="providers"]');
      await page.waitForSelector('[data-provider="Groq"] button[aria-label="Disconnect Groq"]');
      await page.click('[data-provider="Groq"] button[aria-label="Disconnect Groq"]');
      await page.waitForSelector('[role="dialog"]');
      await page.$$eval('[role="dialog"] button', (buttons) => {
        const confirm = buttons.find((button) => button.textContent?.trim() === 'Disconnect');

        if (confirm instanceof HTMLElement) confirm.click();
      });
      await page.waitForFunction(() => document.querySelector('[data-provider="Groq"] button[aria-label="Disconnect Groq"]') === null);
      expect(offersLlama(await menu())).toBe(false);
      await page.close();
    });
  });
});
