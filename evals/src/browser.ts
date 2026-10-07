/**
 * Chrome for the rows and checks that read what a DEPLOYED page draws.
 *
 * THE HEADER IS THE SIGN-IN. The deployment accepts the synthetic identity in
 * core's `DEV_IDENTITY_HEADER` and nowhere else — never as a cookie, deliberately — so
 * `setExtraHTTPHeaders` is what makes a page the same user the socket half of a
 * row acts as. Everything else is the product: its own bundle, its own socket,
 * its own render.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ElementHandle, type Browser, type Frame, type Page } from 'puppeteer';
import * as v from 'valibot';
import { SLATE_UI_ATTRIBUTE } from '@kinu.run/core';

import { declaredSettings } from '../../scripts/browser-declarations';
import { withBrowser } from '../../scripts/live-app-harness';
import { DOCUMENT_FAULTS, recordScriptFailures } from '../../scripts/script-failures';
import { launchTestChrome, type TestChrome } from '../../scripts/test-chrome';
import { webHeaders, type PublicWebIdentity, type WorkspaceWeb } from './session';
import { look, type Press, type Sight } from './sight';

/** Chrome, with the pointer and colour scheme declared (`declaredSettings`), as
 *  the gallery and live-app harnesses launch it: it ends with the row's runner. */
export async function openBrowser(): Promise<TestChrome> {
  return launchTestChrome({ args: [declaredSettings({ mouse: true })] });
}

/** A page signed in as `identity`, the same authority the row's sockets use, so
 *  the two halves cannot be two users looking at two workspaces. No default
 *  timeout: each wait on it states its own bound, or the case budget ends it. */
export async function signedInPage(browser: Browser, identity: PublicWebIdentity): Promise<Page> {
  const page = await browser.newPage();
  const headers = webHeaders(identity);

  if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);
  await page.setViewport({ width: 1440, height: 900 });
  page.setDefaultTimeout(0);

  return page;
}

/**
 * How long a page has to answer what it was asked: the workspace page to show a slate's frame, the slate to draw what
 * it reads, a click to reach the agent. A page-load budget, as first-run's `PAINT_MS`, not a correctness deadline:
 * what is checked is what the page shows once it has shown it, and one that shows nothing in this long shows a
 * person nothing either.
 */
export const DRAW_MS = 60_000;

const Faults = v.object({ errors: v.array(v.string()), scripts: v.array(v.string()) });

/**
 * `work`, or a failure once the draw budget passes. Chrome's own protocol never times out here (`protocolTimeout: 0`,
 * `scripts/test-chrome.ts`), so a page that wedges its renderer would hold a check, its trial and the leg forever; on
 * expiry the check fails, and `browsing` closes Chrome by killing its process group, which needs no answer from it.
 */
async function bounded<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`${what} did not answer in ${String(DRAW_MS / 1000)} s`)); }, DRAW_MS);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** One slate's page as it is drawn inside the workspace: in the work surface or in the chat. */
export class SlateView {
  constructor(readonly frame: Frame) {}

  /** The page as read now: its text, and each name's regions (`sight.ts`). */
  async read(names: readonly string[]): Promise<Sight> {
    return (await bounded('the slate page, read', this.frame.evaluate(look, names, null))).sight;
  }

  /** Read the page until `done` holds or the draw budget passes: the last reading, and whether it held. */
  async until(names: readonly string[], done: (sight: Sight) => boolean): Promise<{ sight: Sight; held: boolean }> {
    const due = Date.now() + DRAW_MS;

    for (;;) {
      const sight = await this.read(names);

      if (done(sight)) return { sight, held: true };

      if (Date.now() >= due) return { sight, held: false };
      await sleep(250);
    }
  }

  /** Press the control `press` names, as a person's pointer does; false when the page has no such one control. */
  async press(names: readonly string[], press: Press): Promise<boolean> {
    return bounded(`the slate page, pressed for ${press.name}`, (async () => {
      const found = await this.frame.evaluateHandle(look, names, press);
      const control = await found.evaluateHandle((looked) => looked.control);

      await found.dispose();

      if (!(control instanceof ElementHandle)) return false;
      await control.click();
      await control.dispose();

      return true;
    })());
  }

  /** What failed in the page: errors nothing caught and scripts that did not load (`script-failures.ts`). */
  async faults(): Promise<{ errors: string[]; scripts: string[] }> {
    return v.parse(Faults, await bounded('the slate page, asked what failed', this.frame.evaluate(DOCUMENT_FAULTS)));
  }
}

/** The workspace's pages as its owner opens them, in one Chrome. */
export class WorkspaceBrowser {
  constructor(private readonly browser: Browser, private readonly web: WorkspaceWeb) {}

  /** A fresh page of the workspace at `query`, recording what fails in each document it loads. */
  async open(query = ''): Promise<Page> {
    const page = await signedInPage(this.browser, this.web.identity);

    await recordScriptFailures(page);
    await bounded('the workspace page', page.goto(`${this.web.origin}/workspace/${encodeURIComponent(this.web.workspace)}${query}`, { waitUntil: 'domcontentloaded' }));

    return page;
  }

  /** The slate `id` opened in the work surface, as the Drive's link to it opens it. */
  async workSurface(id: string): Promise<SlateView> {
    const page = await this.open(`?slate=${encodeURIComponent(id)}`);

    return loaded(await shown(page, `#inspector iframe[title=${JSON.stringify(id)}]`, `the work surface's frame of ${id}`), id);
  }

  /** The chat's latest preview of the slate `id` (`InlineSlate`), unfolded the way a person unfolds it. */
  async chatPreview(page: Page, id: string): Promise<SlateView> {
    const cards = `[data-slate-inline=${JSON.stringify(id)}]`;

    await shown(page, cards, `the chat's preview of ${id}`);
    const card = (await page.$$(cards)).at(-1);

    if (card === undefined) throw new Error(`the chat's preview of ${id} left the page`);
    // A folded card keeps its frame, drawn at no height: a page read there would read as seen.
    await (await card.$('button[aria-expanded="false"]'))?.click();
    await shown(card, 'button[aria-expanded="true"]', `the chat's preview of ${id}, unfolded`);

    return loaded(await shown(card, 'iframe', `the frame of the chat's preview of ${id}`), id);
  }

  /** The frames of the chat's ephemeral slates, oldest first, once the page shows at least `least` of them. */
  async answerSlates(page: Page, least: number): Promise<SlateView[]> {
    return Promise.all((await answerFrames(page, least)).map((frame, index) => loaded(frame, `ephemeral slate ${String(index + 1)}`)));
  }

  /**
   * Pictures of the chat's ephemeral slates as a person sees them, oldest first, for a judge to look at. Taken once every
   * frame's page has loaded and `done` holds of what it shows: while the chat is still drawing the answer it replaces its
   * frame elements, and a picture of a replaced one fails as detached (measured 2026-10-07; once loaded, scrolling keeps
   * every frame's document). Each is scrolled into view and pictured from the chat's own document.
   */
  async answerPictures(page: Page, least: number, names: readonly string[], done: (sight: Sight) => boolean): Promise<Uint8Array<ArrayBuffer>[]> {
    const views = await this.answerSlates(page, least);

    // A page that reads its data draws it after it loads: picture what it shows once it shows it, or the budget passes.
    await Promise.all(views.map((view) => view.until(names, done)));
    const pictures: Uint8Array<ArrayBuffer>[] = [];

    // One at a time: each is scrolled into view to be pictured.
    for (let index = 0; index < views.length; index += 1) {
      const frame = (await answerFrames(page, views.length))[index];

      if (frame === undefined) throw new Error(`the chat no longer shows ephemeral slate ${String(index + 1)}`);
      await bounded('the chat, scrolled', frame.scrollIntoView());
      pictures.push(new Uint8Array(await bounded('the chat, pictured', frame.screenshot({ type: 'png' }))));
    }

    return pictures;
  }
}

/** The chat's ephemeral slate frames, once it shows at least `least` of them. */
async function answerFrames(page: Page, least: number): Promise<ElementHandle[]> {
  const frames = `[${SLATE_UI_ATTRIBUTE}] iframe`;

  try {
    await page.waitForFunction((selector, wanted) => document.querySelectorAll(selector).length >= wanted, { polling: 250, timeout: DRAW_MS }, frames, least);
  } catch (error) {
    throw new Error(`the chat did not show ${String(least)} ephemeral slate(s) in ${String(DRAW_MS / 1000)} s`, { cause: error });
  }

  return page.$$(frames);
}

/** The element `selector` names inside `within`, once it shows; one that never shows fails with what was awaited. */
async function shown(within: Page | ElementHandle, selector: string, what: string): Promise<ElementHandle> {
  let element: ElementHandle | null;

  try {
    element = await within.waitForSelector(selector, { timeout: DRAW_MS });
  } catch (error) {
    throw new Error(`${what} did not show in ${String(DRAW_MS / 1000)} s`, { cause: error });
  }

  if (element === null) throw new Error(`${what} left the page`);

  return element;
}

/** The slate page an iframe holds, once its document has loaded. */
async function loaded(element: ElementHandle, what: string): Promise<SlateView> {
  const frame = await element.contentFrame();

  if (frame === null) throw new Error(`the frame of ${what} has no document`);

  try {
    // The frame first holds its initial about:blank, which is already complete and empty.
    await frame.waitForFunction('location.href !== "about:blank" && document.readyState === "complete"', { polling: 100, timeout: DRAW_MS });
  } catch (error) {
    throw new Error(`the page of ${what} did not load in ${String(DRAW_MS / 1000)} s`, { cause: error });
  }

  return new SlateView(frame);
}

/** A browser row's Chrome (`withBrowser`, which also trusts a loopback dev server's preview zone), running `body`
 *  over the workspace's pages. */
export function browsing<T>(web: WorkspaceWeb, body: (browser: WorkspaceBrowser) => Promise<T>): Promise<T> {
  return withBrowser((browser) => body(new WorkspaceBrowser(browser, web)));
}
