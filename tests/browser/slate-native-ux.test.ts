/**
 * An answer's page in the chat, drawn by the chat itself (1023-ac): no process, no fetch, a sandboxed frame on an opaque
 * origin. It is as tall as what it holds, reads in the chat's theme, reaches nothing of the app's and nothing outside,
 * and can be kept as a slate of the workspace, which the work surface then serves from its preview origin.
 */
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import type { Frame, Page } from 'puppeteer';
import * as v from 'valibot';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appFontFile, SLATE_BRIDGE_MESSAGE, SLATE_FONTS_PATH, SLATE_PAGE_PREAMBLE } from '@kinu.run/core';
import { SLATE_CLIENT_MODULE } from '@kinu.run/core/slates';
import { detach } from '@kinu.run/core/obs';
import { contrast, rgba, withGallery, type Rgba } from '../../scripts/gallery-harness';
import { inspectorPageListed, PAGES_NAV } from '../../scripts/browser-page';
import { TEST_REQUIREMENTS } from '../../scripts/test-requirements';

/** The kept slate's page, as its preview origin serves it to the work surface. */
const PAGE = `<!doctype html><html><head><title>500s by route</title></head><body>
<h1>Errors</h1><p id="plain">/api/health leads this week.</p><ul id="rows">${'<li>/api/health</li>'.repeat(12)}</ul>
</body></html>`;

/** The vendor modules the page imports beside `kinu:slate`: only what the client module names, none of it run here. */
const VENDOR = new Map([
  ['/__kinu/react.js', 'export const createElement = () => null; export const useMemo = (make) => make(); '
    + 'export const useSyncExternalStore = (_subscribe, read) => read(); export const createRoot = () => ({ render() {} });'],
  ['/__kinu/capnweb.js', 'export const newWebSocketRpcSession = () => ({ onRpcBroken() {} });'],
]);

/** The preview origin, answered as the runner answers it: the page opened with its head, and the modules it imports. */
async function servePage(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request) => detach(Effect.promise(async () => {
    const url = new URL(request.url());

    if (!url.hostname.endsWith('.preview.example.test')) {
      await request.continue();

      return;
    }

    if (url.pathname === '/__kinu/slate.js') {
      await request.respond({ status: 200, contentType: 'text/javascript', body: SLATE_CLIENT_MODULE });

      return;
    }

    // The app's faces, as a preview host serves them on its own origin.
    const face = url.pathname.startsWith(SLATE_FONTS_PATH) ? appFontFile(url.pathname.slice(SLATE_FONTS_PATH.length)) : null;

    if (face !== null) {
      await request.respond({ status: 200, contentType: 'font/woff2', body: await readFile(join(FONTS, face)) });

      return;
    }

    const vendor = VENDOR.get(url.pathname);

    if (vendor !== undefined) {
      await request.respond({ status: 200, contentType: 'text/javascript', body: vendor });

      return;
    }

    await request.respond({ status: 200, contentType: 'text/html', body: PAGE.replace('<html>', `<html>${SLATE_PAGE_PREAMBLE}`) });
  })));
}

/** The files the app ships, which ASSETS serves on the deployment. */
const FONTS = join(import.meta.dir, '../../packages/cf-backend/public/assets/fonts');

const CARD = '[data-slate-inline="pg-a1/errors"]';

/** The answer's page in a workspace's chat, once it has said its height and is drawn. The preview origin is answered
 *  for the work surface, which serves the page once it is kept. */
async function openPage(page: Page, origin: string, theme: 'dark' | 'light', viewport: { width: number; height: number }): Promise<Frame> {
  await servePage(page);
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
  await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=page`, { waitUntil: 'networkidle0' });
  await page.waitForFunction((card) => (document.querySelector(`${card} iframe`)?.getBoundingClientRect().height ?? 0) > 0, {}, CARD);
  const frame = await (await page.$(`${CARD} iframe`))?.contentFrame();

  if (frame === undefined || frame === null) throw new Error('the answer page drew no frame');

  return frame;
}

/** One colour painted over another, as the frame's own canvas lies over the chat's surface. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (a: number, b: number): number => a * top.a + b * (1 - top.a);

  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** Once the card has eased to the height its page last said. */
async function eased(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished));
    await new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); });
  });
}

const frameHeight = (page: Page): Promise<number> => page.$eval(`${CARD} iframe`, (frame) => frame.getBoundingClientRect().height);

/** How far the page inside the frame moved when asked to scroll: nothing, when it shows all it holds. */
const innerScroll = (frame: Frame): Promise<number> => frame.evaluate(() => {
  window.scrollTo(0, 400);

  return window.scrollY;
});

const ReachedSchema = v.object({
  cookie: v.string(), storage: v.string(), host: v.string(), out: v.string(), home: v.string(), refused: v.array(v.string()),
});

/** Run in the page: whether it reaches the app's cookie, storage and document, and a request out or to the app. */
const reach = (app: string) => `(async () => {
  const tried = (read) => { try { read(); return 'reached'; } catch { return 'refused'; } };
  const refused = [];
  document.addEventListener('securitypolicyviolation', (event) => { refused.push(event.effectiveDirective); });
  const fetched = (url) => fetch(url).then(() => 'reached', () => 'refused');
  const out = await fetched('https://example.com/');
  const home = await fetched(${JSON.stringify(`${app}/api/health`)});
  const picture = new Image();
  picture.src = 'https://example.com/pixel.png';
  await new Promise((settle) => { picture.onerror = settle; picture.onload = settle; });
  return { cookie: tried(() => document.cookie), storage: tried(() => localStorage.length), host: tried(() => window.parent.document.body),
    out, home, refused: [...new Set(refused)].sort() };
})()`;

describe('an answer\'s page in the chat', () => {
  test('is as tall as what it holds: it scrolls nothing of its own, and grows and shrinks with its rows', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        const frame = await openPage(page, origin, 'dark', { width: 1280, height: 860 });

        expect(await innerScroll(frame)).toBe(0);

        const before = await frameHeight(page);
        await frame.evaluate(() => { document.getElementById('rows')?.insertAdjacentHTML('beforeend', '<li>WELCOME10</li>'.repeat(20)); });
        await page.waitForFunction((card, was) => (document.querySelector(`${card} iframe`)?.getBoundingClientRect().height ?? 0) > was, {}, CARD, before);
        await eased(page);
        expect(await innerScroll(frame)).toBe(0);

        const grown = await frameHeight(page);
        await frame.evaluate(() => { document.getElementById('rows')?.replaceChildren(); });
        await page.waitForFunction((card, was) => (document.querySelector(`${card} iframe`)?.getBoundingClientRect().height ?? 0) < was, {}, CARD, grown);
        await eased(page);
        expect(await innerScroll(frame)).toBe(0);
        expect(await frameHeight(page)).toBeLessThan(before);
      } finally { await page.close(); }
    });
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`reads in the chat's theme, ${theme}: its text is the chat's, in the chat's face, over the chat's own surface`, async () => {
      await withGallery(async ({ newPage, origin }) => {
        const page = await newPage();

        try {
          const frame = await openPage(page, origin, theme, { width: 1280, height: 860 });

          const host = await page.$eval(CARD, (card) => {
            let ground: Element | null = card;

            while (ground !== null && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(ground).backgroundColor)) ground = ground.parentElement;

            // The answer's own words around the page: what the page's text should read as.
            const prose = [...document.querySelectorAll('p')].find((paragraph) => paragraph.textContent?.trim() === '/api/health leads.') ?? document.body;

            return { text: getComputedStyle(prose).color, face: getComputedStyle(prose).fontFamily, ground: getComputedStyle(ground ?? document.body).backgroundColor };
          });

          const inner = await frame.$eval('#plain', (plain) => ({
            text: getComputedStyle(plain).color, face: getComputedStyle(plain).fontFamily, ground: getComputedStyle(document.documentElement).backgroundColor,
          }));

          expect(inner.text).toBe(host.text);
          expect(inner.face).toBe(host.face);
          // The chat's own face is loaded in the frame, not a fallback named the same.
          const family = host.face.split(',')[0]?.trim() ?? '';

          expect(await frame.evaluate(async (face) => (await document.fonts.load(`16px ${face}`)).map((loaded) => loaded.family), family)).not.toEqual([]);
          // The text reads on what is behind it: whatever the page paints over the chat's surface.
          expect(contrast(rgba(inner.text), over(rgba(inner.ground), rgba(host.ground)))).toBeGreaterThanOrEqual(TEST_REQUIREMENTS.wcagTextContrast.values.normal);
        } finally { await page.close(); }
      });
    });
  }

  test('is kept as a slate of the workspace under its title, which the work surface then opens', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        await openPage(page, origin, 'dark', { width: 1280, height: 860 });
        await page.hover(CARD);
        await page.click(`${CARD} button[aria-label="Save errors as a slate"]`);
        await page.waitForSelector(`${CARD} [data-slate-saved="errors-by-route"]`);
        // The saved slate is among the bar's pages: its tab, or the bar's opener of the pages without room.
        await page.waitForSelector(inspectorPageListed('500s by route'));

        await page.hover(CARD);
        await page.click(`${CARD} [data-slate-saved="errors-by-route"]`);
        await page.waitForSelector(`${PAGES_NAV} button[aria-label="500s by route"][aria-current="true"]`);
      } finally { await page.close(); }
    });
  });

  // Its calls cross to its workspace over the port its frame sends the chat (1023-ac), made as the page: the workspace's
  // db, and a method of the block's own server, whose module is inert in the page.
  test("reaches its workspace and its own server through kinu:slate, on the port the chat carries, and hears its pushes", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        const frame = await openPage(page, origin, 'light', { width: 1280, height: 860 });

        await frame.waitForFunction(() => (document.getElementById('served')?.textContent ?? '') !== '' && (document.getElementById('counted')?.textContent ?? '') !== '');

        const drawn = await frame.evaluate(() => ({
          counted: document.getElementById('counted')?.textContent ?? '',
          served: document.getElementById('served')?.textContent ?? '',
          server: document.querySelector('script[type="slate/server"]') !== null,
        }));

        expect(drawn).toEqual({ counted: 'counted {"id":"pg-a1/errors","count":12}', served: 'served errors by route', server: false });

        // What its server pushes unasked reaches it on the same session: this page's, and not another's.
        await page.evaluate(() => {
          for (const [at, word] of [['ch-a1/latency', 'elsewhere'], ['pg-a1/errors', 'live']]) {
            window.dispatchEvent(new CustomEvent('gallery:slate-push', { detail: { page: at, data: { word } } }));
          }
        });
        await frame.waitForFunction(() => (document.getElementById('pushed')?.textContent ?? '') !== '');
        expect(await frame.evaluate(() => document.getElementById('pushed')?.textContent ?? '')).toBe('pushed {"word":"live"}');
      } finally { await page.close(); }
    });
  });

  // A chart drawn with the library kinu:slate provides (1023-ac): served by the app, never reached outside, in the
  // theme's own colours.
  for (const theme of ['light', 'dark'] as const) {
    test(`draws a chart with the library kinu:slate provides, in the ${theme} theme's colours`, async () => {
      await withGallery(async ({ newPage, origin }) => {
        const page = await newPage();

        try {
          await page.setViewport({ width: 1280, height: 860 });
          await page.evaluateOnNewDocument((mode) => localStorage.setItem('theme', mode), theme);
          await page.goto(`${origin}/gallery.html?frame=workspacepage&transcript=chart`, { waitUntil: 'networkidle0' });
          const card = '[data-slate-inline="ch-a1/latency"] iframe[data-slate-drawn="page"]';

          await page.waitForFunction((at) => (document.querySelector(at)?.getBoundingClientRect().height ?? 0) > 0, {}, card);
          const frame = await (await page.$(card))?.contentFrame();

          if (frame === undefined || frame === null) throw new Error('the chart page drew no frame');
          await frame.waitForFunction(() => document.querySelector('.uplot canvas') !== null);

          const drawn = await frame.evaluate(() => {
            const canvas = document.querySelector('.uplot canvas');

            return {
              width: canvas instanceof HTMLCanvasElement ? canvas.width : 0,
              accent: getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim() !== '',
              legend: [...document.querySelectorAll('.u-legend .u-label')].map((label) => label.textContent ?? ''),
            };
          });

          expect(drawn.width).toBeGreaterThan(300);
          expect(drawn.accent).toBe(true);
          expect(drawn.legend).toEqual(['Time', 'p50 ms', 'p95 ms']);
        } finally { await page.close(); }
      });
    });
  }

  // A frame can be navigated to another document that keeps its window and its opaque origin (an external review of
  // 1023-ac): the session is the written document's, so a document the page sends its frame to is refused, even one
  // that copies the written document whole, its nonce included. It is served by the gallery itself: a document the
  // harness made up has no address of its own, and Chrome refuses its import from this loopback app before any bridge.
  test('a document the page sends its frame to is refused through kinu:slate', async () => {
    await withGallery(async ({ newPage, origin, dist }) => {
      const page = await newPage();
      const stolen = join(dist, 'stolen.html');

      try {
        const frame = await openPage(page, origin, 'light', { width: 1280, height: 860 });
        const drawn = `${CARD} iframe[data-slate-drawn="page"]`;

        await frame.waitForFunction(() => (document.getElementById('counted')?.textContent ?? '') !== '');
        const written = await page.$eval(drawn, (element) => element.getAttribute('srcdoc') ?? '');

        const asks = [
          '<body><p id="stolen"></p><script type="module">',
          'import { workspace } from "kinu:slate";',
          'document.getElementById("stolen").textContent = await workspace.db.count({ table: "errors" })',
          '  .then((value) => "answered " + JSON.stringify(value), (refused) => "refused " + refused.message);',
          '</script></body>',
        ].join('\n');

        await writeFile(stolen, written.replace(/<body>[\s\S]*<\/body>/u, asks));
        await frame.evaluate((to) => { location.href = to; }, `${origin}/stolen.html`);
        const away = await page.waitForFrame((each) => each.url() === `${origin}/stolen.html`);

        await away.waitForFunction(() => (document.getElementById('stolen')?.textContent ?? '') !== '');
        expect(await away.evaluate(() => document.getElementById('stolen')?.textContent ?? '')).toStartWith('refused ');
      } finally {
        await page.close();
        await rm(stolen, { force: true });
      }
    });
  });

  // A page that keeps offering ports the chat will not take holds one refusal at a time (security review of 1023-ac):
  // each new offer's session replaces the one before, which closes, so the chat keeps one session per page, not one per
  // offer. Each closed one's call is refused by its closing, the newest by its words.
  test('a page that floods the chat with ports holds one refusal there at a time', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        const frame = await openPage(page, origin, 'light', { width: 1280, height: 860 });

        await frame.waitForFunction(() => (document.getElementById('counted')?.textContent ?? '') !== '');
        // A module of the page's own, so `capnweb` resolves through the page's import map as its scripts' does.
        await frame.evaluate((bridge) => {
          const flood = document.createElement('script');

          flood.type = 'module';
          flood.textContent = [
            'import { newMessagePortRpcSession } from "capnweb";',
            'const offered = Array.from({ length: 4 }, () => {',
            '  const channel = new MessageChannel();',
            `  parent.postMessage({ kinu: ${JSON.stringify(bridge)}, nonce: "not-the-page" }, "*", [channel.port2]);`,
            '  return newMessagePortRpcSession(channel.port1);',
            '});',
            'const answers = await Promise.all(offered.map((session) => session.$workspace(["db", "count"], [{ table: "errors" }])',
            '  .then(() => "answered", (refused) => String(refused.message))));',
            'document.body.dataset.flooded = JSON.stringify(answers);',
          ].join('\n');
          document.body.append(flood);
        }, SLATE_BRIDGE_MESSAGE);
        await frame.waitForFunction(() => document.body.dataset.flooded !== undefined);
        const answers = v.parse(v.array(v.string()), JSON.parse(await frame.evaluate(() => document.body.dataset.flooded ?? '[]')));

        expect(answers.slice(0, 3).every((answer) => answer.includes('closed'))).toBe(true);
        expect(answers[3]).toContain('no longer holds the page');
      } finally { await page.close(); }
    });
  });

  // Opaque and sealed: whatever the page runs, nothing of the app's is within its reach, and nothing outside.
  test('reaches nothing: no cookie, storage or document of the app, no request out, not even to the app', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      try {
        const frame = await openPage(page, origin, 'dark', { width: 1280, height: 860 });
        const sandbox = await page.$eval(`${CARD} iframe`, (element) => (element instanceof HTMLIFrameElement ? [...element.sandbox] : []));

        const reached = v.parse(ReachedSchema, await frame.evaluate(reach(origin)));

        expect(sandbox).not.toContain('allow-same-origin');
        expect(reached).toEqual({ cookie: 'refused', storage: 'refused', host: 'refused', out: 'refused', home: 'refused', refused: ['connect-src', 'img-src'] });
      } finally { await page.close(); }
    });
  });
});
