/**
 * The browser toolkit: opening a workspace page, waiting on its own socket frames and controls, the inspector and the
 * composer. The product flows drive pages with it (`scripts/product-flows.ts`), and so does every other browser row,
 * which loads none of the flows by needing a wait.
 */
import type { Browser, ElementHandle, Page } from 'puppeteer';
import * as v from 'valibot';
import { hostedActorSocketPath, JsonValueSchema, redactSecrets, type JsonValue } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { evalWorkspaceName } from '@kinu.run/test-utils';
import { beatWorkspace } from '../evals/src/session';
import { signedInPage } from '../evals/src/browser';
import { createWorkspace, deleteWorkspace, type PublicWebIdentity } from '../evals/src/workspace-roster';
import { holdForRelease } from '../packages/test-utils/src/scratch';
import { documentScriptFailures, explained, FAILED_APP_SCRIPT, SCRIPT_FAILED, type ScriptFailure } from './script-failures';


export interface FlowTarget {
  readonly browser: Browser;
  readonly origin: string;
  readonly identity: PublicWebIdentity;
}

/** The error text Chrome fails the requests in flight with when a host network interface comes or goes: not the
 *  product. Seen twice on 2026-09-24, each time as a container started on this host and NetworkManager added its
 *  veth: in a sweep, and in a deploy's slate-opens row, whose module graph failed while the next row loaded the
 *  same page a second later. The one error a wait retries, once per page ({@link until}); every other failure of
 *  a page's scripts stays a dead end. */
export const HOST_NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED';

/** A request the page or the browser cancelled, such as a navigation leaving: the effect of a failure, never its
 *  cause, so it neither makes nor breaks a host network change. */
const CANCELLED = 'net::ERR_ABORTED';

/** The failure that makes a failed module graph the host's network changing, or null when anything else failed
 *  too, or nothing did. */
export function hostNetworkChange(failures: readonly ScriptFailure[]): ScriptFailure | null {
  const causes = failures.filter((failure) => failure.reason !== CANCELLED);

  return causes.length > 0 && causes.every((failure) => failure.reason === HOST_NETWORK_CHANGED) ? causes[0] : null;
}

export const reloaded = new WeakSet<Page>();

/** Reloads `page` once when its dead end is a module graph the host's network change failed, and says so. */
async function reloadedAfterNetworkChange(page: Page, what: string, deadEnd: string): Promise<boolean> {
  if (!deadEnd.startsWith(SCRIPT_FAILED) || reloaded.has(page)) return false;
  const change = hostNetworkChange(await documentScriptFailures(page));

  if (change === null) return false;
  reloaded.add(page);
  process.stderr.write(`  the host's network changed while the page loaded (${HOST_NETWORK_CHANGED} on ${change.url}): `
    + `reloading it once, still waiting for ${what}\n`);
  await page.reload({ waitUntil: 'load' });

  return true;
}

/** A workspace made for one row through the app's own create route, with no
 *  mission, so no turn runs before the row's own. */
/** The beat each row's workspace keeps until it is removed, so no eval run's sweep takes it mid-row. */
const beats = new Map<string, () => void>();

export async function createFlowWorkspace(target: FlowTarget, subject: string): Promise<string> {
  const name = await createWorkspace(target.origin, target.identity, { name: evalWorkspaceName(`browser-${subject}`) });

  beats.set(name, beatWorkspace(target.origin, target.identity, name));

  return name;
}

/** Delete the row's workspace, the same DELETE the sidebar's Remove issues. A
 *  failed teardown is reported, never thrown over the row's own verdict. */
export async function removeFlowWorkspace(target: FlowTarget, workspace: string): Promise<void> {
  beats.get(workspace)?.();
  beats.delete(workspace);

  try {
    await deleteWorkspace(target.origin, target.identity, workspace);
  } catch (error) {
    console.warn(`product-flows: removing ${workspace} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The chat column, `#chat` — the id the workspace shell gives that panel. A
 *  live pane there has a composer its socket has enabled; a pane still
 *  connecting renders no composer at all (`WorkspacePage` returns the notice
 *  instead). Scoped on purpose: a textarea in the inspector column answers a
 *  page-wide query and is not a composer. */
export const CHAT_COMPOSER_LIVE = `[...document.querySelectorAll('#chat textarea')].some(t => !t.disabled)`;

/** The workspace bar's chats, Main first. */
export const CHATS = 'nav[aria-label="Chats"]';

/** The opening every flow gives a chat it starts: the bar's + asks for one, and the scripted model answers it. */
const NEW_CHAT_OPENING = 'Reply with one word: ready.';

/** The chat column's Send control is back to sending, so no turn is running:
 *  while one runs, the same control steers it instead. */
export const CHAT_IDLE = `[...document.querySelectorAll('#chat button')].some((el) => el.getClientRects().length > 0
  && /send$/iu.test((el.getAttribute('aria-label') ?? '').trim()))`;

/** What stops a row dead: an app script that never loaded, which leaves the
 *  page blank; a turn the socket reported ended in error, which the page may
 *  never show as ended; the welcome page, which stands in front of every route
 *  until the account finishes setup, once it offers its next step again (while
 *  it saves one, Next and Finish setup are disabled, and a save that fails
 *  enables them beside its error); or a failure the page shows, the product
 *  saying why the thing asked for will not come: a danger notice, or what a
 *  load that failed or a view that crashed draws in its place (`data-failure`).
 *  A Drive whose listing failed draws no section and no empty state, so a wait
 *  for either outlived the failure it showed (2026-09-24, 36 minutes). */
export const FILES_FAILURE = `(() => {
  const error = document.querySelector('[data-files-list] > .p-danger');
  const text = error?.getClientRects().length > 0 ? (error.textContent ?? '').trim() : '';
  return text === '' ? null : 'a failed Files listing: ' + text;
})()`;

const DEAD_END = `(() => {
  const files = ${FILES_FAILURE};
  if (files !== null) return files;
  const script = ${FAILED_APP_SCRIPT};
  if (script !== null) return script;
  const failed = (window.__turnErrors ?? []).at(-1);
  if (failed !== undefined) return 'a turn that ended in error: ' + failed;
  const welcomeOffers = [...document.querySelectorAll('button')].some((b) => !b.disabled && b.getClientRects().length > 0
    && ['Next', 'Finish setup'].includes((b.textContent ?? '').trim()));
  if (location.pathname === '/welcome' && welcomeOffers) {
    const said = [...document.querySelectorAll('.p-danger')].map((el) => (el.textContent ?? '').trim()).join(' ');
    return 'the welcome page, which the account has not finished' + (said === '' ? '' : ': ' + said);
  }
  const notice = [...document.querySelectorAll('.p-notice-danger, [data-notice="danger"], [data-failure]')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => (el.textContent ?? '').trim())
    .find((text) => text !== '');
  return notice === undefined ? null : 'a notice: ' + notice;
})()`;

/** The waits open now, by what they wait for. No wait has a clock: one whose condition never comes is ended by
 *  the row's deadline, whose SIGTERM runs the hold below, so the run ends naming the wait and not only the row. */
export const openWaits = new Set<{ readonly what: string }>();

/** Each live frame ledger's account of the traffic since its restart, printed with the open waits it may hold. */
const liveLedgers = new Set<() => string>();

/** What each live page sent and was answered since its ledger's last restart: the account a wait ended from outside
 *  names beside itself, so a page whose asks stopped says whether they were never sent, sent and unanswered, or sent
 *  on a socket that had closed (2026-10-17, production's desktop-resize row: six minutes on one wait, named alone). */
export function pagesTraffic(): string {
  return [...liveLedgers].map((account) => `the page's traffic since its ledger's last restart: ${account()}`).join('\n');
}

let dropWaitsHold: (() => void) | null = null;

/** `wait`, logged by what it waits for when it opens and when it is reached, and named while it is open. A step
 *  that is not a wait on a page (a create through the API, a navigation) is named through it too, so a slow run's
 *  log accounts for every second, not only the page waits. */
export async function named<Value>(what: string, wait: () => Promise<Value>): Promise<Value> {
  const open = { what };
  const started = performance.now();

  openWaits.add(open);
  dropWaitsHold ??= holdForRelease('the open waits', () => {
    process.stderr.write(`ended while waiting for ${[...openWaits].map((pending) => pending.what).join('; ')}\n`);

    for (const account of liveLedgers) process.stderr.write(`  the page's traffic since its ledger's last restart: ${account()}\n`);
  });
  process.stderr.write(`  waiting for ${what}\n`);

  try {
    const value = await wait();

    process.stderr.write(`  ${what} after ${((performance.now() - started) / 1000).toFixed(1)} s\n`);

    return value;
  } finally {
    openWaits.delete(open);

    if (openWaits.size === 0) {
      dropWaitsHold();
      dropWaitsHold = null;
    }
  }
}

/** Wait until `condition` holds in the page, or fail at once naming the dead end
 *  the page shows instead (a page opened without {@link recordDeadEnds}
 *  cannot show a failed turn or a script that never loaded). A module graph the
 *  host's network change failed is the one exception: the page is reloaded once
 *  and the condition waited for again ({@link HOST_NETWORK_CHANGED}). */
export async function until(page: Page, what: string, condition: string): Promise<void> {
  await named(what, async () => {
    for (;;) {
      const outcome = String(await (await page.waitForFunction(`${FILES_FAILURE} ?? ((${condition}) ? 'reached' : ${DEAD_END})`, { polling: 100 })).jsonValue());

      if (outcome === 'reached') return;

      if (!(await reloadedAfterNetworkChange(page, what, outcome))) {
        const evidence = outcome.startsWith('a failed Files listing:') ? await filesFailureAccount(page) : '';

        throw new Error(`waiting for ${what}, the page showed ${await explained(page, outcome)}${evidence === '' ? '' : `; Files evidence: ${evidence}`}`);
      }
    }
  });
}

/** Wait on a promise the page cannot be polled for, such as a turn closing on its socket, named as {@link until}
 *  names its waits and ended as it ends them: by the first dead end `page` shows. Never by a reload: the promise
 *  belongs to the document it waits on. */
export async function waitOn<Value>(page: Page, what: string, promise: Promise<Value>): Promise<Value> {
  return named(what, async () => {
    const reached = new AbortController();

    const deadEnd = page.waitForFunction(DEAD_END, { polling: 100, signal: reached.signal }).then(async (handle) => {
      throw new Error(`waiting for ${what}, the page showed ${await explained(page, String(await handle.jsonValue()))}`);
    });

    try {
      return await Promise.race([promise, deadEnd]);
    } finally {
      reached.abort();
    }
  });
}

export async function openWorkspacePage(target: FlowTarget, path: string): Promise<Page> {
  const page = await signedInPage(target.browser, target);
  // From before the first load, for the page's life: what a wait ended on it from outside names (`pagesTraffic`).
  await frameLedger(page);

  // 'load', not 'networkidle0': the app holds its event socket open from
  // first paint, so there is never a zero-connection window to wait for.
  await page.goto(`${target.origin}${path}`, { waitUntil: 'load' });
  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);

  return page;
}

/** Put `text` into the chat column's live composer and read it back; the
 *  composer, to press Send on. One insertion, the way a paste lands: typed key
 *  by key at machine speed, the live composer dropped characters on b220f59f8
 *  ("flow-pobe.txt") and under the 2026-09-24 sweep's load ("say whatis"). */
export async function typeIntoComposer(page: Page, text: string): Promise<ElementHandle<Element>> {
  const composer = await page.$('#chat textarea:not([disabled])');

  if (composer === null) throw new Error('no live composer in the chat column');

  await composer.focus();
  await page.keyboard.sendCharacter(text);

  // Keys the page sent elsewhere never arrive, and a send of nothing never
  // shows: the composer is read back before anything is sent.
  const typed = v.parse(v.string(), await composer.evaluate((box) => (box instanceof HTMLTextAreaElement ? box.value : '')));

  if (typed !== text) throw new Error(`the composer holds ${JSON.stringify(typed)}, not the words typed into it`);

  return composer;
}

/** Type into the chat column's live composer and press its Send; resolves once
 *  the pane shows the words and the turn they started has ended. */
/** + then the first message, as a person opens a chat; resolves once that opening turn has closed. Send is back
 *  before the page learns the turn began, and a message sent then steers it: the agent-plan row's Plan ask became a
 *  steer of the Auto opening, which offered no submit_plan (staging, 2026-10-08). The turn's close on the socket is
 *  its end. */
export async function startNewChat(page: Page): Promise<void> {
  const ledger = await frameLedger(page);

  try {
    await page.click(`${CHATS} a[aria-label="New chat"]`);
    await until(page, 'the new-chat question', `document.querySelector('[data-new-chat] textarea') !== null`);
    await page.type('[data-new-chat] textarea', NEW_CHAT_OPENING);
    await page.click('[data-new-chat] button[type="submit"]');
    await until(page, "the new chat's page", `location.pathname.includes('/agents/')`);
    await until(page, 'the opening in the chat column',
      `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(NEW_CHAT_OPENING)})`);
    await waitOn(page, "the opening turn's close on its socket", ledger.turnClosed());
    await until(page, "the opening turn's end, Send offered again", CHAT_IDLE);
  } finally {
    await ledger.stop();
  }
}

/** Send is back before the page learns the turn began, so the turn's close on the socket is its end: read as idle
 *  0.7 s after the send, the changes-storm row went on before its seed was written (staging, 2026-10-08). */
export async function sendAndSettle(page: Page, text: string): Promise<void> {
  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);

  const composer = await typeIntoComposer(page, text);
  const ledger = await frameLedger(page);

  try {
    await composer.press('Enter');
    await until(page, 'the sent words in the chat column',
      `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(text)})`);
    await waitOn(page, "the turn's close on its socket", ledger.turnClosed());
    await until(page, "the turn's end, Send offered again", CHAT_IDLE);
  } finally {
    await ledger.stop();
  }
}

const FrameSchema = v.object({
  type: v.string(), id: v.optional(v.string()), method: v.optional(v.string()), done: v.optional(v.boolean()),
  args: v.optional(v.array(JsonValueSchema)), result: v.optional(JsonValueSchema), error: v.optional(JsonValueSchema),
});

const filesReplies = new WeakMap<Page, { args: readonly JsonValue[]; result?: JsonValue; error?: JsonValue }>();

async function filesFailureAccount(page: Page): Promise<string> {
  const visible = v.parse(v.object({ path: v.string(), listing: v.nullable(v.string()), error: v.nullable(v.string()) }), await page.evaluate(() => ({
    path: location.pathname,
    listing: document.querySelector('[data-files-list]')?.textContent ?? null,
    error: document.querySelector('[data-files-list] > .p-danger')?.textContent ?? null,
  })));

  return redactSecrets(JSON.stringify({ getExecutorFiles: filesReplies.get(page) ?? null, visible }));
}

/** The page's socket traffic, read off its frames over CDP: the RPCs it asked,
 *  by id, which of them has had its final answer, and the kinds of frame the
 *  workspace has sent it. Everything counts from the last {@link
 *  FrameLedger.restart}. */
export interface FrameLedger {
  /** Resolves once every one of `methods` has been answered and nothing the
   *  page asked is still unanswered. */
  quietAfter(...methods: readonly string[]): Promise<void>;
  /** Whether every named method has an answer and no current-document call is unanswered. */
  quiet(...methods: readonly string[]): boolean;
  /** Resolves once a frame of `type` has arrived. */
  received(type: string): Promise<void>;
  /** Resolves once the workspace has closed a turn: its chat response's last
   *  frame, which every socket gets, the pages that sent none included. */
  turnClosed(): Promise<void>;
  restart(): void;
  stop(): Promise<void>;
}

export async function frameLedger(page: Page): Promise<FrameLedger> {
  const cdp = await page.createCDPSession();

  await cdp.send('Network.enable');
  await cdp.send('Page.enable');

  /** An ask is keyed by its socket and its id: ids restart per socket, so two sockets or two loads reuse them. */
  interface Ask { readonly socket: string; readonly method: string; readonly args: readonly JsonValue[] }

  const asked = new Map<string, Ask>();
  const answered = new Set<string>();
  const arrived = new Set<string>();
  let closed = false;
  let waiters: { readonly ready: () => boolean; readonly resolve: () => void }[] = [];

  const frame = (payload: string | undefined): v.InferOutput<typeof FrameSchema> | null => {
    const parsed = v.safeParse(FrameSchema, tolerate<unknown>(() => JSON.parse(payload ?? ''), 'malformed-input'));

    return parsed.success ? parsed.output : null;
  };

  const check = (): void => {
    waiters = waiters.filter((waiter) => {
      if (!waiter.ready()) return true;
      waiter.resolve();

      return false;
    });
  };

  const wait = (ready: () => boolean): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();

    waiters.push({ ready, resolve });
    check();

    return promise;
  };

  /** Each socket's path by CDP request id, and what the page sent over each since the restart. */
  const socketPaths = new Map<string, string>();
  const retiredSockets = new Set<string>();
  const framesSent = new Map<string, number>();
  const framesReceived = new Map<string, number>();
  const requests = new Map<string, number>();
  // What the page itself threw or logged as an error, newest last.
  const errors: string[] = [];
  const failed = (said: string): void => { errors.push(said.slice(0, 300)); errors.splice(0, Math.max(0, errors.length - 5)); };

  page.on('pageerror', (error) => { failed(`thrown: ${error instanceof Error ? error.message : String(error)}`); });
  page.on('console', (message) => { if (message.type() === 'error') failed(message.text()); });

  const pathOf = (url: string | undefined): string => new URL(url ?? 'ws://unknown/').pathname;
  const tally = (into: Map<string, number>, key: string): void => { into.set(key, (into.get(key) ?? 0) + 1); };

  // A reload can retire a socket without CDP's close event; its late frames still belong to the old document.
  cdp.on('Page.frameNavigated', (event: { frame: { parentId?: string } }) => {
    if (event.frame.parentId !== undefined) return;

    filesReplies.delete(page);

    for (const socket of socketPaths.keys()) retiredSockets.add(socket);

    for (const [key, ask] of asked) {
      if (!retiredSockets.has(ask.socket)) continue;

      asked.delete(key);
      answered.delete(key);
    }

    check();
  });
  cdp.on('Network.webSocketCreated', (event: { requestId: string; url?: string }) => { socketPaths.set(event.requestId, pathOf(event.url)); });
  cdp.on('Network.requestWillBeSent', (event: { request?: { url?: string } }) => { tally(requests, pathOf(event.request?.url)); });
  cdp.on('Network.webSocketFrameSent', (event: { requestId: string; response?: { payloadData?: string } }) => {
    if (retiredSockets.has(event.requestId)) return;

    if (!socketPaths.has(event.requestId)) socketPaths.set(event.requestId, event.requestId);

    const sent = frame(event.response?.payloadData);

    tally(framesSent, socketPaths.get(event.requestId) ?? event.requestId);

    if (sent?.type === 'rpc' && sent.id !== undefined && sent.method !== undefined) {
      asked.set(`${event.requestId} ${sent.id}`, { socket: event.requestId, method: sent.method, args: sent.args ?? [] });
    }
  });
  cdp.on('Network.webSocketFrameReceived', (event: { requestId: string; response?: { payloadData?: string } }) => {
    if (retiredSockets.has(event.requestId)) return;

    tally(framesReceived, socketPaths.get(event.requestId) ?? event.requestId);
    const received = frame(event.response?.payloadData);

    if (received === null) return;
    arrived.add(received.type);
    closed ||= received.type === 'cf_agent_use_chat_response' && received.done === true;

    // A streamed answer's chunks carry `done: false`; only its last frame, or
    // a plain answer, ends the ask.
    if (received.type === 'rpc' && received.id !== undefined && received.done !== false) {
      const key = `${event.requestId} ${received.id}`;
      const ask = asked.get(key);

      if (ask?.method === 'getExecutorFiles') filesReplies.set(page, {
        args: ask.args,
        ...(received.result !== undefined && { result: received.result }),
        ...(received.error !== undefined && { error: received.error }),
      });

      answered.add(key);
    }

    check();
  });
  // A socket that closed will answer nothing more: its open asks are retired, as the page's own client rejects them.
  cdp.on('Network.webSocketClosed', (event: { requestId: string }) => {
    retiredSockets.add(event.requestId);

    for (const [key, ask] of asked) if (ask.socket === event.requestId && !answered.has(key)) asked.delete(key);

    check();
  });

  /** What the page asked and sent since the restart: each method's count and the asks still unanswered with their
   *  socket, the frames sent per socket, and the requests sent per path. */
  const account = (): string => {
    const counts = new Map<string, number>();

    for (const ask of asked.values()) tally(counts, ask.method);

    const counted = (from: Map<string, number>): string => [...from].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([name, times]) => `${name} ×${String(times)}`).join(', ') || 'none';

    const open = [...asked].filter(([key]) => !answered.has(key))
      .map(([key, ask]) => `${ask.method} #${key.split(' ')[1] ?? ''} on ${socketPaths.get(ask.socket) ?? ask.socket}`);

    const sockets = [...socketPaths].map(([id, path]) => `${path} ${retiredSockets.has(id) ? 'closed' : 'open'}`);

    return `rpc: ${counted(counts)}; unanswered: ${open.join(', ') || 'none'}; frames sent: ${counted(framesSent)}; `
      + `frames received: ${counted(framesReceived)}; sockets: ${sockets.join(', ') || 'none'}; requests: ${counted(requests)}; `
      + `page errors: ${errors.join(' | ') || 'none'}`;
  };

  liveLedgers.add(account);
  // A closed page's session ends with it, and it has nothing more to account for.
  page.once('close', () => {
    liveLedgers.delete(account);
    filesReplies.delete(page);
  });

  const quiet = (...methods: readonly string[]): boolean =>
    methods.every((method) => [...asked].some(([key, ask]) => ask.method === method && answered.has(key)))
    && [...asked.keys()].every((key) => answered.has(key));

  return {
    quietAfter: (...methods) => wait(() => quiet(...methods)),
    quiet,
    received: (type) => wait(() => arrived.has(type)),
    turnClosed: () => wait(() => closed),
    restart() {
      asked.clear();
      answered.clear();
      arrived.clear();
      framesSent.clear();
      framesReceived.clear();
      requests.clear();
      filesReplies.delete(page);
    },
    stop: async () => {
      liveLedgers.delete(account);
      filesReplies.delete(page);
      await cdp.detach();
    },
  };
}

/** Resolves once every one of `methods` has been answered and the page has
 *  nothing unanswered across a painted frame: an answer that sets off a
 *  further ask (the roster read after the snapshot) keeps the wait going. */
export async function settledAfter(page: Page, ledger: FrameLedger, ...methods: readonly string[]): Promise<void> {
  do {
    await ledger.quietAfter(...methods);
    await painted(page);
  } while (!ledger.quiet(...methods));
}

/** Two animation frames: whatever the last answer set in motion has painted. */
export async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); });
  }));
}

/** Observes the page's function timers without adding or advancing one: replay completion may leave a
 *  throttled render queued. String timers retain the browser's own semantics. */
const RECORD_PAGE_TASKS = `(() => {
  const schedule = window.setTimeout.bind(window);
  const cancel = window.clearTimeout.bind(window);
  const pending = new Map();
  window.__pageTasks = pending;
  window.setTimeout = function (handler, delay, ...args) {
    if (typeof handler !== 'function') return schedule(handler, delay, ...args);
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const id = schedule(function () {
      try { Reflect.apply(handler, window, args); }
      finally { pending.delete(id); finish(); }
    }, delay);
    pending.set(id, { done, finish });
    return id;
  };
  window.clearTimeout = function (id) {
    const key = Number(id);
    const held = pending.get(key);
    cancel(id);
    pending.delete(key);
    held?.finish();
  };
})()`;

export async function recordRenderTasks(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(RECORD_PAGE_TASKS);
}

/** Wait for already-queued work and its paint, never for the value the assertion expects. */
export async function rendered(page: Page): Promise<void> {
  await waitOn(page, 'the page\'s queued render callbacks', page.evaluate(`
    Promise.all([...window.__pageTasks.values()].map(task => task.done))
  `));
  await painted(page);
}

/** Which chat tab is current, by index: 0 is Main, the person's chats
 *  follow in roster order, -1 while none is marked. */
export const ACTIVE_TAB_INDEX = `(() => {
  const tabs = [...document.querySelectorAll('nav[aria-label="Chats"] [data-agent-tab]')];
  return tabs.findIndex((tab) => tab.querySelector('[aria-current="page"]') !== null);
})()`;

/** Where a send landed: the path, the current tab's index, and whether the chat
 *  column still held a live composer as the words went. */
export interface SendSite {
  readonly path: string;
  readonly tabIndex: number;
  readonly composerInChat: boolean;
}

const SendSiteSchema = v.object({ path: v.string(), tabIndex: v.number(), composerInChat: v.boolean() });

/** Type words into the ACTIVE pane's composer, press that pane's own Send, and
 *  wait for the pane to echo them. Scoped to `#chat` throughout: a page-wide
 *  textarea query reaches the inspector column's inputs and a page-wide Send
 *  reaches whatever else is mounted, so the site returned is the honest answer
 *  to which pane the words went into. */
export async function sendInChat(page: Page, text: string): Promise<SendSite> {
  const site = await pressSend(page, text);

  await until(page, 'the sent words in the chat column', `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(text)})`);

  return site;
}

/** As {@link sendInChat}, without the wait for the pane to echo the words: for a send the page may hold back. */
export async function pressSend(page: Page, text: string): Promise<SendSite> {
  await typeIntoComposer(page, text);

  return v.parse(SendSiteSchema, await page.evaluate(`(() => {
    const send = [...document.querySelectorAll('#chat button')]
      .find((el) => el.getClientRects().length > 0
        && /send$|steer the running turn/iu.test((el.getAttribute('aria-label') ?? '').trim()));
    if (send === undefined) throw new Error('no Send control in the chat column');
    send.click();
    return {
      path: location.pathname,
      tabIndex: ${ACTIVE_TAB_INDEX},
      composerInChat: ${CHAT_COMPOSER_LIVE},
    };
  })()`));
}

/** RPC method counts over the socket via CDP, split by direction, beside what
 *  a hosted actor's own socket carried. */
export interface RpcCounts {
  readonly sent: Readonly<Record<string, number>>;
  readonly received: Readonly<Record<string, number>>;
  /** Frames received on an `actor/<name>` socket. Zero after the '+' flow means
   *  the subordinate pane's transport never answered — the shape the hosted
   *  actor socket defect left behind, where the composer stays disabled. */
  readonly actorFrames: number;
}

const SocketFrameSchema = v.object({ method: v.optional(v.string()), type: v.optional(v.string()) });

/** The path segment a hosted actor's socket carries, taken from the builder the
 *  client itself calls rather than a copy of the string. */
const ACTOR_SEGMENT = hostedActorSocketPath('probe').split('/')[0] ?? '';

export interface RpcCounter {
  counts(): RpcCounts;
  stop(): Promise<void>;
}

export async function countRpc(page: Page): Promise<RpcCounter> {
  const cdp = await page.createCDPSession();

  await cdp.send('Network.enable');

  const sent: Record<string, number> = {};
  const received: Record<string, number> = {};
  const actorSockets = new Set<string>();

  let actorFrames = 0;

  const bump = (table: Record<string, number>, payload: string): void => {
    // A frame that is not the JSON envelope is counted as such: parsing it
    // straight would throw inside the CDP handler and take the run with it.
    const parsed = v.safeParse(SocketFrameSchema, tolerate<unknown>(() => JSON.parse(payload), 'malformed-input'));
    const key = parsed.success ? (parsed.output.method ?? parsed.output.type ?? '?') : 'nonjson';

    table[key] = (table[key] ?? 0) + 1;
  };

  cdp.on('Network.webSocketCreated', (event: { requestId?: string; url?: string }) => {
    if (event.requestId === undefined || !(event.url ?? '').includes(`/${ACTOR_SEGMENT}/`)) return;

    actorSockets.add(event.requestId);
  });

  cdp.on('Network.webSocketFrameSent', (event: { response?: { payloadData?: string } }) => {
    bump(sent, event.response?.payloadData ?? '');
  });
  cdp.on('Network.webSocketFrameReceived', (event: { requestId?: string; response?: { payloadData?: string } }) => {
    bump(received, event.response?.payloadData ?? '');

    if (event.requestId !== undefined && actorSockets.has(event.requestId)) actorFrames += 1;
  });

  return {
    counts: (): RpcCounts => ({ sent: { ...sent }, received: { ...received }, actorFrames }),
    stop: async (): Promise<void> => { await cdp.detach(); },
  };
}

/** The inspector column, `#inspector`: the id `use-inspector-layout` hands the panel and which
 *  `react-resizable-panels` renders on its element. */
export const INSPECTOR_PANEL = `document.querySelector('#inspector')`;

/** The inspector column as a rounded width; -1 when no such box is in the document at all. */
export const INSPECTOR_WIDTH = `(() => {
  const panel = ${INSPECTOR_PANEL};
  return panel === null ? -1 : Math.round(panel.getBoundingClientRect().width);
})()`;

/** A shut inspector column: the library leaves a 0px box, and a hair of border
 *  or padding still counts as shut. */
export const INSPECTOR_SHUT_PX = 40;

export const OPEN_NAMES = 'show|expand|open';

/**
 * The element a measured number is read from, as a page expression: `box`, an element whose geometry is read, or
 * `scroller`, an element whose scroll metrics are read. Absent, the number is a count or a text, which only its own
 * stability can say is settled.
 */
export type Measured = { readonly box: string } | { readonly scroller: string };

/**
 * Whether `target`'s motion can move what is measured. A box moves with itself and its ancestors, and with an in-flow
 * child of any of them: the rail is `main`'s sibling, and its collapse moves `main`. A scroller's metrics move with its
 * box and with anything inside it. Nothing else on the page can move either.
 */
function inScope(measured: Measured): string {
  const element = 'box' in measured ? measured.box : measured.scroller;
  const inside = 'scroller' in measured ? 'el.contains(target) ||' : '';

  return `((target) => {
    const el = ${element};
    if (!(el instanceof Element) || !(target instanceof Element)) return false;
    if (${inside} target.contains(el)) return true;
    const parent = target.parentElement;
    return parent !== null && parent.contains(el) && !['absolute', 'fixed'].includes(getComputedStyle(target).position);
  })`;
}

/**
 * The clockless settle after a press: the measured number equal on two consecutive animation frames, with nothing that
 * could move it in motion. Motion is a finite animation or transition, running or waiting to start, of a property that
 * lays out (not a paint-only one: opacity, colour, shadow, filter), on an element `measured` names as able to move the
 * number. `getAnimations()` flushes pending style, so a transition the press has just set off is counted before it has
 * moved a pixel: equal frames alone read the rail as settled at its open 240 px while its collapse waited pending
 * (2026-09-24, 10 of 40 collapses short of the end state at 6x CPU throttling). Motion anywhere else is not this
 * number's: a decoration restarted elsewhere on the page held this wait forever with the inspector already open at
 * 340 px (real Chrome, 2026-10-14; staging's live-memory row went silent here). A control that does nothing settles at
 * the number it started with, so no deadline is needed to tell an inert control from a slow one.
 */
export async function settled(page: Page, read: string, measured?: Measured): Promise<void> {
  await page.evaluate('window.__liveSettle = undefined');
  await page.waitForFunction(
    `(() => {
      const value = ${read};
      const scoped = ${measured === undefined ? 'null' : inScope(measured)};
      const paintOnly = /^(opacity|visibility|filter|backdrop-filter|clip-path|mask.*|fill|stroke.*|.*color|background.*|box-shadow|text-shadow|outline.*)$/;
      const properties = (animation) => animation instanceof CSSTransition
        ? [animation.transitionProperty]
        : (animation.effect?.getKeyframes() ?? []).flatMap((frame) => Object.keys(frame))
          .filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))
          .map((key) => key.replace(/[A-Z]/g, (upper) => '-' + upper.toLowerCase()));
      const moving = scoped !== null && document.getAnimations().some((animation) =>
        (animation.pending || animation.playState === 'running')
        && animation.effect?.getComputedTiming().endTime !== Infinity
        && properties(animation).some((property) => !paintOnly.test(property))
        && scoped(animation.effect?.target));
      const previous = window.__liveSettle;
      window.__liveSettle = moving ? undefined : value;
      return !moving && previous === value;
    })()`,
    { polling: 'raf' },
  );
}

/** One press: the accessible name of the control clicked, and the number that
 *  press left behind. */
export interface ControlAttempt {
  readonly name: string;
  readonly left: number;
}

/** Click the first visible control whose accessible name matches, is not
 *  excluded by `outside`, and has not been tried; '' when the document holds
 *  no such control. Role and NAME only — `aria-label` or `title`, never a
 *  copied sentence. */
function pressControl(input: {
  names: string; within: string | null; outside: string | null; tried: readonly string[];
}): string {
  const re = new RegExp(input.names, 'iu');
  const root = input.within === null ? document : document.querySelector(input.within);

  if (root === null) return '';

  const nameOf = (el: Element): string => (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').trim();
  const excluded = input.outside;

  const control = [...root.querySelectorAll('button, [role="button"], [role="separator"]')]
    .filter((el) => el.getClientRects().length > 0)
    .filter((el) => excluded === null || el.closest(excluded) === null)
    .find((el) => re.test(nameOf(el)) && !input.tried.includes(nameOf(el)));

  if (control === undefined) return '';

  if (!(control instanceof HTMLElement)) throw new Error('matched control is not an element');

  control.click();

  return nameOf(control);
}

interface PressOutcome {
  readonly attempts: readonly ControlAttempt[];
  /** The measured number where the pressing stopped. */
  readonly value: number;
  readonly reached: boolean;
}

/** Press matching controls in document order until the measured number is what
 *  `reached` asks for, or until no untried candidate is left. Every name is
 *  tried once, so the loop shrinks its own candidate set and ends on its own.
 *  Escape follows each press: a control that raised a menu must not hide the
 *  next candidate behind it, and what the rows measure is the layout left
 *  standing, not a transient overlay. */
export async function pressUntil(page: Page, input: {
  readonly names: string;
  readonly read: string;
  /** The element whose box `read` measures. */
  readonly box: string;
  readonly reached: (value: number) => boolean;
  readonly within?: string;
  readonly outside?: string;
}): Promise<PressOutcome> {
  const attempts: ControlAttempt[] = [];

  // A page behind another gets no animation frames, and `settled` waits on them: the second of three tabs waited
  // forever (staging, 2026-10-08).
  await page.bringToFront();
  let value = v.parse(v.number(), await page.evaluate(input.read));

  while (!input.reached(value)) {
    const name = v.parse(v.string(), await page.evaluate(pressControl, {
      names: input.names,
      within: input.within ?? null,
      outside: input.outside ?? null,
      tried: attempts.map((attempt) => attempt.name),
    }));

    if (name === '') break;

    await named(`the page settled after ${name}`, () => settled(page, input.read, { box: input.box }));
    await page.keyboard.press('Escape');
    await named('the page settled after Escape', () => settled(page, input.read, { box: input.box }));

    value = v.parse(v.number(), await page.evaluate(input.read));
    attempts.push({ name, left: value });
  }

  return { attempts, value, reached: input.reached(value) };
}

/** The column starts collapsed on a workspace that holds nothing worth showing
 *  (`decideInspector`), so a row measuring it opens it through the product's
 *  own control first. A column that refuses to open is B8's finding, and
 *  nothing behind it can be measured. */
export async function openInspector(page: Page): Promise<void> {
  const outcome = await pressUntil(page, {
    names: OPEN_NAMES, read: INSPECTOR_WIDTH, box: INSPECTOR_PANEL, reached: (width) => width > INSPECTOR_SHUT_PX,
  });

  if (outcome.reached) return;

  throw new Error(`the inspector column stayed at ${String(outcome.value)}px; tried ${JSON.stringify(outcome.attempts)}`);
}

/** A selector that finds the inspector's page whose title holds `title` among the bar's pages: its tab, or the bar's
 *  opener of the pages without room, which names them. */
export function inspectorPageListed(title: string): string {
  const quoted = JSON.stringify(title);

  return `nav[aria-label="Pages"] :is(li button[aria-label*=${quoted}], button[aria-haspopup="menu"][title*=${quoted}])`;
}

/** Open the inspector's page whose title holds `title` through its bar: its tab when it has room, else the bar's menu
 *  of the rest. Settles once that page is the open one. */
export async function openInspectorPage(page: Page, title: string, wait = { timeout: 10_000 }): Promise<void> {
  const tab = `nav[aria-label="Pages"] li button[aria-label*=${JSON.stringify(title)}]`;

  await page.waitForSelector(`${tab}, nav[aria-label="Pages"] button[aria-haspopup="menu"]`, wait);

  if (await page.$(tab) === null) {
    if (await page.$('nav[aria-label="Pages"] button[aria-haspopup="menu"][aria-expanded="true"]') === null) {
      await page.click('nav[aria-label="Pages"] button[aria-haspopup="menu"]');
    }

    const item = await page.waitForFunction((wanted: string) => [...document.querySelectorAll('nav[aria-label="Pages"] [role="menuitem"]')]
      .find((entry) => entry.textContent?.includes(wanted) === true) ?? null, wait, title);

    await item.asElement()?.evaluate((entry) => { if (entry instanceof HTMLElement) entry.click(); });
  } else {
    await page.click(tab);
  }

  await page.waitForSelector(`nav[aria-label="Pages"] button[aria-current="true"][aria-label*=${JSON.stringify(title)}]`, wait);
}

/**
 * Every page the inspector's bar holds, by the name it shows: its chips' links (not the actions beside them, "Share Flow
 * probe"), then the pages behind its opener, as its tooltip names them, comma-separated. A page without room is still
 * the bar's. The flows' slate titles hold no comma.
 */
export const PAGE_TABS = `[
  ...[...document.querySelectorAll('#inspector nav[aria-label="Pages"] li button[aria-label]')].map((tab) => tab.getAttribute('aria-label') ?? ''),
  ...(document.querySelector('#inspector nav[aria-label="Pages"] button[aria-haspopup="menu"]')?.getAttribute('title') ?? '').split(', '),
].filter((name, index, names) => name !== '' && names.indexOf(name) === index)`;

/** Open the share dialog only once its capability graph has supplied the limits. */
export async function openSlateShareDialog(page: Page, tile: string): Promise<void> {
  await page.click(`${tile} [data-drive-menu]`);
  await page.click(`${tile} [data-drive-share-slate]`);
  await until(page, 'the share dialog\'s limits', `document.querySelector('[role="dialog"] [data-share-limits]') !== null`);
}

/** Submit the public share when its control can accept the click, then read the created link. */
export async function submitPublicSlateShare(page: Page): Promise<string | null> {
  await page.click('[data-share-access]');
  await page.click('[data-share-access-option="public"]');
  await until(page, 'the public share to be ready', `document.querySelector('[data-share-submit]:not([disabled])') !== null`);
  await page.click('[data-share-submit]');
  await until(page, 'the share to be made', `document.querySelector('[data-share-created]') !== null`);

  return v.parse(v.nullable(v.string()), await page.evaluate(`document.querySelector('[role="dialog"] a[href]')?.href ?? null`));
}

/**
 * The shown session's details line under `scope`: its folder and the ports under it. The folder is the one its element
 * names: its text holds the whole path for a wide pane and the last part for a narrow one (staging f1f0b451b). Only the
 * shown pane's: the column keeps every opened session's pane mounted out of sight (D99).
 */
export const sessionLine = (scope: string) => `(() => {
  const shown = (each) => each.checkVisibility({ visibilityProperty: true });

  return {
    folder: [...document.querySelectorAll('${scope} [data-session-cwd]')].find(shown)?.getAttribute('data-session-cwd') ?? '',
    ports: [...document.querySelectorAll('${scope} [data-session-port]')].filter(shown).map((port) => (port.textContent ?? '').trim()),
  };
})()`;
