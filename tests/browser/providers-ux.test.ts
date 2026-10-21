/** The providers list in a real browser: Claude's sign-in, pasted code and all, against the gallery's account. */
import { describe, expect, test } from 'bun:test';

import { withGallery } from '../../scripts/gallery-harness';

const CLAUDE = '[data-provider="Claude"]';

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


      // Not connected, its one button is the sign-in.
      await page.click(`${CLAUDE} button`);
      const authorize = await page.waitForSelector(`${CLAUDE} a[href^="https://claude.ai/oauth/authorize"]`);
      expect(authorize).not.toBeNull();

      await page.type(`${CLAUDE} input[aria-label="Claude sign-in code"]`, 'stale-code');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (document.querySelector('[data-provider="Claude"]')?.textContent ?? '').includes('Invalid authorization code'));

      await page.click(`${CLAUDE} input[aria-label="Claude sign-in code"]`, { count: 3 });
      await page.type(`${CLAUDE} input[aria-label="Claude sign-in code"]`, 'good-code');
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${CLAUDE} button[aria-label="Disconnect Claude"]`);

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

      // The sign-in opens its own tab; the page polls the machine until it reports the plan.
      await page.click('[data-provider="ChatGPT"] button');
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
      // The tier is a draft until saved; saved, the button reads Save again, with nothing left to save.
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Save' && !button.disabled));
      await page.$$eval('button', (buttons) => {
        const save = buttons.find((button) => button.textContent?.trim() === 'Save');

        if (save instanceof HTMLElement) save.click();
      });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Save' && button.disabled));
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
