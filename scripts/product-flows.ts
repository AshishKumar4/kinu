/**
 * THE PRODUCT'S OWN FLOWS, IN A BROWSER, AS A USER SEES THEM.
 *
 * Every row here drives real Chrome against a real product origin and asserts
 * only what the page shows: a tab, a link, an answer, a preview. The same rows
 * run twice with nothing but the origin changed (`KINU_ORIGIN`): before the
 * deploy against the local dev server (`scripts/with-dev-server.ts`, the real
 * Worker and Durable Objects in workerd) and after it against the deployment
 * (`scripts/product-flows-tier.sh`). The identity is resolved from that origin
 * by the eval plane's own resolver, so a row never asks where it runs.
 *
 * WHY THIS EXISTS. The first-run tier reads the deployment over its API and its
 * socket, the trajectory tier drives the model through the socket, and the
 * `*-ux` browser tests run on the gallery's fixtures. None of them loads the
 * page a person loads, so a workspace whose agents were all present over the
 * API showed none of them after a reload (#13), and every gate stayed green.
 *
 * Waits are conditions, never clocks: the page's own socket frames (read over
 * CDP) and its own controls say when it has settled.
 */
import type { Browser, Page } from 'puppeteer';
import * as v from 'valibot';
import { tolerate } from '@kinu.run/core/obs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalWorkspaceName, scratchDir } from '@kinu.run/test-utils';
import { webHeaders, type PublicWebIdentity } from '../tests/evals/public-session';
import { DESKTOP } from './live-app-harness';

/** Where a row runs and who it runs as. */
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

  return page;
}

const CreatedSchema = v.object({ name: v.string() });

/** A workspace made for one row through the app's own create route, with no
 *  mission, so no turn runs before the row's own. */
async function createFlowWorkspace(target: FlowTarget, subject: string): Promise<string> {
  const response = await fetch(`${target.origin}/api/user/workspaces`, {
    method: 'POST',
    headers: { ...webHeaders(target.identity), 'content-type': 'application/json' },
    body: JSON.stringify({ name: evalWorkspaceName(`browser-${subject}`) }),
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`creating a workspace answered ${String(response.status)}: ${text.slice(0, 400)}`);

  return v.parse(CreatedSchema, JSON.parse(text)).name;
}

/** Delete the row's workspace, the same DELETE the sidebar's Remove issues. A
 *  failed teardown is reported, never thrown over the row's own verdict. */
async function removeFlowWorkspace(target: FlowTarget, workspace: string): Promise<void> {
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

/** Press the agent strip's '+'; an absent control throws, and that is the finding. */
export const NEW_AGENT = `(() => {
  const create = [...document.querySelectorAll('nav[aria-label="Workspace agents"] button')]
    .find((b) => (b.getAttribute('aria-label') ?? '').includes('New agent'));
  if (create === undefined) throw new Error('no New agent control');
  create.click();
})()`;

/** The chat column's Send control is back to sending, so no turn is running:
 *  while one runs, the same control steers it instead. */
const CHAT_IDLE = `[...document.querySelectorAll('#chat button')].some((el) => el.getClientRects().length > 0
  && /send$/iu.test((el.getAttribute('aria-label') ?? '').trim()))`;

async function openWorkspacePage(target: FlowTarget, path: string): Promise<Page> {
  const page = await signedInPage(target.browser, target.identity);

  // 'load', not 'networkidle0': the app holds its event socket open from
  // first paint, so there is never a zero-connection window to wait for.
  await page.goto(`${target.origin}${path}`, { waitUntil: 'load' });
  await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });

  return page;
}

/** Type into the chat column's live composer and press its Send; resolves once
 *  the pane shows the words and the turn they started has ended. */
async function sendAndSettle(page: Page, text: string): Promise<void> {
  await page.evaluate(`(() => {
    const box = document.querySelector('#chat textarea:not([disabled])');
    if (box === null) throw new Error('no live composer in the chat column');
    box.focus();
  })()`);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(text)})`, { polling: 100 });
  await page.waitForFunction(CHAT_IDLE, { polling: 250 });
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
  /** Whether nothing the page asked is still unanswered. */
  quiet(): boolean;
  /** Resolves once a frame of `type` has arrived. */
  received(type: string): Promise<void>;
  restart(): void;
  stop(): Promise<void>;
}

async function frameLedger(page: Page): Promise<FrameLedger> {
  const cdp = await page.createCDPSession();

  await cdp.send('Network.enable');

  const asked = new Map<string, string>();
  const answered = new Set<string>();
  const arrived = new Set<string>();
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

  cdp.on('Network.webSocketFrameSent', (event: { response?: { payloadData?: string } }) => {
    const sent = frame(event.response?.payloadData);

    if (sent?.type === 'rpc' && sent.id !== undefined && sent.method !== undefined) asked.set(sent.id, sent.method);
  });
  cdp.on('Network.webSocketFrameReceived', (event: { response?: { payloadData?: string } }) => {
    const received = frame(event.response?.payloadData);

    if (received === null) return;
    arrived.add(received.type);

    // A streamed answer's chunks carry `done: false`; only its last frame, or
    // a plain answer, ends the ask.
    if (received.type === 'rpc' && received.id !== undefined && received.done !== false) answered.add(received.id);
    check();
  });

  return {
    quietAfter: (...methods) => wait(() => methods.every((method) => [...asked].some(([id, name]) => name === method && answered.has(id)))
      && [...asked.keys()].every((id) => answered.has(id))),
    quiet: () => [...asked.keys()].every((id) => answered.has(id)),
    received: (type) => wait(() => arrived.has(type)),
    restart() {
      asked.clear();
      answered.clear();
      arrived.clear();
    },
    stop: async () => { await cdp.detach(); },
  };
}

/** Resolves once every one of `methods` has been answered and the page has
 *  nothing unanswered across a painted frame: an answer that sets off a
 *  further ask (the roster read after the snapshot) keeps the wait going. */
async function settledAfter(page: Page, ledger: FrameLedger, ...methods: readonly string[]): Promise<void> {
  do {
    await ledger.quietAfter(...methods);
    await painted(page);
  } while (!ledger.quiet());
}

/** Two animation frames: whatever the last answer set in motion has painted. */
async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); });
  }));
}

/** What the reader sees of one agent: its tab in the strip and its entry in
 *  the sidebar, each by the agent's own name and each with the title shown. */
export interface AgentPresence {
  readonly tab: string | null;
  readonly sidebar: string | null;
}

const AgentPresenceSchema = v.object({ tab: v.nullable(v.string()), sidebar: v.nullable(v.string()) });

async function agentPresence(page: Page, workspace: string, agent: string): Promise<AgentPresence> {
  return v.parse(AgentPresenceSchema, await page.evaluate((input) => {
    const shown = (element: Element | null): string | null =>
      element !== null && element.getClientRects().length > 0 ? (element.textContent ?? '').trim() : null;

    return {
      tab: shown(document.querySelector(`nav[aria-label="Workspace agents"] [data-agent-tab="${input.agent}"]`)),
      sidebar: shown(document.querySelector(`aside a[href="/workspace/${input.workspace}/agents/${input.agent}"]`)),
    };
  }, { workspace, agent }));
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
 * title lands), rename it through its tab, go to another workspace, then open
 * the agent in a new page: its tab, its sidebar entry and its conversation must
 * all be there. #13, the owner's report of 2026-09-23: every agent was present
 * over the API and a reloaded page showed none of them.
 */
export async function agentIsThereOnReturn(target: FlowTarget): Promise<AgentReturnVerdict> {
  const workspace = await createFlowWorkspace(target, 'agent-return');
  const elsewhere = await createFlowWorkspace(target, 'agent-elsewhere');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await page.evaluate(NEW_AGENT);

    const agentPath = `/workspace/${encodeURIComponent(workspace)}/agents/`;

    await page.waitForFunction(`location.pathname.startsWith(${JSON.stringify(agentPath)})`, { polling: 100 });
    await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });

    const agent = v.parse(v.string(), await page.evaluate(`decodeURIComponent(location.pathname.slice(${String(agentPath.length)}))`));
    const said = `Reply with one word: ${agent}.`;
    const renamed = `Flow ${agent.slice(-6)}`;

    await sendAndSettle(page, said);

    // Rename through the tab: its title button opens the name field with the
    // current name selected, so typing replaces it.
    await page.click(`[data-agent-tab="${agent}"] button[title="Rename agent"]`);
    await page.waitForSelector('input[aria-label="Agent name"]');
    await page.keyboard.type(renamed);
    await page.keyboard.press('Enter');
    await page.waitForFunction(`document.querySelector('input[aria-label="Agent name"]') === null`, { polling: 100 });
    await page.waitForFunction(
      `(document.querySelector(${JSON.stringify(`[data-agent-tab="${agent}"]`)})?.textContent ?? '').includes(${JSON.stringify(renamed)})`,
      { polling: 100 });

    const before = await agentPresence(page, workspace, agent);

    await page.goto(`${target.origin}/workspace/${encodeURIComponent(elsewhere)}`, { waitUntil: 'load' });
    await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });
    await page.close();

    const back = await signedInPage(target.browser, target.identity);
    const ledger = await frameLedger(back);

    await back.goto(`${target.origin}${agentPath}${encodeURIComponent(agent)}`, { waitUntil: 'load' });
    await settledAfter(back, ledger, 'getWorkspaceSnapshot', 'getChatHistoryPage');

    const after = await agentPresence(back, workspace, agent);
    const conversation = v.parse(v.string(), await back.evaluate(`document.querySelector('#chat')?.textContent ?? ''`));

    await ledger.stop();
    await back.close();

    return { workspace, agent, renamed, said, before, after, conversation };
  } finally {
    await removeFlowWorkspace(target, workspace);
    await removeFlowWorkspace(target, elsewhere);
  }
}

/** The answers the chat column has drawn: every rendered reply block's text. */
const ANSWERS = `[...document.querySelectorAll('#chat .prose-chat')]
  .filter((block) => block.getClientRects().length > 0)
  .map((block) => (block.textContent ?? '').trim())
  .filter((text) => text.length > 0)`;

/** The mission the first-answer row creates its workspace with. */
const MISSION = 'Say hello to a first-time user in one short sentence.';

export interface FirstAnswerVerdict {
  readonly workspace: string;
  /** Where the create landed the reader, as the address bar showed it. */
  readonly landedAt: string;
  /** The replies on screen once the workspace's first turn ended. */
  readonly answers: readonly string[];
}

/**
 * Row: a person creates a workspace from the home page and gets a first answer.
 *
 * Type a mission into the home page's form and press Create workspace; the page
 * must land in the new workspace, and its first turn, the one the mission
 * starts, must end with a reply on screen.
 */
export async function workspaceGetsFirstAnswer(target: FlowTarget): Promise<FirstAnswerVerdict> {
  const page = await signedInPage(target.browser, target.identity);
  let workspace: string | null = null;

  try {
    await page.goto(`${target.origin}/`, { waitUntil: 'load' });
    await page.waitForFunction(`document.querySelector('#workspace-mission:not([disabled])') !== null`, { polling: 100 });
    await page.focus('#workspace-mission');
    await page.keyboard.type(MISSION);
    await page.evaluate(`(() => {
      const create = [...document.querySelectorAll('button[type="submit"]')]
        .find((b) => (b.textContent ?? '').trim() === 'Create workspace');
      if (create === undefined) throw new Error('no Create workspace control');
      create.click();
    })()`);
    await page.waitForFunction(`location.pathname.startsWith('/workspace/')`, { polling: 100 });

    const landedAt = v.parse(v.string(), await page.evaluate('location.pathname'));

    workspace = decodeURIComponent(landedAt.slice('/workspace/'.length).split('/')[0] ?? '');
    await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });
    // The mission's turn has ended once the pane shows the mission and its
    // Send control is back, answered or not: the row reads what was drawn.
    await page.waitForFunction(`(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(MISSION)})`,
      { polling: 100 });
    await page.waitForFunction(CHAT_IDLE, { polling: 250 });

    const answers = v.parse(v.array(v.string()), await page.evaluate(ANSWERS));

    await page.close();

    return { workspace, landedAt, answers };
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

/** The clockless settle after a press: the measured number, equal on two
 *  consecutive animation frames. A control that does nothing settles at the
 *  number it started with, so no deadline is needed to tell an inert control
 *  from a slow one, and a panel that animates is read after it lands. */
export async function settled(page: Page, read: string): Promise<void> {
  await page.evaluate('window.__liveSettle = undefined');
  await page.waitForFunction(
    `(() => {
      const value = ${read};
      const previous = window.__liveSettle;
      window.__liveSettle = value;
      return previous === value;
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

/** The Diffs tab has read its change-set: a file row or its empty state is drawn. */
const DIFFS_SETTLED = `(() => {
  const pane = document.querySelector('#inspector');
  const text = pane?.textContent ?? '';
  return /Workspace changes|Uncommitted changes|No diffs yet|Not a git repository/u.test(text);
})()`;

/** The changed paths the Diffs tab lists, as its file rows show them. */
const DIFF_PATHS = `[...document.querySelectorAll('#inspector .font-mono')].map((cell) => (cell.textContent ?? '').trim())`;

/** A file name no scaffold file can carry. */
export const FLOW_PROBE = 'flow-probe.txt';

export interface WrittenFileVerdict {
  readonly workspace: string;
  /** Every entry the Files tab listed once its listing settled. */
  readonly filesListed: readonly string[];
  /** Whether the strip drew a Diffs tab once the turn had written. */
  readonly diffsTab: boolean;
  /** The Diffs tab's changed paths; empty when it drew no Diffs tab. */
  readonly diffPaths: readonly string[];
}

/**
 * Row: a file the agent writes shows in the Files tab and in the Diffs tab.
 *
 * One turn writes one file; the reader opens the inspector, reads the Files
 * tab's listing, and opens the Diffs tab the write should have raised.
 */
export async function writtenFileShowsInFilesAndDiffs(target: FlowTarget): Promise<WrittenFileVerdict> {
  const workspace = await createFlowWorkspace(target, 'files-diffs');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await sendAndSettle(page, `Use your file tool to write a new file named ${FLOW_PROBE} in the workspace, `
      + 'containing exactly the words browser flow probe. Then reply with one line: DONE.');
    await openInspector(page);
    await page.evaluate(stripTab('Files'));
    await page.waitForFunction(FILES_SETTLED, { polling: 100 });

    const filesListed = v.parse(v.array(v.string()), await page.evaluate(FILES_LISTED));
    const diffsTab = v.parse(v.boolean(), await page.evaluate(stripHas('Diffs')));
    let diffPaths: readonly string[] = [];

    if (diffsTab) {
      await page.evaluate(stripTab('Diffs'));
      await page.waitForFunction(DIFFS_SETTLED, { polling: 100 });
      diffPaths = v.parse(v.array(v.string()), await page.evaluate(DIFF_PATHS));
    }

    await page.close();

    return { workspace, filesListed, diffsTab, diffPaths };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

/** The slate the slate row asks for: its manifest title, its directory, and
 *  words its page serves that no scaffold carries. */
export const FLOW_SLATE = { title: 'Flow probe', id: 'flow', page: 'browser flow slate' } as const;

export interface SlatePreviewVerdict {
  readonly workspace: string;
  /** Whether the strip drew a tab under the slate's title once the turn ended. */
  readonly slateTab: boolean;
  /** The slate's preview frame's page text once it loaded; null when no frame drew. */
  readonly frameText: string | null;
}

/**
 * Row: a slate the agent builds shows its running preview in its own tab.
 *
 * One turn builds a slate that serves a page and starts its preview; once the
 * page has re-listed the workspace's slates, the reader presses the slate's tab
 * and reads the page its frame loaded.
 */
export async function slateShowsItsPreview(target: FlowTarget): Promise<SlatePreviewVerdict> {
  const workspace = await createFlowWorkspace(target, 'slate-preview');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);
    const ledger = await frameLedger(page);

    await sendAndSettle(page, `Use the file tool to create a slate at /home/user/slates/${FLOW_SLATE.id}/. `
      + `Write package.json with main "server.ts" and slate {"title":"${FLOW_SLATE.title}","port":8788,"bindings":{}}. `
      + `Write server.ts so the slate answers GET / with an HTML page whose body is <h1>${FLOW_SLATE.page}</h1>. `
      + 'Start its preview yourself and check that it answers. Reply with the preview URL.');
    await settledAfter(page, ledger);
    await openInspector(page);

    const tab = `#inspector button[aria-label="${FLOW_SLATE.title}"]`;
    const slateTab = v.parse(v.boolean(), await page.evaluate(`document.querySelector(${JSON.stringify(tab)}) !== null`));
    let frameText: string | null = null;

    if (slateTab) {
      await page.click(tab);

      const holder = await page.waitForSelector(`#inspector iframe[title="${FLOW_SLATE.id}"]`);
      const frame = await holder?.contentFrame();

      if (frame !== null && frame !== undefined) {
        await frame.waitForFunction('document.readyState === "complete"', { polling: 100 });
        frameText = v.parse(v.string(), await frame.evaluate('(document.body?.textContent ?? "").trim()'));
      }
    }

    await ledger.stop();
    await page.close();

    return { workspace, slateTab, frameText };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

/** The entry names the Drive list shows. */
const DRIVE_LISTED = `[...document.querySelectorAll('[data-drive-entry]')].map((row) => row.getAttribute('data-drive-entry') ?? '')`;

/** Run `act`, then resolve once the Drive listing it causes has been answered
 *  and painted: every change the page makes ends in a fresh listing. */
async function relisted(page: Page, act: () => Promise<void>): Promise<readonly string[]> {
  const listing = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/drive');

  await act();
  await listing;
  await painted(page);

  return v.parse(v.array(v.string()), await page.evaluate(DRIVE_LISTED));
}

/** Name a Drive entry through the page's name dialog: the field opens with
 *  its current value selected, so typing replaces it. */
async function nameInDialog(page: Page, name: string): Promise<void> {
  await page.waitForSelector('#drive-name');
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
 * Make a folder and upload a file, rename the folder, reload, then delete both
 * through their rows' own controls. The Drive is the account's, not a
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
    await relisted(page, async () => { await page.goto(`${target.origin}/drive`, { waitUntil: 'load' }); });
    await relisted(page, async () => {
      await page.click('[data-drive-new-folder]');
      await nameInDialog(page, folder);
    });

    const picker = await page.$('input[data-drive-files-input]');

    if (picker === null) throw new Error('the Drive page has no file picker');

    const afterCreate = await relisted(page, () => picker.uploadFile(upload));

    await relisted(page, async () => {
      await page.click(`[data-drive-entry="${folder}"] [data-drive-rename]`);
      await nameInDialog(page, renamed);
    });

    const afterRename = await relisted(page, async () => { await page.reload({ waitUntil: 'load' }); });

    for (const entry of [renamed, file]) {
      await relisted(page, async () => {
        await page.click(`[data-drive-entry="${entry}"] [data-drive-delete]`);
        await page.waitForSelector('[data-drive-delete-confirm]');
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
