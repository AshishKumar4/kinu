/**
 * THE PRODUCT'S OWN FLOWS, IN A BROWSER, AS A USER SEES THEM.
 *
 * Every row here drives real Chrome against a real product origin and asserts
 * only what the page shows: a tab, a link, an answer, a preview. The rows run
 * once per deploy, after the publish, against the deployment
 * (`scripts/product-flows-tier.sh`) on the tiers' scripted model (`tierModel`,
 * scripts/tier-model.ts), so they test the product and not a model's
 * compliance. Only a real Worker deployment runs the whole product: under
 * `vite dev` no agent facet loads. The origin arrives as `KINU_ORIGIN`, the
 * model is the account's default, and the identity is resolved from that origin
 * by the eval plane's own resolver, so a row never asks where it runs.
 *
 * WHY THIS EXISTS. The first-run tier reads the deployment over its API and its
 * socket, the eval suite drives the model through the socket, and the
 * `*-ux` browser tests run on the gallery's fixtures. None of them loads the
 * page a person loads, so a workspace whose agents were all present over the
 * API showed none of them after a reload (#13), and every gate stayed green.
 *
 * Waits are conditions, never clocks: the page's own socket frames (read over
 * CDP) and its own controls say when it has settled.
 */
import type { Browser, ElementHandle, Page } from 'puppeteer';
import * as v from 'valibot';
import { hostedActorSocketPath, SLATES_ROOT } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalWorkspaceName, scratchDir } from '@kinu.run/test-utils';
import { beatWorkspace, webHeaders, type PublicWebIdentity } from '../evals/src/session';
import { holdForRelease } from '../packages/test-utils/src/scratch';
import { DESKTOP } from './live-app-harness';
import {
  AGENT_PLAN_ASK, FLOW_MEMORY_NOTE, FLOW_SHELL_PROBE, FLOW_SLATE, MEMORY_ASK, SLATE_ASK, STORM_ASK, STORM_DIR, STORM_FILES, STORM_SEED_ASK, WRITE_FILE_ASK,
  APPROVALS_ASK, DECISION_HEARD, HIRE_APPROVAL_ASK, HIRE_RAN, PROPOSAL_LINK_REPLY, WORKSPACE_PROPOSAL_ASK, ACCOUNT_FACT, ACCOUNT_FACT_ASK,
  ACCOUNT_RECALL_ASK, ACCOUNT_RECALL_REPLY,
} from './flows-script';
import { FALLBACK_ANSWER } from './scripted-protocol';
import {
  documentScriptFailures, explained, FAILED_APP_SCRIPT, recordScriptFailures, SCRIPT_FAILED, type ScriptFailure,
} from './script-failures';

export interface FlowTarget {
  readonly browser: Browser;
  readonly origin: string;
  readonly identity: PublicWebIdentity;
}

/** A page at the desktop viewport with no clock of its own, acting as
 *  `identity` on every request it makes, the socket upgrades included. */
export async function signedInPage(browser: Browser, identity: PublicWebIdentity): Promise<Page> {
  const page = await browser.newPage();
  const headers = webHeaders(identity);

  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);
  await page.setViewport(DESKTOP);

  if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);

  await recordDeadEnds(page);

  return page;
}

/** Records, on `window`, every turn the workspace's socket reports ended in
 *  error (the frame the chat renders its error from), which ends a page's
 *  chances for good. Installed before each document's scripts run, so the
 *  socket the app opens is the recorded one. */
const RECORD_TURN_ERRORS = `(() => {
  window.__turnErrors = [];
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener('message', (event) => {
        if (typeof event.data !== 'string' || !event.data.includes('"error":true')) return;
        try {
          const frame = JSON.parse(event.data);
          if (frame.type === 'cf_agent_use_chat_response' && frame.error === true) window.__turnErrors.push(String(frame.body).slice(0, 300));
        } catch {}
      });
    }
  };
})()`;

/** Records what ends `page`'s chances for good on every document it loads: each app script that failed to load
 *  (script-failures.ts), and each turn its socket reports ended in error. */
export async function recordDeadEnds(page: Page): Promise<void> {
  await recordScriptFailures(page);
  await page.evaluateOnNewDocument(RECORD_TURN_ERRORS);
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

const reloaded = new WeakSet<Page>();

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

const CreatedSchema = v.object({ name: v.string() });

/** A workspace made for one row through the app's own create route, with no
 *  mission, so no turn runs before the row's own. */
/** The beat each row's workspace keeps until it is removed, so no eval run's sweep takes it mid-row. */
const beats = new Map<string, () => void>();

async function createFlowWorkspace(target: FlowTarget, subject: string): Promise<string> {
  const response = await fetch(`${target.origin}/api/user/workspaces`, {
    method: 'POST',
    headers: { ...webHeaders(target.identity), 'content-type': 'application/json' },
    body: JSON.stringify({ name: evalWorkspaceName(`browser-${subject}`) }),
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`creating a workspace answered ${String(response.status)}: ${text.slice(0, 400)}`);
  const { name } = v.parse(CreatedSchema, JSON.parse(text));

  beats.set(name, beatWorkspace(target.origin, target.identity, name));

  return name;
}

/** Delete the row's workspace, the same DELETE the sidebar's Remove issues. A
 *  failed teardown is reported, never thrown over the row's own verdict. */
async function removeFlowWorkspace(target: FlowTarget, workspace: string): Promise<void> {
  beats.get(workspace)?.();
  beats.delete(workspace);

  const response = await fetch(`${target.origin}/api/user/workspaces/${encodeURIComponent(workspace)}`, {
    method: 'DELETE',
    headers: webHeaders(target.identity),
  });

  if (!response.ok) {
    console.warn(`product-flows: removing ${workspace} answered ${String(response.status)}: `
      + `${(await response.text()).slice(0, 200)}`);
  }
}

/** The chat column, `#chat` — the id the workspace shell gives that panel. A
 *  live pane there has a composer its socket has enabled; a pane still
 *  connecting renders no composer at all (`WorkspacePage` returns the notice
 *  instead). Scoped on purpose: a textarea in the inspector column answers a
 *  page-wide query and is not a composer. */
export const CHAT_COMPOSER_LIVE = `[...document.querySelectorAll('#chat textarea')].some(t => !t.disabled)`;

/** The workspace bar's chats, Main first. */
const CHATS = 'nav[aria-label="Chats"]';

/** The opening every flow gives a chat it starts: the bar's + asks for one, and the scripted model answers it. */
const NEW_CHAT_OPENING = 'Reply with one word: ready.';

/** The chat column's Send control is back to sending, so no turn is running:
 *  while one runs, the same control steers it instead. */
const CHAT_IDLE = `[...document.querySelectorAll('#chat button')].some((el) => el.getClientRects().length > 0
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
const DEAD_END = `(() => {
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
  const notice = [...document.querySelectorAll('.p-notice-danger, [data-failure]')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => (el.textContent ?? '').trim())
    .find((text) => text !== '');
  return notice === undefined ? null : 'a notice: ' + notice;
})()`;

/** The waits open now, by what they wait for. No wait has a clock: one whose condition never comes is ended by
 *  the row's deadline, whose SIGTERM runs the hold below, so the run ends naming the wait and not only the row. */
const openWaits = new Set<{ readonly what: string }>();

/** Each live frame ledger's account of the traffic since its restart, printed with the open waits it may hold. */
const liveLedgers = new Set<() => string>();

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
      const outcome = String(await (await page.waitForFunction(`(${condition}) ? 'reached' : ${DEAD_END}`, { polling: 100 })).jsonValue());

      if (outcome === 'reached') return;

      if (!(await reloadedAfterNetworkChange(page, what, outcome))) {
        throw new Error(`waiting for ${what}, the page showed ${await explained(page, outcome)}`);
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

async function openWorkspacePage(target: FlowTarget, path: string): Promise<Page> {
  const page = await signedInPage(target.browser, target.identity);

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
async function startNewChat(page: Page): Promise<void> {
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
async function sendAndSettle(page: Page, text: string): Promise<void> {
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
});

/** The page's socket traffic, read off its frames over CDP: the RPCs it asked,
 *  by id, which of them has had its final answer, and the kinds of frame the
 *  workspace has sent it. Everything counts from the last {@link
 *  FrameLedger.restart}. */
interface FrameLedger {
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
  interface Ask { readonly socket: string; readonly method: string }

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
  const requests = new Map<string, number>();

  const pathOf = (url: string | undefined): string => new URL(url ?? 'ws://unknown/').pathname;
  const tally = (into: Map<string, number>, key: string): void => { into.set(key, (into.get(key) ?? 0) + 1); };

  // A reload can retire a socket without CDP's close event; its late frames still belong to the old document.
  cdp.on('Page.frameNavigated', (event: { frame: { parentId?: string } }) => {
    if (event.frame.parentId !== undefined) return;

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
      asked.set(`${event.requestId} ${sent.id}`, { socket: event.requestId, method: sent.method });
    }
  });
  cdp.on('Network.webSocketFrameReceived', (event: { requestId: string; response?: { payloadData?: string } }) => {
    if (retiredSockets.has(event.requestId)) return;

    const received = frame(event.response?.payloadData);

    if (received === null) return;
    arrived.add(received.type);
    closed ||= received.type === 'cf_agent_use_chat_response' && received.done === true;

    // A streamed answer's chunks carry `done: false`; only its last frame, or
    // a plain answer, ends the ask.
    if (received.type === 'rpc' && received.id !== undefined && received.done !== false) answered.add(`${event.requestId} ${received.id}`);
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

    return `rpc: ${counted(counts)}; unanswered: ${open.join(', ') || 'none'}; frames sent: ${counted(framesSent)}; requests: ${counted(requests)}`;
  };

  liveLedgers.add(account);

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
      requests.clear();
    },
    stop: async () => {
      liveLedgers.delete(account);
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

/** The composer of `agent`'s own pane, live: the pane that sends to that agent's chat. */
function agentComposer(workspace: string, agent: string): string {
  return `document.querySelector(${JSON.stringify(`[data-agent-pane="${workspace}/agents/${agent}"] textarea:not([disabled])`)}) !== null`;
}

/** What the reader sees of one agent: its tab by URL name and its drilled
 *  sidebar row by actor id, each with the title shown. */
export interface AgentPresence {
  readonly tab: string | null;
  readonly sidebar: string | null;
}

/** The sidebar's workspace list has its answer: it stops reading busy. */
const SIDEBAR_LISTED = `document.querySelector('aside ul[aria-busy="false"]') !== null`;

const AgentPresenceSchema = v.object({ tab: v.nullable(v.string()), sidebar: v.nullable(v.string()) });

async function agentPresence(page: Page, workspace: string, agent: string, actorId: string): Promise<AgentPresence> {
  return v.parse(AgentPresenceSchema, await page.evaluate((input) => {
    const shown = (element: Element | null): string | null =>
      element !== null && element.getClientRects().length > 0 ? (element.textContent ?? '').trim() : null;

    return {
      tab: shown(document.querySelector(`nav[aria-label="Chats"] [data-agent-tab="${input.agent}"]`)),
      sidebar: shown(document.querySelector(`[data-sidebar-agents="${input.workspace}"] [data-agent-row="${input.actorId}"]`)),
    };
  }, { workspace, agent, actorId }));
}

/** The agent-plan row: the pane the owner reviewed in, the review it saw there and the decision it took. */
export interface AgentPlanVerdict {
  readonly pane: string;
  readonly planReviewShown: boolean;
  readonly approveControl: string;
  readonly planStatus: string;
}

const PLAN_STATUS = `(document.querySelector('#inspector [data-plan-status]')?.textContent ?? '').trim()`;

const PLAN_DECISION_LIVE = `[...document.querySelectorAll('#inspector [data-plan-decisions] button:not([disabled])')]
  .some((button) => button.getClientRects().length > 0)`;

/**
 * An agent made with '+', asked in Plan mode in its own pane: the plan its turn submits comes back for review in the
 * inspector beside that pane and is approved through that agent's window (D9), as the workspace's own plan is through
 * the workspace's. Hosted turns need a deployed Worker, so this is a deployed tier's row, not the live app's.
 */
export async function agentPlanIsReviewedInItsPane(target: FlowTarget): Promise<AgentPlanVerdict> {
  const workspace = await createFlowWorkspace(target, 'agent-plan');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await startNewChat(page);
    const pane = v.parse(v.string(), await page.evaluate('location.pathname'));
    const planMode = `[...document.querySelectorAll('#chat [aria-label="Turn mode"] button')].find((button) => /^plan$/iu.test(button.textContent?.trim() ?? ''))`;

    await page.evaluate(`${planMode}?.click()`);
    await until(page, "the agent pane's composer in Plan", `${planMode}?.getAttribute('aria-pressed') === 'true'`);
    await sendAndSettle(page, AGENT_PLAN_ASK);
    // What the turn left in the pane, said before the wait: a turn that ended without a plan says why here.
    const said = v.parse(v.string(), await page.evaluate(`(document.querySelector('#chat')?.innerText ?? '').slice(-1200)`));
    process.stderr.write(`  the agent's pane after its turn: ${said.replace(/\s+/gu, ' ')}\n`);
    await until(page, "the agent's plan, decidable beside its pane", PLAN_DECISION_LIVE);
    const planReviewShown = await page.evaluate(`document.querySelector('#inspector [data-plan-body]') !== null`) === true;

    const approveControl = v.parse(v.string(), await page.evaluate(`(() => {
      const approve = [...document.querySelectorAll('#inspector [data-plan-decisions] button:not([disabled])')]
        .find((button) => /approve/iu.test(button.getAttribute('aria-label') ?? button.textContent ?? ''));
      approve?.click();
      return approve === undefined ? '' : (approve.getAttribute('aria-label') ?? approve.textContent ?? '').trim();
    })()`));

    await until(page, 'the approval, recorded on the plan', `${PLAN_STATUS} === 'Approved'`);

    return { pane, planReviewShown, approveControl, planStatus: v.parse(v.string(), await page.evaluate(PLAN_STATUS)) };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface ApprovalStackVerdict {
  /** The stack's cards once both commands parked: the open one first, then those behind it. */
  readonly stacked: readonly string[];
  /** What the open card showed before any answer. */
  readonly openWords: string;
  /** The stack's cards once the open one was approved. */
  readonly afterFirst: readonly string[];
  /** What the chat showed once both answers reached the agent: each as its event, and the agent's reply to each. */
  readonly heard: { readonly approvedEvent: boolean; readonly deniedEvent: boolean; readonly approvedReply: boolean; readonly deniedReply: boolean };
}

/** The stack's cards, the open one first, then those behind it, nearest first. */
const STACK_KEYS = `(() => {
  const cards = [...document.querySelectorAll('[data-attention-card], [data-attention-behind]')];
  const open = cards.filter((card) => card.hasAttribute('data-attention-card')).map((card) => card.getAttribute('data-attention-card'));
  const behind = cards.filter((card) => card.hasAttribute('data-attention-behind')).map((card) => card.getAttribute('data-attention-behind')).reverse();

  return [...open, ...behind];
})()`;

/** Presses the open card's answer named `words`. */
function stackAnswer(words: string): string {
  return `[...document.querySelectorAll('[data-attention-card] button')].find((button) => button.textContent?.trim() === ${JSON.stringify(words)})?.click()`;
}

const CHAT_TEXT = `(document.querySelector('#chat')?.textContent ?? '')`;

/**
 * Row: one turn parks two commands for its owner. They wait as a stack docked to the composer, the newer open;
 * approving it opens the other, denying that clears the stack, and each answer reaches the agent: its wake shows in
 * the chat as the event it is, and the agent answers each.
 */
export async function approvalsStackAtTheComposer(target: FlowTarget): Promise<ApprovalStackVerdict> {
  const workspace = await createFlowWorkspace(target, 'approvals');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await sendAndSettle(page, APPROVALS_ASK);
    await until(page, 'both parked commands stacked at the composer', `document.querySelector('[data-attention-stack]')?.getAttribute('data-attention-count') === '2'`);
    const stacked = v.parse(v.array(v.string()), await page.evaluate(STACK_KEYS));
    const openWords = v.parse(v.string(), await page.evaluate(`document.querySelector('[data-attention-card]')?.textContent ?? ''`));

    await page.evaluate(stackAnswer('Approve'));
    await until(page, 'the next card opened', `document.querySelector('[data-attention-stack]')?.getAttribute('data-attention-count') === '1'`);
    const afterFirst = v.parse(v.array(v.string()), await page.evaluate(STACK_KEYS));

    await page.evaluate(stackAnswer('Deny'));
    await until(page, 'the stack cleared', `document.querySelector('[data-attention-stack]') === null`);
    await until(page, 'both answers in the chat and heard by the agent', `${CHAT_TEXT}.includes('You approved') && ${CHAT_TEXT}.includes('You denied')`
      + ` && /${DECISION_HEARD}[^]*approved/u.test(${CHAT_TEXT}) && /${DECISION_HEARD}[^]*denied/u.test(${CHAT_TEXT})`);
    const said = v.parse(v.string(), await page.evaluate(CHAT_TEXT));

    return {
      stacked, openWords, afterFirst,
      heard: {
        approvedEvent: said.includes('You approved'), deniedEvent: said.includes('You denied'),
        approvedReply: new RegExp(`${DECISION_HEARD}[^]*approved`, 'u').test(said), deniedReply: new RegExp(`${DECISION_HEARD}[^]*denied`, 'u').test(said),
      },
    };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface HireApprovalVerdict {
  /** The asks the hire's own pane stacked once its command parked, and the open card's words. */
  readonly paneStacked: readonly string[];
  readonly openWords: string;
  /** Whether the hire, woken by the approval, said its re-issue ran. */
  readonly ran: boolean;
}

/**
 * Row: a chat agent the owner made runs a command its workspace gates (strict, nobody granted it). It parks as the
 * hire's own ask, stacked on the hire's composer; approved there, the hire is woken on its own queue and its re-issue
 * runs. Before, a hire was refused outright: "needs owner approval, nobody to ask".
 */
export async function hireParksAndRunsOnApproval(target: FlowTarget): Promise<HireApprovalVerdict> {
  const workspace = await createFlowWorkspace(target, 'hire-approval');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await startNewChat(page);
    const agentPath = `/workspace/${encodeURIComponent(workspace)}/agents/`;
    const agent = v.parse(v.string(), await page.evaluate(`decodeURIComponent(location.pathname.slice(${String(agentPath.length)}))`));
    const pane = `[data-agent-pane="${workspace}/agents/${agent}"]`;

    await until(page, "the new agent's own composer", agentComposer(workspace, agent));
    await sendAndSettle(page, HIRE_APPROVAL_ASK);
    await until(page, "the hire's ask stacked on its composer", `document.querySelector(${JSON.stringify(`${pane} [data-attention-stack]`)}) !== null`);
    const paneStacked = v.parse(v.array(v.string()), await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${pane} [data-attention-card]`)})].map((card) => card.getAttribute('data-attention-card'))`));
    const openWords = v.parse(v.string(), await page.evaluate(`document.querySelector(${JSON.stringify(`${pane} [data-attention-card]`)})?.textContent ?? ''`));

    await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${pane} [data-attention-card] button`)})].find((button) => button.textContent?.trim() === 'Approve')?.click()`);
    await until(page, "the hire's stack cleared", `document.querySelector(${JSON.stringify(`${pane} [data-attention-stack]`)}) === null`);
    await until(page, 'the hire, woken, saying its re-issue ran or did not', `/HIRE (RAN|STILL BLOCKED)/u.test(document.querySelector(${JSON.stringify(pane)})?.textContent ?? '')`);
    const ran = v.parse(v.boolean(), await page.evaluate(`(document.querySelector(${JSON.stringify(pane)})?.textContent ?? '').includes(${JSON.stringify(HIRE_RAN)})`));

    return { paneStacked, openWords, ran };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface WorkspaceProposalVerdict {
  /** What the Needs-you card offered the owner before anything existed. */
  readonly cardTitle: string;
  readonly cardSoul: string;
  /** Whether the account already listed a workspace of that name before the approval. */
  readonly existedBeforeApproval: boolean;
  /** The link the agent repeated from its wake, and the workspace it names. */
  readonly link: string;
  readonly created: { readonly name: string; readonly displayName: string } | null;
}

const PROPOSAL_CARD = '#inspector [data-workspace-proposal]';

const ListedSchema = v.object({
  entries: v.array(v.object({ name: v.string(), displayName: v.optional(v.string()) })),
  nextCursor: v.nullable(v.string()),
});

/** Every workspace on the account with its title, page by page, as the sidebar's roster lists them. */
async function listedWorkspaces(target: FlowTarget): Promise<Array<{ name: string; displayName: string }>> {
  const rows: Array<{ name: string; displayName: string }> = [];
  let cursor: string | null = null;

  do {
    const url = `${target.origin}/api/user/workspaces${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`;
    const page: v.InferOutput<typeof ListedSchema> = v.parse(ListedSchema, await (await fetch(url, { headers: webHeaders(target.identity) })).json());

    rows.push(...page.entries.map((entry) => ({ name: entry.name, displayName: entry.displayName ?? '' })));
    cursor = page.nextCursor;
  } while (cursor !== null);

  return rows;
}

/** A button in the proposal card, by its words. */
function proposalButton(words: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${PROPOSAL_CARD} button`)})].find((button) => ${words}.test(button.textContent ?? ''))?.click()`;
}

/**
 * Row: the workspace's main agent proposes a new workspace, the owner approves it once in Work → Needs you, and it
 * exists under the owner's account with the proposed name, while the agent that asked is woken with its link.
 */
export async function agentProposesAWorkspace(target: FlowTarget): Promise<WorkspaceProposalVerdict> {
  const workspace = await createFlowWorkspace(target, 'proposal');
  let created: string | null = null;

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await sendAndSettle(page, WORKSPACE_PROPOSAL_ASK);
    await openInspector(page);
    await page.evaluate(stripTab('Work'));
    await until(page, 'the proposal in Work → Needs you', `document.querySelector(${JSON.stringify(PROPOSAL_CARD)}) !== null`);
    const cardTitle = v.parse(v.string(), await page.evaluate(`document.querySelector(${JSON.stringify(PROPOSAL_CARD)})?.textContent ?? ''`));

    await page.evaluate(proposalButton('/show its soul/iu'));
    await until(page, 'the soul approving writes', `document.querySelector('[data-workspace-proposal-soul]') !== null`);
    const cardSoul = v.parse(v.string(), await page.evaluate(`document.querySelector('[data-workspace-proposal-soul]')?.textContent ?? ''`));
    const before = new Set((await listedWorkspaces(target)).map((row) => row.name));

    await page.evaluate(proposalButton('/create workspace/iu'));
    await until(page, "the agent's reply with the new workspace's link",
      `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(PROPOSAL_LINK_REPLY)})`);
    const said = v.parse(v.string(), await page.evaluate(`document.querySelector('#chat')?.textContent ?? ''`));
    const link = /https?:\/\/\S+?\/workspace\/[a-z0-9-]+/u.exec(said.slice(said.lastIndexOf(PROPOSAL_LINK_REPLY)))?.[0] ?? '';

    created = /\/workspace\/([a-z0-9-]+)$/u.exec(link)?.[1] ?? null;
    const row = (await listedWorkspaces(target)).find((entry) => entry.name === created);

    return { cardTitle, cardSoul, link, existedBeforeApproval: created !== null && before.has(created), created: row ?? null };
  } finally {
    await removeFlowWorkspace(target, workspace);

    if (created !== null) await removeFlowWorkspace(target, created);
  }
}

export interface AccountMemoryVerdict {
  /** The proposal Settings → Memory offered the owner, before anything was kept. */
  readonly offered: string;
  /** What another workspace's agent answered before the owner accepted, and after. */
  readonly before: string;
  readonly after: string;
  /** What a share's viewer of the account's memory got: its status. */
  readonly viewerStatus: number;
}

/** The chat's last `marker <answer>`, for the answers the script can give; '' when there is none. */
async function lastReply(page: Page, marker: string, answers: readonly string[]): Promise<string> {
  const said = v.parse(v.string(), await page.evaluate(`document.querySelector('#chat')?.textContent ?? ''`));
  const replies = answers.map((answer) => `${marker} ${answer}`);
  const at = Math.max(...replies.map((reply) => said.lastIndexOf(reply)));

  return replies.find((reply) => said.startsWith(reply, at)) ?? '';
}

const RECALL_ANSWERS = [ACCOUNT_FACT.value, 'nowhere I know of'];

/**
 * Row: the owner says a fact about themselves in one workspace; its agent proposes it for the account; nothing another
 * workspace reads holds it until the owner accepts it in Settings → Memory; then another workspace's agent recalls it.
 * A request without the owner's session reads nothing of it.
 */
export async function accountMemoryCrossesWorkspaces(target: FlowTarget): Promise<AccountMemoryVerdict> {
  const said = await createFlowWorkspace(target, 'memory-a');
  const asked = await createFlowWorkspace(target, 'memory-b');

  try {
    const first = await openWorkspacePage(target, `/workspace/${encodeURIComponent(said)}`);

    await sendAndSettle(first, ACCOUNT_FACT_ASK);
    const second = await openWorkspacePage(target, `/workspace/${encodeURIComponent(asked)}`);

    await sendAndSettle(second, ACCOUNT_RECALL_ASK);
    const before = await lastReply(second, ACCOUNT_RECALL_REPLY, RECALL_ANSWERS);
    const settings = await openWorkspacePage(target, '/user/settings#memory');
    const proposal = '[data-account-memory-proposal]';

    await until(settings, 'the proposal in Settings → Memory', `[...document.querySelectorAll(${JSON.stringify(proposal)})].some((node) => node.textContent.includes(${JSON.stringify(ACCOUNT_FACT.key)}))`);
    const offered = v.parse(v.string(), await settings.evaluate(`[...document.querySelectorAll(${JSON.stringify(proposal)})].find((node) => node.textContent.includes(${JSON.stringify(ACCOUNT_FACT.key)}))?.textContent ?? ''`));

    await settings.evaluate(`[...document.querySelectorAll(${JSON.stringify(proposal)})].find((node) => node.textContent.includes(${JSON.stringify(ACCOUNT_FACT.key)}))?.querySelector('button')?.click()`);
    await until(settings, 'the fact kept', `document.querySelector('[data-account-memory-fact=${JSON.stringify(ACCOUNT_FACT.key)}]') !== null`);
    await sendAndSettle(second, ACCOUNT_RECALL_ASK);
    const after = await lastReply(second, ACCOUNT_RECALL_REPLY, RECALL_ANSWERS);
    const viewer = await fetch(`${target.origin}/api/user/memory`);

    return { offered, before, after, viewerStatus: viewer.status };
  } finally {
    // The account's fact goes with the row, so a rerun proposes it afresh.
    await fetch(`${target.origin}/api/user/memory/facts/${ACCOUNT_FACT.key}`, { method: 'DELETE', headers: webHeaders(target.identity) });
    await removeFlowWorkspace(target, said);
    await removeFlowWorkspace(target, asked);
  }
}

export interface AgentReturnVerdict {
  readonly workspace: string;
  readonly agent: string;
  /** The name the row gave the agent through its tab's own rename. */
  readonly renamed: string;
  /** The words the row sent the agent. */
  readonly said: string;
  /** The agent as the page showed it once renamed, before the reader left. */
  readonly before: AgentPresence;
  /** The same agent in a new page opened on it after visiting another
   *  workspace, once that page had an answer to everything it asked. */
  readonly after: AgentPresence;
  /** The chat column's text in that new page. */
  readonly conversation: string;
}

/**
 * Row: an agent a person made, messaged and named is all still there when
 * they come back to it.
 *
 * Make an agent with the strip's '+', message it and let the turn end (its
 * title lands), rename it through its tab and open the Agents sidebar. Go to
 * another workspace, then return in a new page and open Agents again: its tab,
 * its sidebar row and its conversation must all be there. #13, the owner's
 * report of 2026-09-23: every agent was present over the API and a reloaded page
 * showed none of them.
 */
export async function agentIsThereOnReturn(target: FlowTarget): Promise<AgentReturnVerdict> {
  const workspace = await createFlowWorkspace(target, 'agent-return');
  const elsewhere = await createFlowWorkspace(target, 'agent-elsewhere');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await startNewChat(page);

    const agentPath = `/workspace/${encodeURIComponent(workspace)}/agents/`;

    await until(page, "the new agent's page", `location.pathname.startsWith(${JSON.stringify(agentPath)})`);

    const agent = v.parse(v.string(), await page.evaluate(`decodeURIComponent(location.pathname.slice(${String(agentPath.length)}))`));

    // The address changes a render before the pane does, and the Main pane's composer is live until then: words
    // typed into it went to the Main chat, and this row read the agent's empty one (2026-09-25).
    await until(page, "the new agent's own composer", agentComposer(workspace, agent));
    const said = `Reply with one word: ${agent}.`;
    const renamed = `Flow ${agent.slice(-6)}`;

    await sendAndSettle(page, said);
    const renameLedger = await frameLedger(page);

    // Rename through the tab: its pencil opens the name field with the current
    // name selected, so typing replaces it.
    await page.hover(`${CHATS} [data-agent-tab="${agent}"] a`);
    await page.click(`${CHATS} [data-agent-tab="${agent}"] button[aria-label^="Rename "]`);
    await until(page, "the chat's name field", `document.querySelector('input[aria-label="Chat name"]') !== null`);
    await page.keyboard.type(renamed);
    renameLedger.restart();
    await page.keyboard.press('Enter');
    await until(page, 'the name field to close', `document.querySelector('input[aria-label="Chat name"]') === null`);
    // The rename reply can close the editor before the deferred reads_changed notice refreshes the sidebar.
    await settledAfter(page, renameLedger, 'renameSubordinateAgent', 'listWorkspaceAgents');
    await renameLedger.stop();
    await page.click('[data-agents-counter]');
    await painted(page);

    // The current row belongs to the agent whose chat is open; its key is an actor id, not the URL name.
    const actorId = v.parse(v.string(), await page.$eval(
      `[data-sidebar-agents="${workspace}"] [data-agent-row][aria-current="page"]`,
      (row) => row.getAttribute('data-agent-row'),
    ));

    const before = await agentPresence(page, workspace, agent, actorId);

    await page.goto(`${target.origin}/workspace/${encodeURIComponent(elsewhere)}`, { waitUntil: 'load' });
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await page.close();

    const back = await signedInPage(target.browser, target.identity);
    const ledger = await frameLedger(back);

    // Back to the workspace, the way a person returns: its own page, not the agent's.
    await back.goto(`${target.origin}/workspace/${encodeURIComponent(workspace)}`, { waitUntil: 'load' });
    // The agents list arrives on the opening read (`getWorkspaceOpening`), not on its own.
    await settledAfter(back, ledger, 'getWorkspaceOpening', 'getChatHistoryPage');
    // The sidebar's workspaces arrive over HTTP once the roster socket opens, which the ledger does not see.
    await until(back, "the sidebar's workspace list", SIDEBAR_LISTED);
    await back.click('[data-agents-counter]');
    await painted(back);

    const after = await agentPresence(back, workspace, agent, actorId);

    // Its conversation, through its tab, when the tab is there to press.
    let conversation = '';

    if (after.tab !== null) {
      ledger.restart();
      await back.click(`nav[aria-label="Chats"] [data-agent-tab="${agent}"] a`);
      await until(back, "the agent's page", `location.pathname === ${JSON.stringify(`${agentPath}${encodeURIComponent(agent)}`)}`);
      await until(back, "the agent's own composer", agentComposer(workspace, agent));
      await settledAfter(back, ledger, 'getChatHistoryPage');
      conversation = v.parse(v.string(), await back.evaluate(`document.querySelector('#chat')?.textContent ?? ''`));
    }

    await ledger.stop();
    await back.close();

    return { workspace, agent, renamed, said, before, after, conversation };
  } finally {
    await removeFlowWorkspace(target, workspace);
    await removeFlowWorkspace(target, elsewhere);
  }
}

/** Which chat tab is current, by index: 0 is Main, the person's chats
 *  follow in roster order, -1 while none is marked. */
export const ACTIVE_TAB_INDEX = `(() => {
  const tabs = [...document.querySelectorAll('nav[aria-label="Chats"] [data-agent-tab]')];
  return tabs.findIndex((tab) => tab.querySelector('[aria-current="page"]') !== null);
})()`;

/** Click the control; an absent control throws, and that is the finding. */
const ClickScripts = {
  lastAgentTab: `(() => {
    const target = [...document.querySelectorAll('nav[aria-label="Chats"] [data-agent-tab] a')].pop();
    if (target === undefined) throw new Error('no chat tab to open');
    target.click();
  })()`,
  mainTab: `(() => {
    const main = document.querySelector('nav[aria-label="Chats"] [data-agent-tab="main"] a');
    if (main === null) throw new Error('no Main tab to return to');
    main.click();
  })()`,
  filesTab: `(() => {
    const files = document.querySelector('nav[aria-label="Workspace"] button[aria-label="Files"]');
    if (!(files instanceof HTMLElement)) throw new Error('no Files tab');
    files.click();
  })()`,
} as const;

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
  await typeIntoComposer(page, text);

  const site = v.parse(SendSiteSchema, await page.evaluate(`(() => {
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

  await until(page, 'the sent words in the chat column', `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(text)})`);

  return site;
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

/** Workspace-scoped reads the right panel owns; Agent and Activity are per
 *  agent. `getEvolutionChangelog` belongs here by ownership even though
 *  `rpc-gate` classifies it `interactive` rather than `workspace.read` — that
 *  axis is authorization, and the Journal it feeds is the workspace's. */
const WORKSPACE_READS = [
  'getWorkspaceOpening', 'getWorkspaceSnapshot', 'getExposedPorts', 'listPendingActions', 'getMemoryContent',
  'getToolDescriptions', 'getExecutors', 'listBackgroundJobs', 'listSlates',
  'listPendingConsents', 'getActivePlanReview', 'getEvolutionChangelog',
] as const;

/** One of the reads above, as a type: the delta table below is keyed by the
 *  same closed set the gate measures, not by an open dictionary. */
type WorkspaceRead = (typeof WORKSPACE_READS)[number];

/** The workspace-scoped reads re-sent between two counts, by method. The total
 *  is the row's verdict; the names are what a fix has to act on. */
function readsBetween(
  before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>,
): Partial<Record<WorkspaceRead, number>> {
  const delta: Partial<Record<WorkspaceRead, number>> = {};

  for (const method of WORKSPACE_READS) {
    const count = (after[method] ?? 0) - (before[method] ?? 0);

    if (count > 0) delta[method] = count;
  }

  return delta;
}

export interface PanelVerdict {
  readonly nodeSurvives: boolean;
  readonly scrollSurvives: boolean;
  readonly scrollMarked: number;
  readonly scrollValue: number;
  /** Which workspace-scoped reads were re-sent, and how often, per direction. */
  readonly readsOnSwitch: Readonly<Partial<Record<WorkspaceRead, number>>>;
  readonly readsOnBack: Readonly<Partial<Record<WorkspaceRead, number>>>;
  readonly workspaceReadsOnSwitch: number;
  readonly workspaceReadsOnBack: number;
  /** Frames the '+' tab's own `actor/<name>` socket answered with. */
  readonly agentSocketFrames: number;
}

/**
 * Row (B6): the right panel keeps its Work, Files and Env state across a switch
 * to a new agent's tab and back: the same DOM node, the same scroll offset, and
 * no workspace-scoped read re-sent in either direction. The new agent's pane is
 * live only once its own actor socket answers, which needs its agent facet, so
 * this row runs on a deployment: under `vite dev` no facet loads (2026-09-30).
 */
export async function rightPanelKeepsItsState(target: FlowTarget): Promise<PanelVerdict> {
  const workspace = await createFlowWorkspace(target, 'panel');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await startNewChat(page);
    await until(page, 'an agent tab after Main, current', `${ACTIVE_TAB_INDEX} > 0`);
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await page.evaluate(ClickScripts.mainTab);
    await until(page, "Main's tab, current", `${ACTIVE_TAB_INDEX} === 0`);
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);

    await openInspector(page);

    const counter = await countRpc(page);

    await page.evaluate(ClickScripts.filesTab);
    await until(page, 'the Files tab, active',
      `document.querySelector('nav[aria-label="Workspace"] button[aria-label="Files"][aria-current="true"]') !== null`);

    const marked = v.parse(
      v.object({ ok: v.literal(true), scrollTop: v.number() }),
      await page.evaluate(() => {
        const strip = document.querySelector('#inspector nav[aria-label="Workspace"]');
        const content = strip?.parentElement?.parentElement?.children[1];

        if (!content) return { ok: false as const, scrollTop: -1 };

        content.setAttribute('data-live-probe', 'work-surface');
        content.scrollTop = 53;

        return { ok: true as const, scrollTop: content.scrollTop };
      }),
    );

    const beforeSwitch = counter.counts();

    await page.evaluate(ClickScripts.lastAgentTab);
    await until(page, 'an agent tab after Main, current', `${ACTIVE_TAB_INDEX} > 0`);

    // The '+' flow: the subordinate column mounts a composer its own socket has
    // enabled. The hosted-actor socket defect left that pane connecting forever,
    // so this row's number is the frames that socket answered with.
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);

    const afterSwitch = counter.counts();

    await page.evaluate(ClickScripts.mainTab);
    await until(page, "Main's tab, current", `${ACTIVE_TAB_INDEX} === 0`);
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    // Let the switch back land before the node is read: a remount replaces the
    // marked element, and the count of marked nodes settles at 0 when it does.
    await settled(page, `document.querySelectorAll('[data-live-probe="work-surface"]').length`);

    const afterBack = counter.counts();

    const survives = v.parse(
      v.object({ same: v.boolean(), scrollTop: v.number() }),
      await page.evaluate(() => {
        const node = document.querySelector('[data-live-probe="work-surface"]');

        return { same: node !== null, scrollTop: node?.scrollTop ?? -1 };
      }),
    );

    await counter.stop();
    await page.close();

    const onSwitch = readsBetween(beforeSwitch.sent, afterSwitch.sent);
    const onBack = readsBetween(afterSwitch.sent, afterBack.sent);

    return {
      nodeSurvives: survives.same,
      scrollSurvives: survives.scrollTop === marked.scrollTop,
      scrollMarked: marked.scrollTop,
      scrollValue: survives.scrollTop,
      readsOnSwitch: onSwitch,
      readsOnBack: onBack,
      workspaceReadsOnSwitch: Object.values(onSwitch).reduce((sum, count) => sum + count, 0),
      workspaceReadsOnBack: Object.values(onBack).reduce((sum, count) => sum + count, 0),
      agentSocketFrames: afterSwitch.actorFrames - beforeSwitch.actorFrames,
    };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

/** What a pane shows of a given phrase and of its cards, in one read: the
 *  leafmost visible carriers of the phrase (an element whose text holds it
 *  while no child does — one per rendered entry) and the kinds of the cards
 *  that carry a kind attribute at all. */
async function paneHolds(page: Page, phrase: string): Promise<{ carriers: number; cards: string[] }> {
  return v.parse(
    v.object({ carriers: v.number(), cards: v.array(v.string()) }),
    await page.evaluate((needle: string) => {
      const visible = (el: Element): boolean => el.getClientRects().length > 0;

      const carriers = [...document.querySelectorAll('#chat [data-agent-pane] *')]
        .filter(visible)
        .filter((el) => (el.textContent ?? '').includes(needle))
        .filter((el) => ![...el.children].some((child) => (child.textContent ?? '').includes(needle)));

      const cards = [...document.querySelectorAll('#chat [data-agent-pane] [data-system-event], #chat [data-agent-pane] [data-advisor-severity]')]
        .filter(visible)
        .map((el) => el.getAttribute('data-system-event') ?? el.getAttribute('data-advisor-severity') ?? '?');

      return { carriers: carriers.length, cards };
    }, phrase),
  );
}

/** Each pane renders its own transcript and no other actor's. Measured with a
 *  marker per side — words this run sent into the root and words it sent into
 *  the actor — rather than by card markup: a `signal_card` frame carries no
 *  actor id at all (`SignalCardEvent`), which is the defect's own mechanism,
 *  and the workspace-created card carries no attribute either
 *  (`WorkspaceCreatedCard` is a styled pill), so the card kinds below are
 *  evidence beside the two counts, never the verdict. */
export interface StampedCardVerdict {
  /** Carriers of the ROOT's own message inside the ACTOR's pane. */
  readonly rootMarkerInActorPane: number;
  /** Carriers of the ACTOR's message inside the ROOT's pane. */
  readonly actorMarkerInRootPane: number;
  /** Card kinds each pane showed, by the attributes the cards that have one
   *  carry — `data-system-event`, `data-advisor-severity`. */
  readonly actorCards: readonly string[];
  readonly rootCards: readonly string[];
  /** `signal_card` frames the page's sockets carried, and how many of all
   *  received frames arrived on the actor's own socket. */
  readonly signalCardFrames: number;
  readonly actorSocketFrames: number;
  /** Where the actor-pane send landed. */
  readonly sentOn: SendSite;
}

/**
 * Row (B3's symptom): each pane renders its own transcript and no other
 * actor's. Driven through the real flow — a turn on Main, the '+' tab, a turn
 * on the new agent — and measured in both directions with one marker per side.
 * The new agent's turn runs in its agent facet, so this row runs on a
 * deployment: under `vite dev` no facet loads (2026-09-30).
 */
export async function eachPaneKeepsItsTranscript(target: FlowTarget): Promise<StampedCardVerdict> {
  const workspace = await createFlowWorkspace(target, 'stamped');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);
    const counter = await countRpc(page);

    // The root gets a turn of its own first, so the actor's pane below has
    // something it could leak: a transcript with words in it. Without this the
    // actor-side direction of the row could not go red at all.
    const rootMarker = `root opening ${crypto.randomUUID().slice(0, 8)}`;

    await sendInChat(page, rootMarker);
    await until(page, "the root turn's answer", `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(FALLBACK_ANSWER)})`);

    await startNewChat(page);
    await until(page, 'a second agent tab',
      `[...document.querySelectorAll('nav[aria-label="Chats"] [data-agent-tab]')].length > 1`);
    await page.evaluate(ClickScripts.lastAgentTab);
    await until(page, 'an agent tab after Main, current', `${ACTIVE_TAB_INDEX} > 0`);
    // The actor's pane is live when ITS column holds an enabled composer: a pane
    // still connecting renders the notice and no composer at all.
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await settled(page, `document.querySelectorAll('#chat *').length`);

    const actorPane = await paneHolds(page, rootMarker);

    const actorMarker = `stamp probe ${crypto.randomUUID().slice(0, 8)}`;
    const sentOn = await sendInChat(page, actorMarker);

    // The pane echoed the words inside `sendInChat`. The turn has then run its
    // course when the model's answer shows in this pane, or the marker is
    // rendered inside a card — the system-card attribute or the drained-events
    // list, never the composer's echo. One predicate for both, so no wait is left
    // dangling on a page that then closes.
    await until(page, "the agent turn's answer, or its words in a card",
      `[...document.querySelectorAll('#chat [data-system-event] *, #chat [data-drained-event] *')]`
      + `.some(el => (el.textContent ?? '').includes(${JSON.stringify(actorMarker)}))`
      + ` || (document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(FALLBACK_ANSWER)})`);

    await page.evaluate(ClickScripts.mainTab);
    await until(page, "Main's tab, current", `${ACTIVE_TAB_INDEX} === 0`);
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await settled(page, `document.querySelectorAll('#chat *').length`);

    const rootPane = await paneHolds(page, actorMarker);
    const counts = counter.counts();

    await counter.stop();
    await page.close();

    return {
      rootMarkerInActorPane: actorPane.carriers,
      actorMarkerInRootPane: rootPane.carriers,
      actorCards: actorPane.cards,
      rootCards: rootPane.cards,
      signalCardFrames: counts.received['signal_card'] ?? 0,
      actorSocketFrames: counts.actorFrames,
      sentOn,
    };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

/** Press the welcome page's forward control: Next through its steps, then
 *  Finish setup. Answers which it pressed, or 'none' when neither is offered. */
const WELCOME_FORWARD = `(() => {
  const offered = [...document.querySelectorAll('button')].filter((b) => !b.disabled && b.getClientRects().length > 0);
  const finish = offered.find((b) => (b.textContent ?? '').trim() === 'Finish setup');
  if (finish !== undefined) { finish.click(); return 'finish'; }
  const next = offered.find((b) => (b.textContent ?? '').trim() === 'Next');
  if (next !== undefined) { next.click(); return 'next'; }
  return 'none';
})()`;

export interface WelcomeVerdict {
  /** Whether the product first showed its setup. */
  readonly welcomed: boolean;
  /** Where the reader stood once the home page's mission field was there. */
  readonly landedAt: string;
}

/**
 * Row: the product reaches its home page, through setup when the account has
 * not done it. Setup stands in front of every route until it is finished, so
 * this row runs first; an account that finished it long ago goes straight home.
 */
export async function reachesHome(target: FlowTarget): Promise<WelcomeVerdict> {
  const page = await signedInPage(target.browser, target.identity);

  try {
    await page.goto(`${target.origin}/`, { waitUntil: 'load' });
    await until(page, 'the home page or its setup',
      `location.pathname === '/welcome' || document.querySelector('#workspace-mission') !== null`);

    const welcomed = v.parse(v.boolean(), await page.evaluate(`location.pathname === '/welcome'`));

    for (let pressed = 'next'; welcomed && pressed === 'next'; await painted(page)) {
      pressed = v.parse(v.picklist(['next', 'finish', 'none']), await page.evaluate(WELCOME_FORWARD));

      if (pressed === 'none') throw new Error('the welcome page offers neither Next nor Finish setup');
    }

    await until(page, "the home page's mission field", `document.querySelector('#workspace-mission') !== null`);

    return { welcomed, landedAt: v.parse(v.string(), await page.evaluate('location.pathname')) };
  } finally {
    await page.close();
  }
}

const ANSWERS = `[...document.querySelectorAll('#chat .prose-chat')]
  .filter((block) => block.getClientRects().length > 0)
  .map((block) => (block.textContent ?? '').trim())
  .filter((text) => text.length > 0)`;

const SHOWN_WARNINGS = `[...document.querySelectorAll('.p-notice-warning')]
  .map((notice) => (notice.textContent ?? '').trim()).filter((text) => text !== '').join(' | ')`;

/** The mission the first-answer row creates its workspace with: #21's own. */
const MISSION = 'hello';

export interface FirstAnswerVerdict {
  readonly workspace: string;
  /** Where the create landed the reader, as the address bar showed it. */
  readonly landedAt: string;
  /** The replies on screen once the workspace's first turn ended. */
  readonly answers: readonly string[];
  /** The inspector column's width once the turn had closed and the page had
   *  re-read what waits on the person. */
  readonly inspectorWidth: number;
  /** Whether the mission showed as a message the person sent: a turn they could walk back. */
  readonly missionSent: boolean;
}

/** A message the person sent carries the control that walks the conversation back to it. */
const SENT_MESSAGES = `[...document.querySelectorAll('#chat [data-revert-turn]')].map((control) => control.parentElement?.textContent ?? '')`;

/**
 * Row: a person creates a workspace from the home page and gets a first answer.
 *
 * Type a mission into the home page's form and press Create workspace; the page
 * must land in the new workspace, and its first turn, the one the mission
 * starts, must end with a reply on screen.
 */
export async function workspaceGetsFirstAnswer(target: FlowTarget): Promise<FirstAnswerVerdict> {
  const page = await signedInPage(target.browser, target.identity);
  const ledger = await frameLedger(page);
  let workspace: string | null = null;

  try {
    await recordRenderTasks(page);
    await page.goto(`${target.origin}/`, { waitUntil: 'load' });
    await until(page, "the home page's mission field", `document.querySelector('#workspace-mission:not([disabled])') !== null`);

    // A home page asking to connect a model cannot create: say so rather than press.
    const warned = v.parse(v.string(), await page.evaluate(SHOWN_WARNINGS));

    if (warned !== '') throw new Error(`the home page shows a warning before any create: ${warned}`);

    const mission = await page.$('#workspace-mission');

    if (mission === null) throw new Error('the home page has no mission field');

    await mission.focus();
    await page.keyboard.sendCharacter(MISSION);

    const typed = v.parse(v.string(), await mission.evaluate((box) => (box instanceof HTMLTextAreaElement ? box.value : '')));

    if (typed !== MISSION) throw new Error(`the mission field holds ${JSON.stringify(typed)}, not the words typed into it`);
    ledger.restart();
    await page.evaluate(`(() => {
      const create = [...document.querySelectorAll('button[type="submit"]')]
        .find((b) => (b.textContent ?? '').trim() === 'Create workspace');
      if (create === undefined) throw new Error('no Create workspace control');
      create.click();
    })()`);
    await until(page, "the new workspace's page", `location.pathname.startsWith('/workspace/')`);

    const landedAt = v.parse(v.string(), await page.evaluate('location.pathname'));

    workspace = decodeURIComponent(landedAt.slice('/workspace/'.length).split('/')[0] ?? '');
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    // The workspace's own first turn opens on the product's words, not the
    // mission's, so the row waits for its reply, then for Send, which returns
    // once the turn's claim settles. The page may join after the turn has
    // closed, and then hears the settled claim as it connects.
    await until(page, "the mission's answer in the chat column", `${ANSWERS}.length > 0`);
    await until(page, "the mission's turn to close, Send offered", CHAT_IDLE);

    const answers = v.parse(v.array(v.string()), await page.evaluate(ANSWERS));

    // #21: a hello turn must not open an inspector. The initial snapshot and turn-triggered refreshes
    // supply its state; an idle page no longer polls listPendingActions.
    do {
      await waitOn(page, 'the workspace opening and its outstanding reads', settledAfter(page, ledger, 'getWorkspaceOpening'));
      await rendered(page);
    } while (!ledger.quiet());

    const inspectorWidth = v.parse(v.number(), await page.evaluate(INSPECTOR_WIDTH));
    const missionSent = v.parse(v.array(v.string()), await page.evaluate(SENT_MESSAGES)).some((text) => text.includes(MISSION));

    await ledger.stop();
    await page.close();

    return { workspace, landedAt, answers, inspectorWidth, missionSent };
  } finally {
    if (workspace !== null && workspace !== '') await removeFlowWorkspace(target, workspace);
  }
}

/** The inspector column, `#inspector` — the id `use-inspector-layout` hands the
 *  panel and which `react-resizable-panels` renders on its element — as a
 *  rounded width; -1 when no such box is in the document at all. */
export const INSPECTOR_WIDTH = `(() => {
  const panel = document.querySelector('#inspector');
  return panel === null ? -1 : Math.round(panel.getBoundingClientRect().width);
})()`;

/** A shut inspector column: the library leaves a 0px box, and a hair of border
 *  or padding still counts as shut. */
export const INSPECTOR_SHUT_PX = 40;

export const OPEN_NAMES = 'show|expand|open';

/** The clockless settle after a press: no finite animation running or waiting
 *  to start, and the measured number equal on two consecutive animation frames
 *  with none. `getAnimations()` flushes pending style, so a transition the
 *  press has just set off is counted before it has moved a pixel: equal frames
 *  alone read the rail as settled at its open 240 px while its collapse waited
 *  pending (2026-09-24, 10 of 40 collapses short of the end state at 6x CPU
 *  throttling). An infinite animation, a pulsing dot, never finishes and is not
 *  waited on. A control that does nothing settles at the number it started
 *  with, so no deadline is needed to tell an inert control from a slow one. */
export async function settled(page: Page, read: string): Promise<void> {
  await page.evaluate('window.__liveSettle = undefined');
  await page.waitForFunction(
    `(() => {
      const value = ${read};
      const moving = document.getAnimations().some((animation) =>
        (animation.pending || animation.playState === 'running')
        && animation.effect?.getComputedTiming().endTime !== Infinity);
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

    await settled(page, input.read);
    await page.keyboard.press('Escape');
    await settled(page, input.read);

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
    names: OPEN_NAMES, read: INSPECTOR_WIDTH, reached: (width) => width > INSPECTOR_SHUT_PX,
  });

  if (outcome.reached) return;

  throw new Error(`the inspector column stayed at ${String(outcome.value)}px; tried ${JSON.stringify(outcome.attempts)}`);
}

/** Press the inspector strip's tab named `name`; an absent tab throws. */
function stripTab(name: string): string {
  return `(() => {
    const tab = document.querySelector(${JSON.stringify(`#inspector button[aria-label="${name}"]`)});
    if (tab === null) throw new Error(${JSON.stringify(`no ${name} tab in the inspector strip`)});
    tab.click();
  })()`;
}

/** Whether the inspector strip draws a tab named `name`. */
function stripHas(name: string): string {
  return `document.querySelector(${JSON.stringify(`#inspector button[aria-label="${name}"]`)}) !== null`;
}

/** The Files tab has listed its directory: no "Loading…" row stands in the list. */
const FILES_SETTLED = `(() => {
  const list = document.querySelector('[data-files-list]');
  return list !== null && !(list.textContent ?? '').includes('Loading…');
})()`;

/** The names the Files tab lists, as its rows show them. */
const FILES_LISTED = `[...document.querySelectorAll('[data-files-entry]')].map((row) => row.getAttribute('title') ?? '')`;

/** The workspace's own folder, from the Files tab's root, one row at a time. */
const HOME_FOLDER = ['home', 'main'] as const;

/** The Changes tab has read its change-set: its file tree is drawn. */
const CHANGES_SETTLED = `document.querySelector('#inspector [data-file-tree]') !== null`;

/** The changed paths the Changes tab lists, as its file rows name them. */
const CHANGED_PATHS = `[...document.querySelectorAll('#inspector [data-file-row]')].map((row) => row.getAttribute('data-file-row') ?? '')`;

export interface WrittenFileVerdict {
  readonly workspace: string;
  /** Every entry the Files tab listed once its listing settled. */
  readonly filesListed: readonly string[];
  /** The changed paths the Changes tab lists once it appears, the shell's write among them. */
  readonly changedPaths: readonly string[];
  /** The changed paths once the reader marked the change-set reviewed. */
  readonly afterReview: readonly string[];
}

/**
 * Row: a file the agent writes shows in the Files tab and in the Changes tab.
 *
 * One turn writes one file; the reader opens the inspector, reads the Files
 * tab's listing, and opens the Changes tab the write should have raised. The
 * tab appears once the surface's own read of the change-set has the write, so
 * the row waits for it: a single look failed whenever it came before that read
 * (2026-09-25).
 */
export async function writtenFileShowsInFilesAndChanges(target: FlowTarget): Promise<WrittenFileVerdict> {
  const workspace = await createFlowWorkspace(target, 'files-diffs');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await sendAndSettle(page, WRITE_FILE_ASK);
    await openInspector(page);
    await page.evaluate(stripTab('Files'));
    await until(page, "the Files tab's listing", FILES_SETTLED);

    for (const folder of HOME_FOLDER) {
      const row = `[data-files-entry][title="${folder}"]`;

      await until(page, `the ${folder} folder in the listing`, `document.querySelector(${JSON.stringify(row)}) !== null`);
      await page.click(row);
      await until(page, `the ${folder} folder's listing`,
        `${FILES_SETTLED} && document.querySelector(${JSON.stringify(row)}) === null`);
    }

    const filesListed = v.parse(v.array(v.string()), await page.evaluate(FILES_LISTED));

    await until(page, 'the Changes tab the write raised', stripHas('Changes'));
    await page.evaluate(stripTab('Changes'));
    await until(page, "the Changes tab's change-set", CHANGES_SETTLED);
    await until(page, "the shell's write in the change-set", `${CHANGED_PATHS}.some((path) => path.endsWith(${JSON.stringify(FLOW_SHELL_PROBE)}))`);
    const changedPaths = v.parse(v.array(v.string()), await page.evaluate(CHANGED_PATHS));

    await page.click('#inspector [data-mark-reviewed]');
    await until(page, 'the reviewed change-set to empty', `${CHANGED_PATHS}.length === 0`);
    const afterReview = v.parse(v.array(v.string()), await page.evaluate(CHANGED_PATHS));

    await page.close();

    return { workspace, filesListed, changedPaths, afterReview };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

/** The burst's files the Changes tab lists. */
/** A changed path names its folder as a segment: the pane lists them from the workspace root, `storm/f1.txt`, and a
 *  count of `/storm/` read 0 of 50 forever (staging, 2026-10-08). */
const STORM_LISTED = `${CHANGED_PATHS}.filter((path) => path.split('/').includes(${JSON.stringify(STORM_DIR)})).length`;

export interface ChangesStormVerdict {
  readonly workspace: string;
  /** How many of the burst's files each tab's Changes pane lists once it settles. */
  readonly listed: readonly number[];
  /** Each tab's change-set reads, and the read-moved frames it was sent, during the burst. */
  readonly burstReads: readonly number[];
  readonly burstFrames: readonly number[];
  /** The first two tabs' change-set reads while the third opened its Files pane after the burst. */
  readonly idleReads: readonly number[];
}

/**
 * Three tabs hold one workspace's Changes pane open while one shell command writes a burst of files. Every tab ends
 * up listing the whole burst, having read the change-set a bounded number of times, not once per file; and once the
 * burst settles, the open panes read nothing more while another tab works.
 */
export async function changesStormStaysBounded(target: FlowTarget): Promise<ChangesStormVerdict> {
  const workspace = await createFlowWorkspace(target, 'changes-storm');

  try {
    const path = `/workspace/${encodeURIComponent(workspace)}`;
    const tabs = await Promise.all([0, 1, 2].map(async () => openWorkspacePage(target, path)));
    const [sender, , worker] = tabs;

    if (sender === undefined || worker === undefined) throw new Error('three tabs did not open');
    await sendAndSettle(sender, STORM_SEED_ASK);

    for (const page of tabs) {
      await openInspector(page);
      await until(page, 'the Changes tab the seed raised', stripHas('Changes'));
      await page.evaluate(stripTab('Changes'));
      await until(page, "the Changes tab's change-set", CHANGES_SETTLED);
    }

    const counters = await Promise.all(tabs.map(async (page) => countRpc(page)));

    await sendAndSettle(sender, STORM_ASK);

    for (const page of tabs) await until(page, 'the whole burst in the change-set', `${STORM_LISTED} === ${String(STORM_FILES)}`);
    const burst = counters.map((counter) => counter.counts());

    await worker.evaluate(stripTab('Files'));
    await until(worker, "the Files tab's listing", FILES_SETTLED);
    const after = counters.map((counter) => counter.counts());
    const reads = (counts: RpcCounts) => counts.sent.getExecutorDiff ?? 0;

    const listed = await Promise.all(tabs.map(async (page) => v.parse(v.number(), await page.evaluate(STORM_LISTED))));

    await Promise.all(counters.map(async (counter) => counter.stop()));
    await Promise.all(tabs.map(async (page) => page.close()));

    return {
      workspace, listed,
      burstReads: burst.map(reads),
      burstFrames: burst.map((counts) => counts.received.reads_changed ?? 0),
      idleReads: after.slice(0, 2).map((counts, at) => reads(counts) - reads(burst[at] ?? counts)),
    };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface LiveMemoryVerdict {
  readonly workspace: string;
  /** What the watching tab's memory section said once the other tab's turn ended. */
  readonly shown: string;
  /** The watching tab's memory reads during that turn, and while the sending tab then worked. */
  readonly turnReads: number;
  readonly idleReads: number;
}

const MEMORY_SECTION = `document.querySelector('#inspector [data-section="memory"]')?.textContent ?? ''`;

/**
 * One tab's turn saves a memory note while another holds the Agent tab open: the open pane shows the note without a
 * reload, from the write's own frame, and reads nothing more while the first tab works on.
 */
export async function openMemoryFollowsItsWriter(target: FlowTarget): Promise<LiveMemoryVerdict> {
  const workspace = await createFlowWorkspace(target, 'live-memory');

  try {
    const path = `/workspace/${encodeURIComponent(workspace)}`;
    const sender = await openWorkspacePage(target, path);
    const watcher = await openWorkspacePage(target, path);

    await openInspector(watcher);
    await watcher.evaluate(stripTab('Agent'));
    await until(watcher, "the Agent tab's memory section", `document.querySelector('#inspector [data-section="memory"]') !== null`);
    const counter = await countRpc(watcher);
    const reads = () => counter.counts().sent.getMemoryContent ?? 0;

    await sendAndSettle(sender, MEMORY_ASK);
    await until(watcher, 'the saved note in the open memory section', `(${MEMORY_SECTION}).includes(${JSON.stringify(FLOW_MEMORY_NOTE)})`);
    const turnReads = reads();

    await openInspector(sender);
    await sender.evaluate(stripTab('Files'));
    await until(sender, "the Files tab's listing", FILES_SETTLED);
    const idleReads = reads() - turnReads;
    const shown = v.parse(v.string(), await watcher.evaluate(MEMORY_SECTION));

    await counter.stop();
    await Promise.all([sender.close(), watcher.close()]);

    return { workspace, shown, turnReads, idleReads };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface SlatePreviewVerdict {
  readonly workspace: string;
  /** Whether the strip drew a tab under the slate's title once the turn ended. */
  readonly slateTab: boolean;
  /** The slate's preview frame's page text once its React page drew; null when no frame drew. */
  readonly frameText: string | null;
  /** The count the page showed after one Bump, answered by the slate's own method over its RPC; null when unread. */
  readonly bumped: string | null;
  /** Whether the page heard its host's context. */
  readonly hosted: boolean;
}

/**
 * Row: a slate the agent builds shows its running preview in its own tab.
 *
 * One turn builds a slate that serves a page and starts its preview; once the
 * page has re-listed the workspace's slates, the reader presses the slate's tab
 * and reads the page its frame loaded. The frame is a preview host of its own,
 * on the deployed zone after the publish and on `vite dev`'s zone before it
 * (packages/cf-backend/vite-preview-zone.ts).
 */
export async function slateShowsItsPreview(target: FlowTarget): Promise<SlatePreviewVerdict> {
  const workspace = await createFlowWorkspace(target, 'slate-preview');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);
    const ledger = await frameLedger(page);

    await sendAndSettle(page, SLATE_ASK);
    await settledAfter(page, ledger);
    await openInspector(page);

    const slateTab = v.parse(v.boolean(), await page.evaluate(stripHas(FLOW_SLATE.title)));
    let frameText: string | null = null;
    let bumped: string | null = null;
    let hosted = false;

    if (slateTab) {
      await page.evaluate(stripTab(FLOW_SLATE.title));

      const frameSelector = `#inspector iframe[title="${FLOW_SLATE.id}"]`;

      await until(page, "the slate's preview frame", `document.querySelector(${JSON.stringify(frameSelector)}) !== null`);

      const frame = await (await page.$(frameSelector))?.contentFrame();

      if (frame !== null && frame !== undefined) {
        // The frame first holds its initial about:blank, which is already complete and empty.
        await waitOn(page, "the slate's preview to load", frame.waitForFunction('location.href !== "about:blank" && document.readyState === "complete"', { polling: 100 }));
        await waitOn(page, "the slate's React page to draw", frame.waitForFunction('document.querySelector("[data-count]") !== null', { polling: 100 }));
        frameText = v.parse(v.string(), await frame.evaluate('(document.body?.textContent ?? "").trim()'));
        await frame.click('button[type="submit"]');
        await waitOn(page, "the slate's answer to Bump", frame.waitForFunction('document.querySelector("[data-count]")?.textContent !== "0"', { polling: 100 }));
        bumped = v.parse(v.string(), await frame.evaluate('document.querySelector("[data-count]")?.textContent ?? ""'));
        hosted = v.parse(v.string(), await frame.evaluate('document.querySelector("[data-host]")?.textContent ?? ""')) === 'hosted';
      }
    }

    await ledger.stop();
    await page.close();

    return { workspace, slateTab, frameText, bumped, hosted };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

const DRIVE_LISTED = `[...document.querySelectorAll('[data-drive-entry]')].map((row) => row.getAttribute('data-drive-entry') ?? '')`;

/** Counts, on `window`, every listing of the Drive's root the page's own fetch
 *  has had answered, body and all (or ended short of it); installed before each
 *  document's scripts run. The root also asks for /skills, to know whether to
 *  show that folder, and that answer is not the listing a step causes. A count
 *  at the headers is a count of nothing yet: from the edge the listing itself
 *  came 50 ms behind them (2026-09-23), and a snapshot two frames after the
 *  headers read the Drive one step late. */
const COUNT_DRIVE_LISTINGS = `(() => {
  window.__driveListings = 0;
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await real(input, init);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' && url.pathname === '/api/drive' && url.searchParams.get('path') === '/') {
      const settled = () => { window.__driveListings += 1; };
      response.clone().arrayBuffer().then(settled, settled);
    }
    return response;
  };
})()`;

/** Run `act`, then resolve once the Drive listing it causes has been answered
 *  and painted: every change the page makes ends in a fresh listing. A step that
 *  loads a new document starts that document's count at zero. */
async function relisted(page: Page, act: () => Promise<void>, loadsDocument = false): Promise<readonly string[]> {
  const before = loadsDocument ? 0 : v.parse(v.number(), await page.evaluate('window.__driveListings'));

  await act();
  await until(page, 'the Drive listing the step causes', `(window.__driveListings ?? 0) > ${String(before)}`);
  await painted(page);

  return v.parse(v.array(v.string()), await page.evaluate(DRIVE_LISTED));
}

/** Name a Drive entry through the page's name dialog: the field opens with
 *  its current value selected, so typing replaces it. */
async function nameInDialog(page: Page, name: string): Promise<void> {
  await until(page, 'the name dialog', `document.querySelector('#drive-name') !== null`);
  await page.focus('#drive-name');
  await page.keyboard.type(name);
  await page.click('[data-drive-dialog-commit]');
}

export interface DriveVerdict {
  readonly folder: string;
  readonly renamed: string;
  readonly file: string;
  /** The Drive's entries once the folder was made and the file uploaded. */
  readonly afterCreate: readonly string[];
  /** The entries after the folder's rename and a reload. */
  readonly afterRename: readonly string[];
  /** The entries once both were deleted through their rows' own controls. */
  readonly afterDelete: readonly string[];
}

/**
 * Row: what a person does in the Drive page is kept.
 *
 * Make a folder through New and upload a file, rename the folder, reload, then
 * delete both through their tiles' own menus. The Drive is the account's, not a
 * workspace's, so the entries carry names no other run shares and are removed
 * through the Drive's own route if the row stops early.
 */
export async function driveKeepsWhatIsDone(target: FlowTarget): Promise<DriveVerdict> {
  const folder = evalWorkspaceName('browser-drive');
  const renamed = `${folder}-renamed`;
  const file = `${folder}.txt`;
  const upload = join(scratchDir('drive-upload'), file);
  const page = await signedInPage(target.browser, target.identity);

  writeFileSync(upload, 'browser flow upload\n');

  try {
    await page.evaluateOnNewDocument(COUNT_DRIVE_LISTINGS);
    await relisted(page, async () => { await page.goto(`${target.origin}/drive`, { waitUntil: 'load' }); }, true);
    await relisted(page, async () => {
      await page.click('[data-drive-new]');
      await page.click('[data-drive-new-folder]');
      await nameInDialog(page, folder);
    });

    const picker = await page.$('input[data-drive-files-input]');

    if (picker === null) throw new Error('the Drive page has no file picker');

    const afterCreate = await relisted(page, () => picker.uploadFile(upload));

    await relisted(page, async () => {
      await page.click(`[data-drive-entry="${folder}"] [data-drive-menu]`);
      await page.click(`[data-drive-entry="${folder}"] [data-drive-rename]`);
      await nameInDialog(page, renamed);
    });

    const afterRename = await relisted(page, async () => { await page.reload({ waitUntil: 'load' }); }, true);

    // Deleted through the page only where the page lists it; a missed rename is
    // the verdict's finding, and the `finally` below removes what is left.
    for (const entry of [renamed, file].filter((listed) => afterRename.includes(listed))) {
      await relisted(page, async () => {
        await page.click(`[data-drive-entry="${entry}"] [data-drive-menu]`);
        await page.click(`[data-drive-entry="${entry}"] [data-drive-delete]`);
        await until(page, 'the delete confirmation', `document.querySelector('[data-drive-delete-confirm]') !== null`);
        await page.click('[data-drive-delete-confirm]');
      });
    }

    const afterDelete = v.parse(v.array(v.string()), await page.evaluate(DRIVE_LISTED));

    return { folder, renamed, file, afterCreate, afterRename, afterDelete };
  } finally {
    await page.close();

    for (const entry of [folder, renamed, file]) {
      const left = await fetch(`${target.origin}/api/drive?path=${encodeURIComponent(`/${entry}`)}`, {
        method: 'DELETE',
        headers: webHeaders(target.identity),
      });

      // 404 is the row's own Delete having done its work.
      if (!left.ok && left.status !== 404) {
        console.warn(`product-flows: removing Drive entry ${entry} answered ${String(left.status)}`);
      }
    }
  }
}

/** The Drive's sections as drawn, each with the tiles in it. */
const DRIVE_SECTIONS = `[...document.querySelectorAll('[data-drive-section]')].map((section) => ({
  title: section.getAttribute('data-drive-section') ?? '',
  tiles: section.querySelectorAll('[data-drive-tile-name]').length,
}))`;

/** The Drive has drawn what it holds: its sections, or its empty state. */
const DRIVE_DRAWN = `document.querySelector('[data-drive-section], [data-drive-empty]') !== null`;

export interface DriveOpensVerdict {
  /** Where `/drive` landed: My stuff, or Shared for an account that owns nothing yet but was shared something. */
  readonly landedAt: string;
  readonly sections: readonly { readonly title: string; readonly tiles: number }[];
  readonly empty: boolean;
  /** The sidebar's Drive row is marked as the current page. */
  readonly sidebarLit: boolean;
}

/**
 * Row: the Drive opens and draws nothing empty.
 *
 * Opens `/drive` and reads what it drew: every section it shows holds at least
 * one tile, and a Drive with nothing to show draws its empty state instead.
 */
export async function driveOpens(target: FlowTarget): Promise<DriveOpensVerdict> {
  const page = await signedInPage(target.browser, target.identity);

  try {
    await page.goto(`${target.origin}/drive`, { waitUntil: 'load' });
    await until(page, 'the Drive to draw what it holds', DRIVE_DRAWN);
    await painted(page);

    const sections = v.parse(v.array(v.object({ title: v.string(), tiles: v.number() })), await page.evaluate(DRIVE_SECTIONS));
    const empty = v.parse(v.boolean(), await page.evaluate(`document.querySelector('[data-drive-empty]') !== null`));

    const sidebarLit = v.parse(v.boolean(), await page.evaluate(
      `[...document.querySelectorAll('a[aria-current="page"]')].some((link) => (link.textContent ?? '').trim() === 'Drive')`,
    ));

    return { landedAt: new URL(page.url()).pathname, sections, empty, sidebarLit };
  } finally {
    await page.close();
  }
}

/** The slate the Drive's slate rows write into a workspace of their own: one
 *  page that calls nothing of its owner's, so opening and sharing it spend no model turn. */
export const DRIVE_SLATE = { id: 'drive-flow', title: 'Drive flow probe' } as const;

/** Write one file into a workspace through the route the Files tab uploads with. */
async function writeWorkspaceFile(target: FlowTarget, workspace: string, path: string, text: string): Promise<void> {
  const query = new URLSearchParams({ executor: 'workspace', path });

  const response = await fetch(`${target.origin}/api/workspaces/${encodeURIComponent(workspace)}/files?${query.toString()}`, {
    method: 'PUT',
    headers: { ...webHeaders(target.identity), 'content-type': 'application/octet-stream' },
    body: text,
  });

  if (!response.ok) throw new Error(`writing ${path} answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);
}

async function workspaceWithSlate(target: FlowTarget, subject: string): Promise<string> {
  const workspace = await createFlowWorkspace(target, subject);
  const root = `${SLATES_ROOT}/${DRIVE_SLATE.id}`;

  await writeWorkspaceFile(target, workspace, `${root}/package.json`, JSON.stringify({
    name: DRIVE_SLATE.id, main: 'server.ts', slate: { title: DRIVE_SLATE.title },
  }));
  await writeWorkspaceFile(target, workspace, `${root}/server.ts`, 'export default { fetch: () => new Response("drive flow") };\n');

  return workspace;
}

/** The slate's tile in My stuff, found by the slate and the workspace it lives in. */
function slateTile(workspace: string): string {
  return `[data-drive-slate="${DRIVE_SLATE.id}"][data-drive-workspace="${workspace}"]`;
}

async function driveWithSlate(target: FlowTarget, workspace: string): Promise<Page> {
  const page = await signedInPage(target.browser, target.identity);

  await page.goto(`${target.origin}/drive`, { waitUntil: 'load' });
  await until(page, 'the slate\'s tile in My stuff', `document.querySelector(${JSON.stringify(slateTile(workspace))}) !== null`);
  await painted(page);

  return page;
}

export interface SlateOpensVerdict {
  readonly workspace: string;
  /** The name the slate's tile draws. */
  readonly tileName: string;
  /** Where pressing the tile went. */
  readonly landedAt: string;
  /** The workspace strip's current tab is the slate's. */
  readonly slateTabCurrent: boolean;
}

/**
 * Row: a slate opens from My stuff into its workspace, on its own tab.
 *
 * A workspace gets a slate through the Files route; the Drive's tile for it is
 * pressed, and the workspace page it opens must have made the slate's tab the
 * current one. The preview frame is not read: `vite dev` serves no slate.
 */
export async function slateOpensFromMyStuff(target: FlowTarget): Promise<SlateOpensVerdict> {
  const workspace = await workspaceWithSlate(target, 'drive-open');

  try {
    const page = await driveWithSlate(target, workspace);
    const tileName = await page.$eval(`${slateTile(workspace)} [data-drive-tile-name]`, (element) => (element.textContent ?? '').trim());

    await page.click(`${slateTile(workspace)} a`);
    await until(page, 'the workspace page', CHAT_COMPOSER_LIVE);
    await openInspector(page);

    const current = `#inspector button[aria-label="${DRIVE_SLATE.title}"][aria-current="true"]`;
    await until(page, 'the slate\'s tab', stripHas(DRIVE_SLATE.title));
    const slateTabCurrent = v.parse(v.boolean(), await page.evaluate(`document.querySelector(${JSON.stringify(current)}) !== null`));
    const url = new URL(page.url());

    await page.close();

    return { workspace, tileName, landedAt: `${url.pathname}${url.search}`, slateTabCurrent };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

/** The titles of the shares a Drive section draws. */
function sharesIn(section: string): string {
  return `[...document.querySelectorAll('[data-drive-section="${section}"] [data-drive-share] [data-drive-tile-name]')]
    .map((name) => (name.textContent ?? '').trim())`;
}

export interface SlateShareVerdict {
  readonly workspace: string;
  /** Whether the dialog drew a Reach row for a slate that reaches nothing. */
  readonly reachRow: boolean;
  /** Every number the dialog's limits line states before sharing. */
  readonly limitsStated: readonly number[];
  /** The link the dialog gave once shared; null when it gave none. */
  readonly link: string | null;
  /** What pressing the link's copy control put on the clipboard. */
  readonly copied: string | null;
  /** Shared by you, once shared. */
  readonly sharedByYou: readonly string[];
  /** Shared by you after Stop sharing; the tab is gone when nothing else is shared. */
  readonly afterStop: readonly string[];
}

/**
 * Row: a slate that calls nothing of its owner's shares from its tile, and stops.
 *
 * Share… on the slate's tile opens the dialog #25 asked to be short: with
 * nothing to reach there is no Reach row and no spend limit. The row shares it
 * with anyone who has the link, finds it under Shared by you, and stops it
 * there. A share the row did not stop is revoked through the route.
 */
export async function slateSharesReachingNothing(target: FlowTarget): Promise<SlateShareVerdict> {
  const workspace = await workspaceWithSlate(target, 'drive-share');
  let share: string | null = null;
  let stopped = false;

  try {
    const page = await driveWithSlate(target, workspace);

    await page.click(`${slateTile(workspace)} [data-drive-menu]`);
    await page.click(`${slateTile(workspace)} [data-drive-share-slate]`);
    await until(page, 'the share dialog\'s limits', `document.querySelector('[role="dialog"] [data-share-limits]') !== null`);

    const reachRow = v.parse(v.boolean(), await page.evaluate(`document.querySelector('[data-share-reach]') !== null`));

    const limitsStated = v.parse(v.array(v.number()), await page.$eval('[data-share-limits]',
      (element) => [...(element.textContent ?? '').matchAll(/\d+(?:\.\d+)?/gu)].map((number) => Number(number[0]))));

    await page.click('[data-share-access]');
    await page.click('[data-share-access-option="public"]');
    await page.click('[data-share-submit]');
    await until(page, 'the share to be made', `document.querySelector('[data-share-created]') !== null`);
    const link = v.parse(v.nullable(v.string()), await page.evaluate(`document.querySelector('[role="dialog"] a[href]')?.href ?? null`));
    let copied: string | null = null;

    if (link !== null) {
      // Chrome's writeText asks for the sanitized-write grant, not clipboard-write (measured on Chrome 151).
      await target.browser.defaultBrowserContext().overridePermissions(target.origin, ['clipboard-read', 'clipboard-sanitized-write']);
      await page.bringToFront();
      copied = v.parse(v.string(), await waitOn(page, 'the share link on the clipboard', page.evaluate(`(async () => {
        await navigator.clipboard.writeText('');
        document.querySelector('[role="dialog"] a[href]').parentElement.querySelector('button').click();
        for (;;) {
          const held = await navigator.clipboard.readText();
          if (held !== '') return held;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      })()`)));
    }

    await page.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find((button) => (button.textContent ?? '').trim() === 'Done')?.click()`);
    await until(page, 'the Shared tab', `document.querySelector('[data-drive-tab="shared"]') !== null`);
    await page.click('[data-drive-tab="shared"]');

    const mine = `[data-drive-section="Shared by you"] [data-drive-share-kind="live"]`;
    await until(page, 'the share under Shared by you', `document.querySelector(${JSON.stringify(mine)}) !== null`);
    const sharedByYou = v.parse(v.array(v.string()), await page.evaluate(sharesIn('Shared by you')));

    share = await page.$eval(mine, (element) => element.getAttribute('data-drive-share'));
    const tile = `[data-drive-share="${share ?? ''}"]`;

    await page.click(`${tile} [data-drive-menu]`);
    await page.click(`${tile} [data-drive-stop-sharing]`);
    await until(page, 'the stop confirmation', `document.querySelector('[data-drive-stop-confirm]') !== null`);
    await page.click('[data-drive-stop-confirm]');
    await until(page, 'the share to leave the Drive', `document.querySelector(${JSON.stringify(tile)}) === null`);
    stopped = true;
    await painted(page);

    const afterStop = v.parse(v.array(v.string()), await page.evaluate(sharesIn('Shared by you')));

    await page.close();

    return { workspace, reachRow, limitsStated, link, copied, sharedByYou, afterStop };
  } finally {
    if (share !== null && !stopped) {
      const left = await fetch(`${target.origin}/api/shared/revoke`, {
        method: 'POST',
        headers: { ...webHeaders(target.identity), 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, share }),
      });

      if (!left.ok) console.warn(`product-flows: revoking ${share} answered ${String(left.status)}`);
    }

    await removeFlowWorkspace(target, workspace);
  }
}
