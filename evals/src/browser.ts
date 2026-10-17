/**
 * Chrome for the rows and checks that read what a DEPLOYED page draws.
 *
 * A PAGE SIGNS IN AS A PERSON DOES. The deployment accepts the synthetic identity in core's `DEV_IDENTITY_HEADER`
 * and nowhere else, never as a cookie; a browser exchanges that header once, on the app's own origin, for the session
 * cookie any sign-in mints (`POST /api/auth/dev-session`), and the browser scopes the cookie to that origin, socket
 * handshakes included. So a page is the same user the socket half of a row acts as, and no other origin it reaches
 * learns the secret: a header set on the whole page went to a slate's third-party subresources and to foreign
 * sockets (2026-10-14). Everything else is the product: its own bundle, its own socket, its own render.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ElementHandle, type Browser, type BrowserContext, type Frame, type HTTPRequest, type Page } from 'puppeteer';
import * as v from 'valibot';
import { Effect } from 'effect';
import { detach } from '@kinu.run/core/obs';

import { declaredSettings } from '../../scripts/browser-declarations';
import { DESKTOP, withBrowser } from '../../scripts/live-app-harness';
import { DOCUMENT_FAULTS, recordScriptFailures } from '../../scripts/script-failures';
import { launchTestChrome, type TestChrome } from '../../scripts/test-chrome';
import { webHeaders, type PublicWebIdentity, type WorkspaceWeb } from './workspace-roster';
import { appearance, type Appearance } from './appearance';
import { look, type Press, type Sight } from './sight';

/** Chrome, with the pointer and colour scheme declared (`declaredSettings`), as
 *  the gallery and live-app harnesses launch it: it ends with the row's runner. */
export async function openBrowser(): Promise<TestChrome> {
  return launchTestChrome({ args: [declaredSettings({ mouse: true })] });
}

/** Where a page signs in, and as whom. */
export interface SignIn {
  readonly origin: string;
  readonly identity: PublicWebIdentity;
}

/** Each browser's signed-in contexts, one per origin and identity: a cookie jar holds one session per origin, so two
 *  identities in one context would sign each other out, and a page opened outside them stays signed out. */
const signedInContexts = new WeakMap<Browser, Map<string, Promise<BrowserContext>>>();

/** A page signed in as `at.identity` on `at.origin`, the same authority the row's sockets use, so the two halves
 *  cannot be two users looking at two workspaces: at the desktop viewport, recording its dead ends from its first
 *  document ({@link recordDeadEnds}). No default timeout: each wait on it states its own bound, or the case budget
 *  ends it. */
export async function signedInPage(browser: Browser, at: SignIn): Promise<Page> {
  const contexts = signedInContexts.get(browser) ?? new Map<string, Promise<BrowserContext>>();
  const key = JSON.stringify([at.origin, at.identity.kind === 'secret' ? at.identity.account : at.identity.kind]);
  const context = contexts.get(key) ?? signedInContext(browser, at);

  signedInContexts.set(browser, contexts.set(key, context));

  const page = await (await context).newPage();

  page.setDefaultTimeout(0);
  await page.setViewport(DESKTOP);
  await recordDeadEnds(page);

  return page;
}

/** A context holding `identity`'s session on `origin`, through the dev identity's exchange (`POST
 *  /api/auth/dev-session`). A loopback identity needs none: the origin is the boundary, and sends no header. */
async function signedInContext(browser: Browser, { origin, identity }: SignIn): Promise<BrowserContext> {
  const headers = webHeaders(identity);

  return Object.keys(headers).length === 0
    ? await browser.createBrowserContext()
    : await contextSignedInAt(browser, `${origin}/api/auth/dev-session`, headers);
}

/**
 * A context signed in by one exchange, as a person signs in: Chrome navigates to `exchange` as the `POST` carrying
 * `headers`, so the session cookie its answer sets is stored as any sign-in's is, and the headers travel on that one
 * request to that one origin rather than on every request a page makes.
 */
export async function contextSignedInAt(browser: Browser, exchange: string, headers: Readonly<Record<string, string>>): Promise<BrowserContext> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    await page.setRequestInterception(true);
    page.on('request', (request: HTTPRequest) => {
      const signing = request.url() === exchange && request.isNavigationRequest();

      detach(Effect.promise(async () => request.continue(signing ? { method: 'POST', headers: { ...request.headers(), ...headers } } : {})));
    });

    const answer = await page.goto(exchange, { waitUntil: 'load' });

    if (answer === null || !answer.ok()) {
      throw new Error(`signing in at ${exchange} answered ${String(answer?.status() ?? 'nothing')}: ${(await answer?.text() ?? '').slice(0, 200)}`);
    }
  } finally {
    await page.close();
  }

  return context;
}

/** Records, on `window`, every turn the workspace's socket reports ended in
 *  error (the frame the chat renders its error from), which ends a page's
 *  chances for good. Installed before each document's scripts run, so the
 *  socket the app opens is the recorded one. Each socket is a plain WebSocket:
 *  the desktop's client refuses one whose prototype is not WebSocket's
 *  ("Raw channel missing property: send", staging 2026-10-13). */
const RECORD_TURN_ERRORS = `(() => {
  window.__turnErrors = [];
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(Socket, args) {
      const socket = Reflect.construct(Socket, args);
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string' || !event.data.includes('"error":true')) return;
        try {
          const frame = JSON.parse(event.data);
          if (frame.type === 'cf_agent_use_chat_response' && frame.error === true) window.__turnErrors.push(String(frame.body).slice(0, 300));
        } catch {}
      });
      return socket;
    },
  });
})()`;

/** Records, on `window.__slateCalls`, what a slate page is still waiting on and how often it has asked and redrawn: each
 *  call its slate session (`/__rpc`, capnweb over a WebSocket, as `kinu:slate`'s `slate` and `workspace` make them) has
 *  pulled and not yet had answered, a session still connecting with its first calls queued, a count of the calls it has
 *  pulled, and a count of the document's mutations. capnweb sends one message a frame: a call's result is asked for as
 *  `["pull", id]` and answered as `["resolve", id, …]` or `["reject", id, …]` (capnweb 0.12, `RpcSession.send`). A
 *  session that closes answers nothing more. Installed before each document's scripts run, in every frame, so a slate's
 *  own session is recorded. */
const RECORD_SLATE_CALLS = `(() => {
  const waiting = new Set();
  let calls = 0;
  let mutations = 0;
  let sessions = 0;
  window.__slateCalls = { waiting: () => waiting.size, calls: () => calls, mutations: () => mutations, complete: () => document.readyState === 'complete' };
  new MutationObserver(() => { mutations += 1; }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(Socket, args) {
      const socket = Reflect.construct(Socket, args);
      if (new URL(String(args[0]), location.href).pathname !== '/__rpc') return socket;
      const session = sessions += 1;
      const mine = (id) => session + ':' + String(id);
      const connecting = mine('connecting');
      const send = socket.send.bind(socket);
      waiting.add(connecting);
      socket.addEventListener('open', () => { waiting.delete(connecting); });
      socket.addEventListener('close', () => { for (const call of [...waiting]) if (call.startsWith(session + ':')) waiting.delete(call); });
      socket.send = (data) => {
        if (typeof data === 'string' && data.startsWith('["pull",')) {
          calls += 1;
          waiting.add(mine(JSON.parse(data)[1]));
        }
        return send(data);
      };
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string' && /^\\["(resolve|reject)",/.test(event.data)) waiting.delete(mine(JSON.parse(event.data)[1]));
      });
      return socket;
    },
  });
})()`;

/** Records what ends `page`'s chances for good on every document it loads: each app script that failed to load
 *  (script-failures.ts), and each turn its socket reports ended in error; and what its slate pages still wait on
 *  ({@link RECORD_SLATE_CALLS}), which says when one has drawn (`SlateView.settled`). */
export async function recordDeadEnds(page: Page): Promise<void> {
  await recordScriptFailures(page);
  await page.evaluateOnNewDocument(RECORD_TURN_ERRORS);
  await page.evaluateOnNewDocument(RECORD_SLATE_CALLS);
}

/** Records what `page`'s document waits on ({@link RECORD_SLATE_CALLS}) from now: for a saved page set as its content,
 *  which makes no new document for `recordDeadEnds` to record from. */
export async function recordSlateCalls(page: Page): Promise<void> {
  await page.evaluate(RECORD_SLATE_CALLS);
}

/**
 * How long a page has to answer what it was asked: the workspace page to show a slate's frame, the slate to draw what
 * it reads, a click to reach the agent. A page-load budget, as first-run's `PAINT_MS`, not a correctness deadline:
 * what is checked is what the page shows once it has shown it, and one that shows nothing in this long shows a
 * person nothing either.
 */
export const DRAW_MS = 60_000;

const Faults = v.object({ errors: v.array(v.string()), scripts: v.array(v.string()) });

/** What a slate page waits on now (`RECORD_SLATE_CALLS`), asked in the page. */
const WAITING = '({ complete: window.__slateCalls.complete(), waiting: window.__slateCalls.waiting(), calls: window.__slateCalls.calls(), mutations: window.__slateCalls.mutations() })';

const Waiting = v.object({ complete: v.boolean(), waiting: v.number(), calls: v.number(), mutations: v.number() });

/** How far apart `SlateView.settled` looks: a page whose look is unchanged across one poll, with nothing in flight, has
 *  drawn. A render after a call's answer lands within a frame (16 ms), so one poll spans several. */
const SETTLE_POLL_MS = 100;

/** Why a page has not settled, as last found (`found`, and a poll before, `before`), while it owes a press its
 *  `answer`, if it does. */
function settling(found: v.InferOutput<typeof Waiting>, before: v.InferOutput<typeof Waiting> | null, answer: PressAnswer | null): string {
  if (!found.complete) return 'its document still loading';

  if (answer === 'call') return 'its press made no call to its slate';

  if (answer === 'redraw') return 'its press made no call and no redraw';

  return found.waiting === 0 && before !== null ? `it kept calling its slate, ${String(found.calls - before.calls)} call(s) in a poll` : `${String(found.waiting)} call(s) in flight`;
}

/** What a page says when asked one thing it may not hold. */
const Said = v.nullable(v.string());

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

/** The first control a person's accessible name addresses. Kept whole because it runs inside the page. */
function controlNamed(source: string, flags: string): Element | null {
  return [...document.querySelectorAll('button, [role="button"], [role="gridcell"]')]
    .find((element) => new RegExp(source, flags).test((element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent ?? '').trim())) ?? null;
}

/** One slate's page as it is drawn inside the workspace: in the work surface or in the chat. */
/** How a press is answered: by a call to the page's slate (`call`, a press that asks it to change something: a move, a
 *  sign-in, a budget covered), or by a call or a redraw, whichever comes first (`redraw`, a press the page may answer
 *  alone: a square selected, a room opened). */
export type PressAnswer = 'call' | 'redraw';

export class SlateView {
  /** What the page had asked and drawn as it was last pressed, and how it answers, until it has (`settled`). */
  #pressed: { readonly calls: number; readonly mutations: number; readonly answer: PressAnswer } | null = null;

  constructor(readonly frame: Frame) {}

  /** The page as read now: its text, and each name's regions (`sight.ts`). */
  async read(names: readonly string[]): Promise<Sight> {
    return (await bounded('the slate page, read', this.frame.evaluate(look, names, null))).sight;
  }

  /**
   * Once the page has drawn what it reads: its document loaded, and no call to its slate in flight nor a session still
   * connecting at two looks a poll apart, none begun between them (`RECORD_SLATE_CALLS`), so the last answer came a poll
   * before the read, time for the page to draw it; after a press, once the page has answered it too (`PressAnswer`),
   * however long its handler takes to begin. Readiness, never correctness: a page drawn wrong is as settled as one drawn
   * right, so what it shows is read once and judged at once; and a page that keeps redrawing a clock is still settled.
   * Polled from here, not by animation frames, which Chrome stops in a cross-origin frame scrolled out of view. A page
   * still waiting after the draw budget, or that never answers its press, shows a person nothing more either, and fails.
   * Calls are the page's, not the press's: a page that polls its slate settles between two polls (one a second does at
   * once), one that polls faster than a look apart never does, and a poll can answer for a `call` press whose handler
   * has not called yet. Telling a press's calls from the page's own would take the page's code.
   */
  async settled(): Promise<void> {
    const due = Date.now() + DRAW_MS;
    let before: v.InferOutput<typeof Waiting> | null = null;

    for (;;) {
      const now = v.parse(Waiting, await bounded('the slate page, asked what it waits on', this.frame.evaluate(WAITING)));
      const pressed = this.#pressed;

      if (pressed !== null && (now.calls > pressed.calls || (pressed.answer === 'redraw' && now.mutations > pressed.mutations))) this.#pressed = null;

      if (this.#pressed === null && now.complete && now.waiting === 0 && before?.waiting === 0 && before.calls === now.calls) return;

      if (Date.now() >= due) {
        throw new Error(`the slate page did not settle in ${String(DRAW_MS / 1000)} s: ${settling(now, before, this.#pressed?.answer ?? null)}`);
      }

      before = now;
      await sleep(SETTLE_POLL_MS);
    }
  }

  /** What the page had asked and drawn, kept as it is pressed, so `settled` waits for its `answer` to the press. */
  async #press(control: ElementHandle, answer: PressAnswer): Promise<void> {
    const { calls, mutations } = v.parse(Waiting, await this.frame.evaluate(WAITING));

    this.#pressed = { calls, mutations, answer };
    await control.click();
  }

  /** The page once it has drawn (`settled`), read: what every independent check of one state reads, once. */
  async drawn(names: readonly string[]): Promise<Sight> {
    await this.settled();

    return this.read(names);
  }

  /** Press the control `press` names, as a person's pointer does, the page to `answer` it; false when the page has no
   *  such one control. */
  async press(names: readonly string[], press: Press, answer: PressAnswer = 'redraw'): Promise<boolean> {
    return bounded(`the slate page, pressed for ${press.name}`, (async () => {
      const found = await this.frame.evaluateHandle(look, names, press);
      const control = await found.evaluateHandle((looked) => looked.control);

      await found.dispose();

      if (!(control instanceof ElementHandle)) return false;
      await this.#press(control, answer);
      await control.dispose();

      return true;
    })());
  }

  /** Press the first control whose accessible name, its `aria-label`, else its `title`, else its text, `name` matches, the
   *  page to `answer` it. */
  async pressNamed(name: RegExp, answer: PressAnswer = 'redraw'): Promise<boolean> {
    return bounded(`the slate page, pressed for ${name.source}`, (async () => {
      const control = await this.frame.evaluateHandle(controlNamed, name.source, name.flags);

      if (!(control instanceof ElementHandle)) return false;
      await this.#press(control, answer);
      await control.dispose();

      return true;
    })());
  }

  /** What failed in the page: errors nothing caught and scripts that did not load (`script-failures.ts`). */
  async faults(): Promise<{ errors: string[]; scripts: string[] }> {
    return v.parse(Faults, await bounded('the slate page, asked what failed', this.frame.evaluate(DOCUMENT_FAULTS)));
  }

  /** The page's colours and width, over the workspace's own background (`--c-bg`) where the page draws none. */
  async appearance(): Promise<Appearance> {
    const host = v.parse(Said, await bounded('the workspace page, asked its background', this.frame.page().evaluate(HOST_BACKGROUND)));

    return bounded('the slate page, asked how it looks', this.frame.evaluate(appearance, host));
  }

  /** Whether the workspace says over this page that its latest edit did not build (`InlineSlate`'s notice). */
  async broken(): Promise<string | null> {
    return v.parse(Said, await bounded('the workspace page, asked about the build', this.frame.page().evaluate(BROKEN_NOTICE)));
  }
}

/** In the workspace page: its theme's background, as the slate it holds is told it (`SLATE_THEME_TOKENS`). */
const HOST_BACKGROUND = 'getComputedStyle(document.documentElement).getPropertyValue("--c-bg").trim() || null';

/** In the workspace page: the words of a broken-build notice, or null with none. */
const BROKEN_NOTICE = 'document.querySelector("[data-slate-broken]")?.textContent ?? null';

/** A phone's window, as a person holds one. */
export const PHONE = { width: 390, height: 844 } as const;

/** The workspace's pages as its owner opens them, in one Chrome. */
export class WorkspaceBrowser {
  constructor(private readonly browser: Browser, private readonly web: WorkspaceWeb) {}

  /** A fresh page of the workspace at `query`, in the owner's `mode` when one is named, recording what fails in each
   *  document it loads. */
  async open(query = '', mode?: 'light' | 'dark'): Promise<Page> {
    const page = await signedInPage(this.browser, this.web);

    if (mode !== undefined) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
    await bounded('the workspace page', page.goto(`${this.web.origin}/workspace/${encodeURIComponent(this.web.workspace)}${query}`, { waitUntil: 'domcontentloaded' }));

    return page;
  }

  /** The slate `id` opened in the work surface, as the Drive's link to it opens it. */
  async workSurface(id: string, mode?: 'light' | 'dark'): Promise<SlateView> {
    const page = await this.open(`?slate=${encodeURIComponent(id)}`, mode);

    return loaded(await shown(page, `#inspector iframe[title=${JSON.stringify(id)}]`, `the work surface's frame of ${id}`), id);
  }

  /** The page `view` draws, opened on its own in a window of `size`: as it is drawn on a phone. */
  async alone(view: SlateView, size: { readonly width: number; readonly height: number }): Promise<SlateView> {
    const page = await signedInPage(this.browser, this.web);

    await page.setViewport({ ...size, isMobile: true, hasTouch: true });
    await bounded('the slate page, opened alone', page.goto(view.frame.url(), { waitUntil: 'domcontentloaded' }));

    return new SlateView(page.mainFrame());
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

  /** The frames the chat draws the answer's ephemeral slates `ids` in (`<message>/<name>`, `ephemeralSlateId`), in
   *  their order, once each has loaded: an earlier answer's slates, still in the chat, are never among them. */
  async answerSlates(page: Page, ids: readonly string[]): Promise<SlateView[]> {
    return Promise.all(ids.map(async (id) => loaded(await answerFrame(page, id), `ephemeral slate ${id}`)));
  }

  /**
   * Pictures of the answer's ephemeral slates `ids` as a person sees them, in order, for a judge to look at. Taken once
   * every frame's page has drawn (`SlateView.settled`): while the chat is still drawing the answer it replaces its frame
   * elements, and a picture of a replaced one fails as detached (measured 2026-10-07; once loaded, scrolling keeps
   * every frame's document). Each is scrolled into view and pictured from the chat's own document.
   */
  async answerPictures(page: Page, ids: readonly string[]): Promise<Uint8Array<ArrayBuffer>[]> {
    const views = await this.answerSlates(page, ids);

    await Promise.all(views.map((view) => view.settled()));
    const pictures: Uint8Array<ArrayBuffer>[] = [];

    // One at a time: each is scrolled into view to be pictured.
    for (const id of ids) {
      const frame = await answerFrame(page, id);

      await bounded('the chat, scrolled', frame.scrollIntoView());
      pictures.push(new Uint8Array(await bounded('the chat, pictured', frame.screenshot({ type: 'png' }))));
    }

    return pictures;
  }
}

/** The frame of the chat's ephemeral slate `id` (`InlineSlate`'s card for it), once it shows. */
function answerFrame(page: Page, id: string): Promise<ElementHandle> {
  return shown(page, `[data-slate-inline=${JSON.stringify(id)}] iframe`, `the chat's ephemeral slate ${id}`);
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
