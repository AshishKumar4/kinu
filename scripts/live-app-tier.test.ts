/**
 * The live-app e2e suite: the real product in a real browser, ONE suite with
 * a parameterised origin.
 *
 * `KINU_E2E_ORIGIN` points the rows at the product to drive:
 *   unset (the pre-publish run) — the suite boots the local dev server itself
 *     (vite dev = real Worker in workerd, real Durable Objects, real client)
 *     through live-app-harness, plus a local scripted model the workspaces are
 *     configured to use, so the visual rows have live content to render.
 *   an https origin (the comprehensive run) — the same three rows run against
 *     that deployment with no second harness and no second copy of any row.
 *
 * SCOPE. This suite owns only what a rendered document can prove: geometry,
 * node identity, and what the DOM shows after a real interaction. The
 * behavioural half of the old draft — a subagent chat opening and answering,
 * text rendering before the tool card it preceded — is RPC and data shape,
 * provable inside the workerd pool without a DOM, and lives there (the
 * cloudflare-os in-pool session harness); it is deliberately NOT here.
 *
 * Every assertion is geometry, identity or counts — never a copied sentence,
 * never a source-text match.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createHttpServer, type Server } from 'node:http';
import { hostedActorSocketPath, parseJsonValue, type JsonValue } from '@kinu.run/core';
import { renderThrownChain, tolerate } from '@kinu.run/core/obs';
import { git } from '@kinu.run/test-utils';

import { withLiveApp, type LiveApp } from './live-app-harness';

/** Screenshots land beside the other lanes' evidence, outside the worktree. */
const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'wave2-0917', 'browser');

mkdirSync(SHOTS, { recursive: true });

async function shoot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });

  return path;
}

const OutboundMessageSchema = v.object({ role: v.optional(v.string()) });

const OutboundBodySchema = v.object({ messages: v.optional(v.array(OutboundMessageSchema)) });

/** What the fake model answers with. One string, so the row that waits for the
 *  answer waits for the words this server actually sends. */
const FAKE_ANSWER = 'Live answer from the fake model.';

/** The fake model behind the local origin: live SSE so the panes render real content. */
interface FakeModel {
  server: Server | null;
  port: number;
}

async function startFakeModel(): Promise<FakeModel> {
  const state: FakeModel = { server: null, port: 0 };

  const http = createHttpServer((request, response) => {
    let body = '';

    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake.invalid');

      if (url.pathname === '/models' && request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-live', name: 'Fake Live' }] }));

        return;
      }

      if (url.pathname === '/chat/completions' && request.method === 'POST') {
        v.parse(OutboundBodySchema, parseJsonValue(body));
        const base = { index: 0, delta: { content: FAKE_ANSWER } };

        const chunk = {
          id: 'chatcmpl-live-tier', object: 'chat.completion.chunk', created: 1, model: 'fake-live',
          choices: [base, { ...base, delta: { role: 'assistant' }, finish_reason: 'stop' }],
        };

        response.setHeader('content-type', 'text/event-stream');
        response.end(`data: ${JSON.stringify(chunk)}\n\n data: [DONE]\n\n`);

        return;
      }

      response.statusCode = 404;
      response.end('nope');
    });
  });

  const listening = Promise.withResolvers<void>();

  http.once('error', listening.reject);
  http.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;

  const parsed = v.parse(v.object({ port: v.number() }), http.address());

  state.server = http;
  state.port = parsed.port;

  return state;
}

async function stopFakeModel(fake: { server: Server | null }): Promise<void> {
  const server = fake.server;

  if (server === null) throw new Error('fake model never bound its server');

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const WorkspaceEntrySchema = v.object({ name: v.string() });

/** The route's JSON answer, parsed as a value rather than passed as unknown. */
async function apiJson(origin: string, path: string, init?: RequestInit): Promise<JsonValue> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${String(response.status)}: ${text.slice(0, 200)}`);

  return text ? parseJsonValue(text) : null;
}

async function createWorkspace(origin: string, name: string, purpose: string): Promise<string> {
  const created = v.parse(
    WorkspaceEntrySchema,
    await apiJson(origin, '/api/user/workspaces', {
      method: 'POST', body: JSON.stringify({ name, purpose, model: 'openai-compat/fake-live' }),
    }),
  );

  return created.name;
}

/** The key=value lines of a .dev.vars file, merged left to right. Only
 *  process-env ABSENT keys are supplied: an explicit export always wins, and
 *  nothing the shell already provides is shadowed by a file. */
function loadDevVars(paths: readonly string[]) {
  const env: Record<string, string> = {};

  for (const path of paths) {
    if (!existsSync(path)) continue;

    const text = readFileSync(path, 'utf8');

    for (const line of text.split('\n')) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());

      if (match === null) continue;

      const [, key, value] = match;

      if (key === undefined || value === undefined) continue;

      if (process.env[key] !== undefined) continue;

      env[key] = value;
    }
  }

  return env;
}

/** The worktree's own `.dev.vars` files first (checkout-local wins), then the
 *  primary checkout's root `.dev.vars` — where the containers-registry token
 *  lives — resolved through `git worktree list` row one, never a literal path.
 *  vite dev needs these in PROCESS env for the container registry; wrangler's
 *  own secret injection does not cover that check (measured 2026-09-17: dev
 *  exits "error when starting dev server" without CLOUDFLARE_API_TOKEN). */
function liveAppEnv() {
  const repo = join(import.meta.dir, '..');
  const primary = /^worktree (.+)$/mu.exec(git(repo, 'worktree', 'list', '--porcelain'))?.[1];

  return loadDevVars([
    join(repo, '.dev.vars'),
    join(repo, 'packages', 'cf-backend', '.dev.vars'),
    ...(primary !== undefined ? [join(primary, '.dev.vars')] : []),
  ]);
}

/** This run's own workspace suffix. The local dev server keeps its Durable
 *  Objects between runs, so a fixed workspace name would have each row reading
 *  the previous run's transcript, cards and journal as if they were the
 *  product's first state (measured 2026-09-17: two runs put both runs' sent
 *  messages in one root transcript). */
const RUN_ID = crypto.randomUUID().slice(0, 8);

/** A desktop viewport for every row: the inspector column, its separator and
 *  the rail lane exist above 900px (`INSPECTOR_WIDE_QUERY`), and every defect
 *  these rows pin is a desktop layout. Puppeteer's own default page is
 *  800x600, where the column is a mobile pane whose geometry means nothing. */
const DESKTOP = { width: 1440, height: 900 } as const;

async function openWorkspace(newPage: LiveApp['newPage'], origin: string, workspace: string): Promise<Page> {
  const page = await newPage();

  await page.setViewport(DESKTOP);

  // 'load', not 'networkidle0': the app holds its event socket open from
  // first paint, so there is never a zero-connection window to wait for.
  await page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' });
  await page.waitForFunction(`document.querySelector('textarea') !== null`, { polling: 100 });

  return page;
}

/** Click the control; an absent control throws, and that is the finding. */
const ClickScripts = {
  newAgent: `(() => {
    const create = [...document.querySelectorAll('nav[aria-label="Workspace agents"] button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('New agent'));
    if (create === undefined) throw new Error('no New agent control');
    create.click();
  })()`,
  lastAgentTab: `(() => {
    const tabs = [...document.querySelectorAll('nav[aria-label="Workspace agents"] a')];
    const target = tabs.pop();
    if (target === undefined) throw new Error('no agent tab to open');
    target.click();
  })()`,
  mainTab: `(() => {
    const first = [...document.querySelectorAll('nav[aria-label="Workspace agents"] a')][0];
    if (first === undefined) throw new Error('no Main tab to return to');
    first.click();
  })()`,
  filesTab: `(() => {
    const files = [...document.querySelectorAll('.p-tabstrip')]
      .flatMap((el) => [...el.querySelectorAll('button')])
      .find((b) => b.textContent?.trim() === 'Files');
    if (files === undefined) throw new Error('no Files tab');
    files.click();
  })()`,
} as const;

/** RPC method counts over the socket via CDP, split by direction, beside what
 *  a hosted actor's own socket carried. */
interface RpcCounts {
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

interface RpcCounter {
  counts(): RpcCounts;
  stop(): Promise<void>;
}

async function countRpc(page: Page): Promise<RpcCounter> {
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

/** Workspace-scoped reads the right panel owns; Agent and Activity are per agent. */
const WORKSPACE_READS = [
  'getWorkspaceSnapshot', 'getExposedPorts', 'listPendingActions', 'getMemoryContent',
  'getToolDescriptions', 'getExecutors', 'listBackgroundJobs', 'listSlates',
  'listPendingConsents', 'getActivePlanReview',
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

interface PanelVerdict {
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

interface PlanTabsVerdict {
  /** The inspector strip's tab labels, in the order it draws them. */
  readonly labels: readonly string[];
  /** Every tab or filter chip in the column whose name bears 'plan'. */
  readonly planBearing: readonly string[];
}

interface StripGeometry {
  readonly ruleBottom: number;
  readonly stripBottom: number;
  /** The rule's right edge vs the PANEL's right edge: a rule that stops
   *  before the icon column leaves a visible break (B5's horizontal half). */
  readonly ruleRight: number;
  readonly panelRight: number;
  /** The chat column's own tab rule. The two columns sit side by side at one
   *  strip height, so a rule at a different Y is the break B5's third clause
   *  names (the rail carries no header rule of its own to compare against). */
  readonly chatRuleBottom: number;
  readonly activeBottom: number;
  readonly mode: string;
}

interface GeometryVerdict {
  readonly dark: StripGeometry;
  readonly light: StripGeometry;
}

interface TierVerdicts {
  bootFailure: string | null;
  panel: PanelVerdict | null;
  planTabs: PlanTabsVerdict | null;
  geometry: GeometryVerdict | null;
  controls: ControlsVerdict | null;
  stamped: StampedCardVerdict | null;
}

const StripGeometrySchema = v.object({
  ruleBottom: v.number(), stripBottom: v.number(),
  ruleRight: v.number(), panelRight: v.number(),
  chatRuleBottom: v.number(), activeBottom: v.number(), mode: v.string(),
});

const observed: TierVerdicts = {
  bootFailure: null, panel: null, planTabs: null, geometry: null,
  controls: null, stamped: null,
};

/** The inspector column, `#inspector` — the id `use-inspector-layout` hands the
 *  panel and which `react-resizable-panels` renders on its element — as a
 *  rounded width; -1 when no such box is in the document at all. */
const INSPECTOR_WIDTH = `(() => {
  const panel = document.querySelector('#inspector');
  return panel === null ? -1 : Math.round(panel.getBoundingClientRect().width);
})()`;

/** The lane the rail occupies, measured as the space left of the content
 *  column: `main`'s own left edge in the shell's flex row. Read this way on
 *  purpose — a rail may collapse by narrowing its `aside`, by unmounting it for
 *  a zero-width holder, or by any third shape, and what the reader sees either
 *  way is how much of the window sits left of the content. -1 when the shell
 *  has no content column at all. */
const RAIL_LANE = `(() => {
  const content = document.querySelector('main');
  return content === null ? -1 : Math.round(content.getBoundingClientRect().left);
})()`;

/** The chat column, `#chat` — the id the workspace shell gives that panel. A
 *  live pane there has a composer its socket has enabled; a pane still
 *  connecting renders no composer at all (`WorkspacePage` returns the notice
 *  instead). Scoped on purpose: a textarea in the inspector column answers a
 *  page-wide query and is not a composer. */
const CHAT_COMPOSER_LIVE = `[...document.querySelectorAll('#chat textarea')].some(t => !t.disabled)`;

/** Which tab of the agent strip is current, by index: 0 is Main, the
 *  subordinates follow in roster order, -1 while none is marked. */
const ACTIVE_TAB_INDEX = `(() => {
  const tabs = [...document.querySelectorAll('nav[aria-label="Workspace agents"] a')];
  return tabs.findIndex((tab) => tab.getAttribute('aria-current') === 'page');
})()`;

/** Where a send landed: the path, the current tab's index, and whether the chat
 *  column still held a live composer as the words went. */
interface SendSite {
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
async function sendInChat(page: Page, text: string): Promise<SendSite> {
  await page.evaluate(`(() => {
    const box = document.querySelector('#chat textarea:not([disabled])');
    if (box === null) throw new Error('no live composer in the chat column');
    box.focus();
  })()`);
  await page.keyboard.type(text);

  const site = v.parse(SendSiteSchema, await page.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('nav[aria-label="Workspace agents"] a')];
    const send = [...document.querySelectorAll('#chat button')]
      .find((el) => el.getClientRects().length > 0
        && /send$|steer the running turn/iu.test((el.getAttribute('aria-label') ?? '').trim()));
    if (send === undefined) throw new Error('no Send control in the chat column');
    send.click();
    return {
      path: location.pathname,
      tabIndex: tabs.findIndex((tab) => tab.getAttribute('aria-current') === 'page'),
      composerInChat: ${CHAT_COMPOSER_LIVE},
    };
  })()`));

  await page.waitForFunction(
    `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(text)})`,
    { polling: 100 },
  );

  return site;
}

/** A shut inspector column: the library leaves a 0px box, and a hair of border
 *  or padding still counts as shut. */
const INSPECTOR_SHUT_PX = 40;

/** A collapsed rail: an icon strip at most. Its open lane is 240px (`w-60`). */
const RAIL_SHUT_PX = 64;

const OPEN_NAMES = 'show|expand|open';

const SHUT_NAMES = 'hide|collapse|close';

/** The clockless settle after a press: the measured number, equal on two
 *  consecutive animation frames. A control that does nothing settles at the
 *  number it started with, so no deadline is needed to tell an inert control
 *  from a slow one, and a panel that animates is read after it lands. */
async function settled(page: Page, read: string): Promise<void> {
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
interface ControlAttempt {
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
async function pressUntil(page: Page, input: {
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
async function openInspector(page: Page): Promise<void> {
  const outcome = await pressUntil(page, {
    names: OPEN_NAMES, read: INSPECTOR_WIDTH, reached: (width) => width > INSPECTOR_SHUT_PX,
  });

  if (outcome.reached) return;

  throw new Error(`the inspector column stayed at ${String(outcome.value)}px; tried ${JSON.stringify(outcome.attempts)}`);
}

/** Row 1 (B6): the right panel keeps its Work, Files and Env state across a
 *  chat-tab switch — the same DOM node, the same scroll offset, and no
 *  workspace-scoped read re-sent in either direction. */
async function measurePanel(newPage: LiveApp['newPage'], origin: string): Promise<PanelVerdict> {
  const workspace = await createWorkspace(origin, `live-row-panel-${RUN_ID}`, 'panel state probe');
  const page = await openWorkspace(newPage, origin, workspace);

  await openInspector(page);

  const counter = await countRpc(page);

  await page.evaluate(ClickScripts.filesTab);
  await page.waitForFunction(
    `[...document.querySelectorAll('.p-tabstrip')].flatMap(el => [...el.querySelectorAll('button')]).some(b => b.textContent.trim() === 'Files' && b.className.includes('p-tab-active'))`,
    { polling: 100 },
  );

  const marked = v.parse(
    v.object({ ok: v.literal(true), scrollTop: v.number() }),
    await page.evaluate(() => {
      const strips = [...document.querySelectorAll('.p-tabstrip')];
      const workStrip = strips.find((el) => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Work'));
      const content = workStrip?.parentElement?.parentElement?.children[1];

      if (!content) return { ok: false as const, scrollTop: -1 };

      content.setAttribute('data-live-probe', 'work-surface');
      content.scrollTop = 53;

      return { ok: true as const, scrollTop: content.scrollTop };
    }),
  );

  const beforeSwitch = counter.counts();

  await page.evaluate(ClickScripts.newAgent);
  await page.waitForFunction(
    `[...document.querySelectorAll('nav[aria-label="Workspace agents"] a')].length > 1`,
    { polling: 100 },
  );
  await page.evaluate(ClickScripts.lastAgentTab);
  await page.waitForFunction(`${ACTIVE_TAB_INDEX} > 0`, { polling: 100 });

  // The '+' flow: the subordinate column mounts a composer its own socket has
  // enabled. The hosted-actor socket defect left that pane connecting forever,
  // so this row's number is the frames that socket answered with.
  await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });

  const afterSwitch = counter.counts();

  await page.evaluate(ClickScripts.mainTab);
  await page.waitForFunction(`${ACTIVE_TAB_INDEX} === 0`, { polling: 100 });
  await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });
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
}

/** Row 2 (B12): plans have one owner in the inspector column. The duplicate
 *  B12 names is a `Plans` tab in the strip beside the Journal's own `Plan`
 *  filter below it, so the count spans the whole column — its tab strip and
 *  its filter chips — and the strip's labels are reported beside it. */
async function measurePlanTabs(newPage: LiveApp['newPage'], origin: string): Promise<PlanTabsVerdict> {
  const workspace = await createWorkspace(origin, `live-row-plan-${RUN_ID}`, 'plan probe');
  const page = await openWorkspace(newPage, origin, workspace);

  await openInspector(page);

  const read = v.parse(
    v.object({ labels: v.array(v.string()), planBearing: v.array(v.string()) }),
    await page.evaluate(() => {
      const panel = document.querySelector('#inspector');

      if (panel === null) throw new Error('no inspector column to read tabs from');

      const visible = (el: Element): boolean => el.getClientRects().length > 0;
      const nameOf = (el: Element): string => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      const strip = panel.querySelector('.p-tabstrip');
      const labels = [...(strip?.querySelectorAll('button') ?? [])].filter(visible).map(nameOf);

      // Tab-like controls only: the strip's tabs and the journal's filter
      // chips. A plan CARD inside the Work surface is content, not an owner.
      const planBearing = [...panel.querySelectorAll('.p-tabstrip button, [aria-pressed]')]
        .filter(visible)
        .map(nameOf)
        .filter((label) => /plan/iu.test(label));

      return { labels, planBearing };
    }),
  );

  await shoot(page, 'b12-inspector-tabs');
  await page.close();

  return read;
}

const readStripGeometry = `(() => {
  const strip = [...document.querySelectorAll('.p-tabstrip')].find((el) =>
    [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Work'));
  if (strip === undefined) throw new Error('no Work strip');
  const rule = strip.parentElement;
  if (rule === null) throw new Error('no strip rule container');
  const active = [...strip.querySelectorAll('button')].find((b) => b.className.includes('p-tab-active'));
  if (active === undefined) throw new Error('no active tab');
  const panel = rule.closest('#inspector');
  if (panel === null) throw new Error('no inspector column around the strip');
  const chatRule = document.querySelector('nav[aria-label="Workspace agents"]');
  if (chatRule === null) throw new Error('no chat tab rule');
  return {
    ruleBottom: Math.round(rule.getBoundingClientRect().bottom),
    stripBottom: Math.round(strip.getBoundingClientRect().bottom),
    ruleRight: Math.round(rule.getBoundingClientRect().right),
    panelRight: Math.round(panel.getBoundingClientRect().right),
    chatRuleBottom: Math.round(chatRule.getBoundingClientRect().bottom),
    activeBottom: active.getBoundingClientRect().bottom,
    mode: document.documentElement.getAttribute('data-mode') ?? '?',
  };
})()`;

/** Row 3 (B5): the tab strip's rule is continuous, reaches the column's own
 *  right edge, and the active underline sits on it — dark and light. */
async function measureGeometry(newPage: LiveApp['newPage'], origin: string): Promise<GeometryVerdict> {
  const workspace = await createWorkspace(origin, `live-row-geometry-${RUN_ID}`, 'geometry probe');
  const page = await openWorkspace(newPage, origin, workspace);

  await openInspector(page);

  const dark = v.parse(StripGeometrySchema, await page.evaluate(readStripGeometry));

  await shoot(page, 'b5-strip-dark');
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });
  await openInspector(page);

  const light = v.parse(StripGeometrySchema, await page.evaluate(readStripGeometry));

  await shoot(page, 'b5-strip-light');
  await page.close();

  return { dark, light };
}

/** Row 4 (B8): a collapsed right panel can be reopened, and the left rail can
 *  be collapsed. Controls are found by ROLE and NAME — a button or separator
 *  whose accessible name says hide/show/collapse/expand/open/close, never a
 *  copied sentence — and every verdict is the box a press left behind. */
interface ControlsVerdict {
  /** The column as the product first drew it, before anything was pressed. */
  readonly inspectorWidthFirst: number;
  readonly openAttempts: readonly ControlAttempt[];
  readonly inspectorWidthOpened: number;
  readonly shutAttempts: readonly ControlAttempt[];
  readonly inspectorWidthShut: number;
  readonly reopenAttempts: readonly ControlAttempt[];
  readonly inspectorWidthReopened: number;
  /** The rail's lane before and after the presses, and every name tried. */
  readonly railLaneBefore: number;
  readonly railAttempts: readonly ControlAttempt[];
  readonly railLaneAfter: number;
}

/** Row 5 (B3's symptom): each pane renders its own transcript and no other
 *  actor's. Measured with a marker per side — words this run sent into the root
 *  and words it sent into the actor — rather than by card markup: a
 *  `signal_card` frame carries no actor id at all (`SignalCardEvent`), which is
 *  the defect's own mechanism, and the workspace-created card carries no
 *  attribute either (`WorkspaceCreatedCard` is a styled pill), so the card
 *  kinds below are evidence beside the two counts, never the verdict. */
interface StampedCardVerdict {
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

const LayoutProbeSchema = v.object({
  inspectorWidth: v.number(),
  railLane: v.number(),
});

/** Both measurements at once, off the same reads the presses settle on. */
const probeLayoutScript = `({ inspectorWidth: ${INSPECTOR_WIDTH}, railLane: ${RAIL_LANE} })`;

async function measureControls(newPage: LiveApp['newPage'], origin: string): Promise<ControlsVerdict> {
  const workspace = await createWorkspace(origin, `live-row-controls-${RUN_ID}`, 'collapse controls probe');
  const page = await openWorkspace(newPage, origin, workspace);

  const before = v.parse(LayoutProbeSchema, await page.evaluate(probeLayoutScript));

  // Opened first, from whatever state the product chose: a fresh workspace
  // holds nothing worth showing, so the column arrives shut.
  const opened = await pressUntil(page, {
    names: OPEN_NAMES, read: INSPECTOR_WIDTH, reached: (width) => width > INSPECTOR_SHUT_PX,
  });

  await shoot(page, 'b8-opened');

  // Shut it with the column's own control, so the reopen below faces the
  // defect's own situation: a panel the reader collapsed.
  const shut = await pressUntil(page, {
    names: SHUT_NAMES, read: INSPECTOR_WIDTH, within: '#inspector',
    reached: (width) => width <= INSPECTOR_SHUT_PX,
  });

  const reopened = await pressUntil(page, {
    names: OPEN_NAMES, read: INSPECTOR_WIDTH, reached: (width) => width > INSPECTOR_SHUT_PX,
  });

  await shoot(page, 'b8-reopened');

  // The left rail: every visible control outside the column whose name offers
  // collapsing, hiding or closing, or names the rail, the sidebar or the menu.
  const rail = await pressUntil(page, {
    names: `${SHUT_NAMES}|sidebar|rail|menu`, read: RAIL_LANE, outside: '#inspector',
    reached: (lane) => lane >= 0 && lane <= RAIL_SHUT_PX,
  });

  await shoot(page, 'b8-rail-probe');
  await page.close();

  return {
    inspectorWidthFirst: before.inspectorWidth,
    openAttempts: opened.attempts,
    inspectorWidthOpened: opened.value,
    shutAttempts: shut.attempts,
    inspectorWidthShut: shut.value,
    reopenAttempts: reopened.attempts,
    inspectorWidthReopened: reopened.value,
    railLaneBefore: before.railLane,
    railAttempts: rail.attempts,
    railLaneAfter: rail.value,
  };
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

      const carriers = [...document.querySelectorAll('#chat *')]
        .filter(visible)
        .filter((el) => (el.textContent ?? '').includes(needle))
        .filter((el) => ![...el.children].some((child) => (child.textContent ?? '').includes(needle)));

      const cards = [...document.querySelectorAll('#chat [data-system-event], #chat [data-advisor-severity]')]
        .filter(visible)
        .map((el) => el.getAttribute('data-system-event') ?? el.getAttribute('data-advisor-severity') ?? '?');

      return { carriers: carriers.length, cards };
    }, phrase),
  );
}

/** Row 5: each pane renders its own transcript and no other actor's. Driven
 *  through the real flow — a turn on Main, the '+' tab, a turn on the actor —
 *  and measured in both directions with one marker per side. */
async function measureStampedCard(newPage: LiveApp['newPage'], origin: string): Promise<StampedCardVerdict> {
  const workspace = await createWorkspace(origin, `live-row-stamp-${RUN_ID}`, 'stamped card probe');
  const page = await openWorkspace(newPage, origin, workspace);
  const counter = await countRpc(page);

  await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });

  // The root gets a turn of its own first, so the actor's pane below has
  // something it could leak: a transcript with words in it. Without this the
  // actor-side direction of the row could not go red at all.
  const rootMarker = `root opening ${crypto.randomUUID().slice(0, 8)}`;

  await sendInChat(page, rootMarker);
  await page.waitForFunction(
    `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(FAKE_ANSWER)})`,
    { polling: 100 },
  );
  await shoot(page, 'stamp-root-before');

  await page.evaluate(ClickScripts.newAgent);
  await page.waitForFunction(
    `[...document.querySelectorAll('nav[aria-label="Workspace agents"] a')].length > 1`,
    { polling: 100 },
  );
  await page.evaluate(ClickScripts.lastAgentTab);
  await page.waitForFunction(`${ACTIVE_TAB_INDEX} > 0`, { polling: 100 });
  // The actor's pane is live when ITS column holds an enabled composer: a pane
  // still connecting renders the notice and no composer at all.
  await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });
  await settled(page, `document.querySelectorAll('#chat *').length`);

  const actorPane = await paneHolds(page, rootMarker);

  const actorMarker = `stamp probe ${crypto.randomUUID().slice(0, 8)}`;
  const sentOn = await sendInChat(page, actorMarker);

  // The pane echoed the words inside `sendInChat`. The turn has then run its
  // course when the model's answer shows in this pane, or the marker is
  // rendered inside a card — the system-card attribute or the drained-events
  // list, never the composer's echo. One predicate for both, so no wait is left
  // dangling on a page that then closes.
  await page.waitForFunction(
    `[...document.querySelectorAll('#chat [data-system-event] *, #chat .divide-dashed *')]`
    + `.some(el => (el.textContent ?? '').includes(${JSON.stringify(actorMarker)}))`
    + ` || (document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(FAKE_ANSWER)})`,
    { polling: 100 },
  );

  await shoot(page, 'stamp-actor-pane');

  await page.evaluate(ClickScripts.mainTab);
  await page.waitForFunction(`${ACTIVE_TAB_INDEX} === 0`, { polling: 100 });
  await page.waitForFunction(CHAT_COMPOSER_LIVE, { polling: 100 });
  await settled(page, `document.querySelectorAll('#chat *').length`);

  const rootPane = await paneHolds(page, actorMarker);

  await shoot(page, 'stamp-root-pane');

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
}

/** The staging origin, when the comprehensive run is asked for by name. */
const stagingOrigin = process.env.KINU_E2E_ORIGIN;

async function run(): Promise<void> {
  const progress = (row: string): void => { process.stderr.write(`live-app-tier: ${row}\n`); };

  const rows = async (newPage: LiveApp['newPage'], origin: string): Promise<void> => {
    progress('panel start');
    observed.panel = await measurePanel(newPage, origin);
    progress('panel done');
    observed.planTabs = await measurePlanTabs(newPage, origin);
    progress('plan-tabs done');
    observed.geometry = await measureGeometry(newPage, origin);
    progress('geometry done');
    observed.controls = await measureControls(newPage, origin);
    progress('controls done');
    observed.stamped = await measureStampedCard(newPage, origin);
    progress('stamped done');
  };

  if (stagingOrigin === undefined) {
    // Pre-publish: boot the product locally, configure the fake model, run.
    const fake = await startFakeModel();

    await withLiveApp(async ({ newPage, origin }) => {
      await apiJson(origin, '/api/user/credentials/openai-compat.default', {
        method: 'POST',
        body: JSON.stringify({ kind: 'openai-compat', baseURL: `http://127.0.0.1:${String(fake.port)}`, apiKey: 'fake-key' }),
      });

      await rows(newPage, origin);
    }, { env: liveAppEnv() });

    await stopFakeModel(fake);

    return;
  }

  // Comprehensive: same rows against the named deployment. The dev identity
  // there is the deployment's; the rows are the same code.
  await withLiveApp(async ({ newPage, browser }) => {
    const page = await newPage();

    await page.goto(stagingOrigin, { waitUntil: 'load' });
    await rows(newPage, stagingOrigin);
    await page.close();
    await browser.close();
  }, { env: liveAppEnv() });
}

beforeAll(async () => {
  try {
    await run();
  } catch (cause) {
    observed.bootFailure = renderThrownChain({ cause });
  }

  // Every measured number into the run's own log, the ones no assertion reads
  // included: a red is read with its figures, and a green prints what it saw.
  process.stderr.write(`live-app-tier verdicts: ${JSON.stringify(observed, null, 2)}\n`);
});

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

/** A row's verdict, or the failure that it never produced one: an `?? 0`
 *  fallback inside an assertion turns a row that never ran into a green one. */
function verdictOf<Value>(value: Value | null, row: string): Value {
  if (value === null) throw new Error(`the ${row} row produced no verdict`);

  return value;
}

describe('the right panel keeps its Work, Files and Env state when the chat tab changes', () => {
  test('the Work surface DOM node identity and scroll position survive', () => {
    const panel = verdictOf(observed.panel, 'panel');

    expect(panel.nodeSurvives).toBe(true);
    expect(panel.scrollSurvives).toBe(true);
  });

  test('no refetch of the workspace-scoped reads occurs on either switch', () => {
    const panel = verdictOf(observed.panel, 'panel');

    expect(panel.workspaceReadsOnSwitch).toBe(0);
    expect(panel.workspaceReadsOnBack).toBe(0);
  });

  test("the '+' tab's own actor socket answered its pane", () => {
    expect(verdictOf(observed.panel, 'panel').agentSocketFrames).toBeGreaterThan(0);
  });
});

describe('plans have one owner in the inspector column', () => {
  test('no second plan-bearing tab or filter stands beside the first', () => {
    expect(verdictOf(observed.planTabs, 'plan-tabs').planBearing.length).toBeLessThanOrEqual(1);
  });
});

describe("the tab strip's rule is continuous and the active underline sits on it", () => {
  test('dark: one rule, reaching the column edge, the underline on it', () => {
    const dark = verdictOf(observed.geometry, 'geometry').dark;

    expect(dark.mode).toBe('dark');
    expect(dark.ruleBottom).toBe(dark.stripBottom);
    expect(Math.abs(dark.ruleRight - dark.panelRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(dark.activeBottom - dark.ruleBottom)).toBeLessThanOrEqual(1);
  });

  test('light: one rule, reaching the column edge, the underline on it', () => {
    const light = verdictOf(observed.geometry, 'geometry').light;

    expect(light.mode).toBe('light');
    expect(light.ruleBottom).toBe(light.stripBottom);
    expect(Math.abs(light.ruleRight - light.panelRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(light.activeBottom - light.ruleBottom)).toBeLessThanOrEqual(1);
  });

  test('the chat and inspector rules are one line across the two columns', () => {
    const geometry = verdictOf(observed.geometry, 'geometry');

    expect(Math.abs(geometry.dark.chatRuleBottom - geometry.dark.ruleBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.light.chatRuleBottom - geometry.light.ruleBottom)).toBeLessThanOrEqual(1);
  });
});

describe('a collapsed right panel can be reopened and the left rail can be collapsed', () => {
  test("the column's own control shuts it", () => {
    const controls = verdictOf(observed.controls, 'controls');

    expect(controls.inspectorWidthOpened).toBeGreaterThan(INSPECTOR_SHUT_PX);
    expect(controls.inspectorWidthShut).toBeLessThanOrEqual(INSPECTOR_SHUT_PX);
  });

  test('a control reopens the column the reader collapsed', () => {
    expect(verdictOf(observed.controls, 'controls').inspectorWidthReopened).toBeGreaterThan(INSPECTOR_SHUT_PX);
  });

  test('a control collapses the left rail', () => {
    const lane = verdictOf(observed.controls, 'controls').railLaneAfter;

    expect(lane).toBeGreaterThanOrEqual(0);
    expect(lane).toBeLessThanOrEqual(RAIL_SHUT_PX);
  });
});

describe("a pane renders its own transcript and no other actor's", () => {
  test("the root's own turn stays out of a new actor's pane", () => {
    expect(verdictOf(observed.stamped, 'stamped').rootMarkerInActorPane).toBe(0);
  });

  test("words sent on the actor's tab stay out of the root transcript", () => {
    expect(verdictOf(observed.stamped, 'stamped').actorMarkerInRootPane).toBe(0);
  });
});
