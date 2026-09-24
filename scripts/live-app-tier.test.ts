/**
 * The live-app e2e suite: the real product in a real browser, before publish.
 *
 * The suite boots the local dev server itself (vite dev = real Worker in
 * workerd, real Durable Objects, real client) through live-app-harness, plus a
 * local scripted model the workspaces are configured to use, so the visual rows
 * have live content to render. The rows a deployment must also pass are the
 * product flows (`scripts/product-flows.ts`), which run against both origins.
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
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedActorSocketPath } from '@kinu.run/core';
import { renderThrownChain, tolerate } from '@kinu.run/core/obs';
import { SCRATCH_ROOT_PREFIX } from '../packages/test-utils/src/scratch';

import { DESKTOP, withLiveApp, createWorkspace, listWorkspaces, type LiveApp } from './live-app-harness';
import {
  CHAT_COMPOSER_LIVE, INSPECTOR_SHUT_PX, INSPECTOR_WIDTH, NEW_AGENT, OPEN_NAMES, RECORD_DEAD_ENDS,
  openInspector, painted, pressUntil, settled, typeIntoComposer, until,
  type ControlAttempt,
} from './product-flows';
import { rowVerdicts } from './row-verdicts';
import {
  FALLBACK_ANSWER, KEPT_TAB_FORGET, KEPT_TAB_NOTE, PACED_FIRST_TURN_MISSION, PACED_SILENCE_MS, PACED_TURN_ANSWER,
  PACED_TURN_ASK, SCRIPTED_MODEL_SPEC, SLATE_TITLE,
  heldCall, keptTabProbe, pacedFirstTurn, pacedTurn, planWalkthrough, registerScriptedModel, startScriptedModel,
  type HeldCall,
} from './scripted-model';
import { drivePlanReview, type WalkthroughVerdict } from './plan-demo-film';

/** Screenshots land beside the other lanes' evidence, outside the worktree. */
const SHOTS = join(import.meta.dir, '..', '..', 'kinu-logs', 'wave2-0917', 'browser');

mkdirSync(SHOTS, { recursive: true });

async function shoot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });

  return path;
}

/** This run's own workspace suffix, and the mark the state row reads a roster
 *  by. A deployment keeps its Durable Objects between runs, so a fixed name
 *  would have each comprehensive row reading the previous run's transcript,
 *  cards and journal as if they were the product's first state (measured
 *  2026-09-17 on the local server, back when it inherited the checkout's
 *  state too: two runs put both runs' sent messages in one root transcript). */
const RUN_ID = crypto.randomUUID().slice(0, 8);

async function openWorkspace(newPage: LiveApp['newPage'], origin: string, workspace: string): Promise<Page> {
  const page = await newPage();

  await page.setViewport(DESKTOP);
  await page.evaluateOnNewDocument(RECORD_DEAD_ENDS);

  // 'load', not 'networkidle0': the app holds its event socket open from
  // first paint, so there is never a zero-connection window to wait for.
  await page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' });
  await until(page, 'the workspace page', `document.querySelector('textarea') !== null`);

  return page;
}

/** Click the control; an absent control throws, and that is the finding. */
const ClickScripts = {
  lastAgentTab: `(() => {
    // Tabs by their own hook, not by element: the OPEN tab is a div (it hosts
    // the rename editor), so counting links saw one fewer tab than exists and
    // this row's wait never finished.
    const tabs = [...document.querySelectorAll('nav[aria-label="Workspace agents"] [data-agent-tab]')];
    const target = tabs.pop();
    if (target === undefined) throw new Error('no agent tab to open');
    (target.querySelector('a') ?? target).click();
  })()`,
  mainTab: `(() => {
    const first = [...document.querySelectorAll('nav[aria-label="Workspace agents"] [data-agent-tab]')][0];
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

/** Workspace-scoped reads the right panel owns; Agent and Activity are per
 *  agent. `getEvolutionChangelog` belongs here by ownership even though
 *  `rpc-gate` classifies it `interactive` rather than `workspace.read` — that
 *  axis is authorization, and the Journal it feeds is the workspace's. */
const WORKSPACE_READS = [
  'getWorkspaceSnapshot', 'getExposedPorts', 'listPendingActions', 'getMemoryContent',
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

/** What the chat column drew while the paced turn ran, read every 20 ms. */
interface LiveIndicatorVerdict {
  /** How long Stop was offered, first sample to last. */
  readonly runningMs: number;
  /** Samples under Stop that drew no live state: a pane saying a turn runs and showing nothing of it. */
  readonly blank: number;
  /** The longest unbroken blank stretch, in ms. */
  readonly longestBlankMs: number;
  /** Samples under Stop that drew more than one live state. */
  readonly doubled: number;
}

/** What a page opened during a turn drew once that turn had ended (#29): every new workspace's page opens on its
 *  first turn. */
interface OpenedMidTurnVerdict {
  /** The last sample before the turn's held model call was let go: what the page drew while the turn ran. */
  readonly held: { readonly stop: boolean; readonly task: string | null };
  /** The last sample, taken at the page's first presence read after the turn's close was answered. */
  readonly stop: boolean;
  readonly states: number;
  /** Samples that read no word from the header's task state. */
  readonly headerless: number;
  /** Samples where the header and the composer disagreed on whether a turn runs: Stop beside an idle header, or a
   *  working header with no Stop. The header's other words (waiting on you, on a provider) outrank both. */
  readonly disagreed: number;
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

/** Where this run's dev server kept its Durable Objects, and what stood there.
 *  The harness mints a scratch directory per boot; before that the Cloudflare
 *  plugin persisted into the checkout's `packages/cf-backend/.wrangler/state`,
 *  one directory per checkout shared by every run on the box. That is how the
 *  deploy wave at 18fbea162 met a `user_workspaces` table written before
 *  `delete_pending` existed and answered 500 to the first credential this
 *  suite wrote, while the same file was green from a fresh worktree. */
interface StateVerdict {
  /** The directory the dev server persisted into. */
  readonly root: string;
  /** The Durable Object namespaces under it, from the plugin's `v3/do` tree. */
  readonly namespaces: readonly string[];
  /** Workspaces on the LOCAL server's roster that this run did not create. A
   *  state directory that held anything before the boot names it here. */
  readonly foreign: readonly string[];
}

/** The kept-tab row: every tab the inspector marked, in order, from its first
 *  resolved tab to the end, and what the product read of the Work tab. */
interface KeptTabVerdict {
  /** The marked tab's label at each change, the first entry being the tab the
   *  panel resolved to. The reader's one click is the only change it asks for. */
  readonly marks: readonly string[];
  /** Every Work presence the page's socket read, in order: filled after the
   *  note turn and empty after the forget turn, or the row ends naming which. */
  readonly workPresence: readonly boolean[];
}

interface TierVerdicts {
  bootFailure: string | null;
  liveIndicator: LiveIndicatorVerdict | null;
  openedMidTurn: OpenedMidTurnVerdict | null;
  panel: PanelVerdict | null;
  planTabs: PlanTabsVerdict | null;
  geometry: GeometryVerdict | null;
  controls: ControlsVerdict | null;
  stamped: StampedCardVerdict | null;
  walkthrough: WalkthroughVerdict | null;
  keptTab: KeptTabVerdict | null;
  state: StateVerdict | null;
}

const StripGeometrySchema = v.object({
  ruleBottom: v.number(), stripBottom: v.number(),
  ruleRight: v.number(), panelRight: v.number(),
  chatRuleBottom: v.number(), activeBottom: v.number(), mode: v.string(),
});

const observed: TierVerdicts = {
  liveIndicator: null, openedMidTurn: null,
  bootFailure: null, panel: null, planTabs: null, geometry: null,
  controls: null, stamped: null, walkthrough: null, keptTab: null, state: null,
};

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

/** Which tab of the agent strip is current, by index: 0 is Main, the
 *  subordinates follow in roster order, -1 while none is marked. */
const ACTIVE_TAB_INDEX = `(() => {
  const tabs = [...document.querySelectorAll('nav[aria-label="Workspace agents"] [data-agent-tab]')];
  // The mark sits ON the Main link and INSIDE an open agent tab (whose own
  // element is the rename host), so both shapes answer here.
  return tabs.findIndex((tab) => tab.matches('[aria-current="page"]') || tab.querySelector('[aria-current="page"]') !== null);
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

/** A collapsed rail: an icon strip at most. Its open lane is 240px (`w-60`). */
const RAIL_SHUT_PX = 64;

const SHUT_NAMES = 'hide|collapse|close';

/** The header's task state, by the name its status carries; its text is the state's word. */
const TASK_STATE = '[role="status"][aria-label="Task state"]';

/** Every 20 ms from install: whether the chat column offers Stop, how many live states it draws, and the header's
 *  task word. A Thinking row, a live reasoning label, a caret on text that shows, and running call rows (one state
 *  however many run) are live states; a hook on an element that draws nothing is none. Held on `window` until read
 *  back. On the page's own clock: the defect is what the pane draws through a real silence on the model's socket,
 *  which no fake clock reaches. */
const INSTALL_LIVE_SAMPLER = `(() => {
  const samples = [];
  const started = performance.now();
  const shown = (el) => el.getClientRects().length > 0;
  window.__liveSamples = samples;
  window.__liveSampler = setInterval(() => {
    const chat = document.querySelector('#chat');
    if (chat === null) return;
    const drawn = (kind) => [...chat.querySelectorAll('[data-live-indicator="' + kind + '"]')].filter(shown);
    const carets = drawn('text').filter((el) => el.innerText.trim() !== '').length;
    const running = [...chat.querySelectorAll('[data-tool-state="running"]')].some(shown) ? 1 : 0;
    samples.push({
      t: Math.round(performance.now() - started),
      stop: [...chat.querySelectorAll('button[aria-label="Stop this turn"]')].some(shown),
      states: drawn('thinking').length + drawn('reasoning').length + carets + running,
      task: document.querySelector(${JSON.stringify(TASK_STATE)})?.textContent?.trim() ?? null,
    });
  }, 20);
})()`;

const READ_LIVE_SAMPLES = `(() => { clearInterval(window.__liveSampler); return window.__liveSamples; })()`;

/** The newest sample, the sampler left running. */
const LAST_LIVE_SAMPLE = 'window.__liveSamples.at(-1) ?? null';

const LiveSampleSchema = v.object({ t: v.number(), stop: v.boolean(), states: v.number(), task: v.nullable(v.string()) });

const STOP_OFFERED = `document.querySelector('#chat button[aria-label="Stop this turn"]') !== null`;

/** The workspace's own first turn, queued by its create, has answered and ended: words sent before would be
 *  steered into it instead of opening a turn of their own. */
const FIRST_TURN_ENDED = `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(FALLBACK_ANSWER)}) && !(${STOP_OFFERED})`;

const PACED_ANSWER_SHOWN = `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(PACED_TURN_ANSWER)}) && !(${STOP_OFFERED})`;

/** The chat column's last words, for a row that has to say what the page showed instead. */
const CHAT_TAIL = `(document.querySelector('#chat')?.textContent ?? '').slice(-240)`;

/** Row 0: a running turn draws exactly one live state, through the silences a thinking model leaves in its
 *  stream (`pacedTurn`). */
async function measureLiveIndicator(newPage: LiveApp['newPage'], origin: string): Promise<LiveIndicatorVerdict> {
  const workspace = await createWorkspace(
    origin, { name: `live-row-indicator-${RUN_ID}`, purpose: 'live indicator probe', model: SCRIPTED_MODEL_SPEC });

  const page = await openWorkspace(newPage, origin, workspace);
  const turns = await watchTurns(page);
  let samples: v.InferOutput<typeof LiveSampleSchema>[];

  try {
    await until(page, "the workspace's first turn to end", FIRST_TURN_ENDED);
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await page.evaluate(INSTALL_LIVE_SAMPLER);

    const paced = turns.afterTurn();

    await sendInChat(page, PACED_TURN_ASK);
    await paced;
    // The turn has closed on the socket; the pane ends it once its stream does.
    await until(page, 'the pane to end the paced turn', `!(${STOP_OFFERED})`);

    if (!v.parse(v.boolean(), await page.evaluate(PACED_ANSWER_SHOWN))) {
      throw new Error(`waiting for the paced answer, its turn closed without it; the chat ends ${JSON.stringify(await page.evaluate(CHAT_TAIL))}`);
    }

    samples = v.parse(v.array(LiveSampleSchema), await page.evaluate(READ_LIVE_SAMPLES));
    await shoot(page, 'live-indicator-settled');
  } finally {
    await turns.stop();
    await page.close();
  }

  const running = samples.filter((sample) => sample.stop);
  let longestBlankMs = 0;
  let blankSince: number | null = null;

  for (const sample of samples) {
    blankSince = sample.stop && sample.states === 0 ? (blankSince ?? sample.t) : null;
    longestBlankMs = Math.max(longestBlankMs, blankSince === null ? 0 : sample.t - blankSince);
  }

  return {
    runningMs: (running.at(-1)?.t ?? 0) - (running[0]?.t ?? 0),
    blank: running.filter((sample) => sample.states === 0).length,
    longestBlankMs,
    doubled: running.filter((sample) => sample.states > 1).length,
  };
}

/** Row 1 (B6): the right panel keeps its Work, Files and Env state across a
 *  chat-tab switch — the same DOM node, the same scroll offset, and no
 *  workspace-scoped read re-sent in either direction. */
async function measurePanel(newPage: LiveApp['newPage'], origin: string): Promise<PanelVerdict> {
  const workspace = await createWorkspace(
    origin, { name: `live-row-panel-${RUN_ID}`, purpose: 'panel state probe', model: SCRIPTED_MODEL_SPEC });

  const page = await openWorkspace(newPage, origin, workspace);

  await page.evaluate(NEW_AGENT);
  await until(page, 'an agent tab after Main, current', `${ACTIVE_TAB_INDEX} > 0`);
  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
  await page.evaluate(ClickScripts.mainTab);
  await until(page, "Main's tab, current", `${ACTIVE_TAB_INDEX} === 0`);
  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);

  await openInspector(page);

  const counter = await countRpc(page);

  await page.evaluate(ClickScripts.filesTab);
  await until(page, 'the Files tab, active',
    `[...document.querySelectorAll('.p-tabstrip')].flatMap(el => [...el.querySelectorAll('button')]).some(b => b.textContent.trim() === 'Files' && b.className.includes('p-tab-active'))`);

  const marked = v.parse(
    v.object({ ok: v.literal(true), scrollTop: v.number() }),
    await page.evaluate(() => {
      const strip = document.querySelector('#inspector .p-tabstrip');
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
}

/** Row 2 (B12): plans have one owner in the inspector column. The duplicate
 *  B12 names is a `Plans` tab in the strip beside the Journal's own `Plan`
 *  filter below it, so the count spans the whole column — its tab strip and
 *  its filter chips — and the strip's labels are reported beside it. */
async function measurePlanTabs(newPage: LiveApp['newPage'], origin: string): Promise<PlanTabsVerdict> {
  const workspace = await createWorkspace(
    origin, { name: `live-row-plan-${RUN_ID}`, purpose: 'plan probe', model: SCRIPTED_MODEL_SPEC });

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
  const strip = document.querySelector('#inspector .p-tabstrip');
  if (strip === null) throw new Error('no inspector tab strip');
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
  const workspace = await createWorkspace(
    origin, { name: `live-row-geometry-${RUN_ID}`, purpose: 'geometry probe', model: SCRIPTED_MODEL_SPEC });

  const page = await openWorkspace(newPage, origin, workspace);

  await openInspector(page);
  await until(page, 'a marked tab in the inspector strip', `${MARKED_TAB} !== null`);

  const dark = v.parse(StripGeometrySchema, await page.evaluate(readStripGeometry));

  await shoot(page, 'b5-strip-dark');
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.reload({ waitUntil: 'load' });
  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
  await openInspector(page);
  await until(page, 'a marked tab in the inspector strip', `${MARKED_TAB} !== null`);

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
  const workspace = await createWorkspace(
    origin, { name: `live-row-controls-${RUN_ID}`, purpose: 'collapse controls probe', model: SCRIPTED_MODEL_SPEC });

  const page = await openWorkspace(newPage, origin, workspace);

  const before = v.parse(LayoutProbeSchema, await page.evaluate(probeLayoutScript));

  // Opened first, from whatever state the product chose: a fresh workspace
  // holds nothing worth showing, so the column arrives shut.
  const opened = await pressUntil(page, {
    names: OPEN_NAMES, read: INSPECTOR_WIDTH, reached: (width) => width > INSPECTOR_SHUT_PX,
  });

  await shoot(page, 'b8-opened');

  // Shut it with the reader's own control, so the reopen below faces the
  // defect's own situation: a panel the reader collapsed. The control is NOT
  // inside the column any more — the owner asked for a panel button in the
  // tab strip instead of a handle on the column's edge (2026-09-18), so this
  // probe presses it wherever it is, and only the effect is pinned.
  const shut = await pressUntil(page, {
    names: SHUT_NAMES, read: INSPECTOR_WIDTH, outside: '#inspector',
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

/** Row 5: each pane renders its own transcript and no other actor's. Driven
 *  through the real flow — a turn on Main, the '+' tab, a turn on the actor —
 *  and measured in both directions with one marker per side. */
async function measureStampedCard(newPage: LiveApp['newPage'], origin: string): Promise<StampedCardVerdict> {
  const workspace = await createWorkspace(
    origin, { name: `live-row-stamp-${RUN_ID}`, purpose: 'stamped card probe', model: SCRIPTED_MODEL_SPEC });

  const page = await openWorkspace(newPage, origin, workspace);
  const counter = await countRpc(page);

  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);

  // The root gets a turn of its own first, so the actor's pane below has
  // something it could leak: a transcript with words in it. Without this the
  // actor-side direction of the row could not go red at all.
  const rootMarker = `root opening ${crypto.randomUUID().slice(0, 8)}`;

  await sendInChat(page, rootMarker);
  await until(page, "the root turn's answer", `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(FALLBACK_ANSWER)})`);
  await shoot(page, 'stamp-root-before');

  await page.evaluate(NEW_AGENT);
  await until(page, 'a second agent tab',
    `[...document.querySelectorAll('nav[aria-label="Workspace agents"] [data-agent-tab]')].length > 1`);
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
    `[...document.querySelectorAll('#chat [data-system-event] *, #chat .divide-dashed *')]`
    + `.some(el => (el.textContent ?? '').includes(${JSON.stringify(actorMarker)}))`
    + ` || (document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(FALLBACK_ANSWER)})`);

  await shoot(page, 'stamp-actor-pane');

  await page.evaluate(ClickScripts.mainTab);
  await until(page, "Main's tab, current", `${ACTIVE_TAB_INDEX} === 0`);
  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
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

/** Row 6: the plan review flow end to end, on the product, over the same
 *  script the README's film is cut from. The drive lives in the recorder
 *  (`drivePlanReview`) so the film and this row cannot tell different stories:
 *  the recorder is that drive plus a camera. */
async function measureWalkthrough(newPage: LiveApp['newPage'], origin: string): Promise<WalkthroughVerdict> {
  const workspace = await createWorkspace(
    origin,
    { name: `live-row-plan-flow-${RUN_ID}`, purpose: 'plan review walkthrough', model: SCRIPTED_MODEL_SPEC });

  const page = await newPage();

  const verdict = await drivePlanReview(page, origin, workspace, async () => {});
  await shoot(page, 'walkthrough-settled');
  await page.close();

  return verdict;
}

/** The label of the inspector tab marked current, or null while none is. */
const MARKED_TAB = `(document.querySelector('#inspector .p-tabstrip [aria-current="true"]')?.getAttribute('aria-label') ?? null)`;

/** Record every change of the marked inspector tab from now on. */
const RECORD_MARKS = `(() => {
  const marks = [${MARKED_TAB}];
  window.__keptTabMarks = marks;
  new MutationObserver(() => {
    const now = ${MARKED_TAB};
    if (now !== marks[marks.length - 1]) marks.push(now);
  }).observe(document.querySelector('#inspector') ?? document.body, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current'],
  });
})()`;

const RpcAskSchema = v.looseObject({ id: v.string(), method: v.string() });

const RpcAnswerSchema = v.looseObject({ id: v.string(), result: v.optional(v.unknown()) });

/** The reads whose answers carry Work's presence. */
const PRESENCE_READS = new Set(['getWorkspaceTabPresence', 'getWorkspaceSnapshot']);

/** Work's presence out of either answer that carries it. */
const PresenceAnswerSchema = v.union([
  v.pipe(v.looseObject({ work: v.boolean() }), v.transform((answer) => answer.work)),
  v.pipe(v.looseObject({ tabPresence: v.looseObject({ work: v.boolean() }) }), v.transform((answer) => answer.tabPresence.work)),
]);

/** The chat request a send puts on the socket; its id names the turn's frames. */
const ChatRequestSchema = v.looseObject({ type: v.literal('cf_agent_use_chat_request'), id: v.string() });

/** A turn's frame on the workspace socket, which every page on it gets, under the id of the request that opened
 *  it. The request's `done` frame closes the turn, unless it says the words landed in a turn already running
 *  (`landed: 'mid-turn'`); an `error` frame is the turn failing (chat-transport.ts `doneFrame`). */
const ChatResponseSchema = v.looseObject({
  type: v.literal('cf_agent_use_chat_response'),
  id: v.string(),
  done: v.optional(v.boolean()),
  error: v.optional(v.boolean()),
  landed: v.optional(v.string()),
  body: v.optional(v.string()),
});

/** A page's turns off its own socket, and the Work presence it reads. `afterTurn`,
 *  taken before a send, follows the chat request that send puts on the socket:
 *  it settles on the answer to the first presence read the page asks once that
 *  request's turn has closed, and rejects when the turn fails or the words land
 *  in a turn already running. Only that request's frames count: the socket also
 *  carries every other request's, a resent or a probing one included. The page
 *  asks that read from the effect that follows the turn's last render and every
 *  5 s after (use-kinu `refreshLiveData`), so it comes whatever the turn did,
 *  after the page drew it, and it is final for that turn: a row waits on it,
 *  never on the value it hopes for. */
interface TurnWatch {
  /** Every Work presence the page was answered, in order. */
  workPresence(): readonly boolean[];
  afterTurn(): Promise<boolean>;
  stop(): Promise<void>;
}

interface TurnWaiter {
  /** The chat request this waiter follows, once the page has sent one. */
  requestId: string | null;
  /** How many presence reads the page had asked when the turn closed; null while it runs. */
  closedAtAsk: number | null;
  readonly settle: ReturnType<typeof Promise.withResolvers<boolean>>;
}

async function watchTurns(page: Page): Promise<TurnWatch> {
  const cdp = await page.createCDPSession();

  await cdp.send('Network.enable');

  // Each presence read the page asked, by id, with its place among the reads asked.
  const asked = new Map<string, number>();
  const answers: boolean[] = [];
  let asks = 0;
  let waiters: TurnWaiter[] = [];

  cdp.on('Network.webSocketFrameSent', (event: { response?: { payloadData?: string } }) => {
    const frame = tolerate<unknown>(() => JSON.parse(event.response?.payloadData ?? ''), 'malformed-input');
    const request = v.safeParse(ChatRequestSchema, frame);
    const unsent = waiters.find((waiter) => waiter.requestId === null);

    if (request.success && unsent !== undefined) unsent.requestId = request.output.id;

    const ask = v.safeParse(RpcAskSchema, frame);

    if (ask.success && PRESENCE_READS.has(ask.output.method)) {
      asked.set(ask.output.id, asks);
      asks += 1;
    }
  });
  cdp.on('Network.webSocketFrameReceived', (event: { response?: { payloadData?: string } }) => {
    const frame = tolerate<unknown>(() => JSON.parse(event.response?.payloadData ?? ''), 'malformed-input');
    const turn = v.safeParse(ChatResponseSchema, frame);

    if (turn.success) {
      const waiter = waiters.find((candidate) => candidate.requestId === turn.output.id);

      if (waiter === undefined) return;

      if (turn.output.error === true) {
        waiters = waiters.filter((candidate) => candidate !== waiter);
        waiter.settle.reject(new Error(`the turn failed: ${turn.output.body ?? ''}`));
      } else if (turn.output.done === true && turn.output.landed === 'mid-turn') {
        waiters = waiters.filter((candidate) => candidate !== waiter);
        waiter.settle.reject(new Error('the words landed in a turn already running, so no turn of their own closed'));
      } else if (turn.output.done === true) {
        waiter.closedAtAsk = asks;
      }

      return;
    }

    const answer = v.safeParse(RpcAnswerSchema, frame);
    const place = answer.success ? asked.get(answer.output.id) : undefined;

    if (!answer.success || place === undefined) return;
    asked.delete(answer.output.id);
    const presence = v.safeParse(PresenceAnswerSchema, answer.output.result);

    if (!presence.success) return;
    answers.push(presence.output);
    waiters = waiters.filter((waiter) => {
      if (waiter.closedAtAsk === null || place < waiter.closedAtAsk) return true;
      waiter.settle.resolve(presence.output);

      return false;
    });
  });

  return {
    workPresence: () => [...answers],
    afterTurn: () => {
      const settle = Promise.withResolvers<boolean>();

      waiters.push({ requestId: null, closedAtAsk: null, settle });

      return settle.promise;
    },
    stop: async () => { await cdp.detach(); },
  };
}

/** Counts, on `window`, every presence read the page asks from install on: the page's own refresh cadence. */
const COUNT_PRESENCE_ASKS = `(() => {
  const asks = new RegExp('"method":"(${[...PRESENCE_READS].join('|')})"');
  const send = WebSocket.prototype.send;
  window.__presenceAsks = 0;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string' && asks.test(data)) window.__presenceAsks += 1;
    return send.call(this, data);
  };
})()`;

/** The header and the composer disagree: one says a turn runs and the other says nothing does. */
const disagrees = (sample: v.InferOutput<typeof LiveSampleSchema>): boolean =>
  (sample.stop && sample.task === 'idle') || (!sample.stop && sample.task === 'working');

/** Row 9 (#29): a new workspace's page opens on its first turn, so it loads a claim that is admitted. The turn is
 *  held at its model (`pacedFirstTurn`) while the page loads again and reads its state, and the page must say it
 *  runs; then it answers. Once the turn has closed and the page has asked for its live data again, nothing on that
 *  page may still say a turn runs, and at no sample may the header and the composer say different things. */
async function measureOpenedMidTurn(
  newPage: LiveApp['newPage'], origin: string, firstTurn: HeldCall,
): Promise<OpenedMidTurnVerdict> {
  const workspace = await createWorkspace(
    origin, { name: `live-row-mid-turn-${RUN_ID}`, purpose: PACED_FIRST_TURN_MISSION, model: SCRIPTED_MODEL_SPEC });

  const page = await newPage();
  const turns = await watchTurns(page);

  try {
    await page.setViewport(DESKTOP);
    await page.evaluateOnNewDocument(RECORD_DEAD_ENDS);
    await page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' });
    await until(page, 'the workspace page', `document.querySelector('textarea') !== null`);

    // Settles on the first turn's close; a turn that closes before its model call has nothing to hold.
    const closed = turns.afterTurn();
    const beforeModel = closed.then(() => 'closed' as const, () => 'failed' as const);
    const outcome = await Promise.race([firstTurn.arrived.then(() => 'held' as const), beforeModel]);

    // A failed turn rethrows its own failure.
    if (outcome === 'failed') await closed;

    if (outcome !== 'held') throw new Error("the workspace's first turn closed before it reached its model");

    // Loaded again now that the turn is admitted and waiting on its model: the page a new workspace opens on.
    await page.reload({ waitUntil: 'load' });
    await until(page, 'the workspace page, reloaded', `document.querySelector('textarea') !== null`);
    await until(page, "the header's task state", `document.querySelector(${JSON.stringify(TASK_STATE)}) !== null`);
    await page.evaluate(INSTALL_LIVE_SAMPLER);
    await page.evaluate(COUNT_PRESENCE_ASKS);
    await until(page, "the reloaded page's first presence read", 'window.__presenceAsks > 0');
    await painted(page);

    const held = v.parse(v.nullable(LiveSampleSchema), await page.evaluate(LAST_LIVE_SAMPLE));

    firstTurn.release();
    await closed;

    const asked = v.parse(v.number(), await page.evaluate('window.__presenceAsks'));

    await until(page, "the page's next presence read after the turn closed", `window.__presenceAsks > ${String(asked)}`);
    await painted(page);

    const samples = v.parse(v.array(LiveSampleSchema), await page.evaluate(READ_LIVE_SAMPLES));
    const last = samples.at(-1);

    await shoot(page, 'opened-mid-turn-ended');

    if (held === null || last === undefined) throw new Error('the chat column was never sampled');

    return {
      held: { stop: held.stop, task: held.task }, stop: last.stop, states: last.states,
      headerless: samples.filter((sample) => sample.task === null).length,
      disagreed: samples.filter(disagrees).length,
    };
  } finally {
    firstTurn.release();
    await turns.stop();
    await page.close();
  }
}

/** The inspector strip's Work tab. */
const WORK_TAB = `document.querySelector('#inspector .p-tabstrip [aria-label="Work"]')`;

/** Row 8: the inspector never moves its selection on its own. In a new
 *  workspace the panel resolves to its first tab; the first turn saves a note,
 *  which gives Work content; the reader opens Work; the next turn forgets the
 *  note, which empties Work under the reader. A third turn is the fence: it
 *  closes after the page has taken in the emptied read, so a move the panel
 *  made on that read is in the record by then. A turn that did not fill or
 *  empty Work ends the row there, naming the read the page made after it. */
async function measureKeptTab(newPage: LiveApp['newPage'], origin: string): Promise<KeptTabVerdict> {
  const workspace = await createWorkspace(
    origin, { name: `live-row-kept-tab-${RUN_ID}`, purpose: 'kept tab probe', model: SCRIPTED_MODEL_SPEC });

  const page = await openWorkspace(newPage, origin, workspace);
  const turns = await watchTurns(page);

  try {
    await until(page, "the workspace's first turn to end", FIRST_TURN_ENDED);
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await openInspector(page);
    await until(page, 'a marked tab in the inspector strip', `${MARKED_TAB} !== null`);
    await page.evaluate(RECORD_MARKS);

    const noted = turns.afterTurn();

    await sendInChat(page, KEPT_TAB_NOTE);

    if (!(await noted)) {
      throw new Error(`waiting for the note turn to fill Work, the page read Work empty once the turn closed; `
        + `the chat ends ${JSON.stringify(await page.evaluate(CHAT_TAIL))}`);
    }

    await until(page, 'the Work tab in the inspector strip', `${WORK_TAB} !== null`);
    await page.evaluate(`${WORK_TAB}.click()`);
    await until(page, 'Work marked current', `${MARKED_TAB} === 'Work'`);

    const forgotten = turns.afterTurn();

    await sendInChat(page, KEPT_TAB_FORGET);

    if (await forgotten) {
      throw new Error(`waiting for the forget turn to empty Work, the page read Work filled once the turn closed; `
        + `the chat ends ${JSON.stringify(await page.evaluate(CHAT_TAIL))}`);
    }

    const fenced = turns.afterTurn();

    await sendInChat(page, 'Kept-tab probe: the fence.');
    await fenced;

    const marks = v.parse(v.array(v.nullable(v.string())), await page.evaluate('window.__keptTabMarks'));

    return { marks: marks.map((mark) => mark ?? '(none)'), workPresence: turns.workPresence() };
  } finally {
    await turns.stop();
    await page.close();
  }
}

/** Row 7: the run's own state directory, measured on the LOCAL server in both
 *  modes — the question is what the harness booted on, not what a deployment
 *  holds. The roster read goes through UserDO, so its namespace directory is
 *  written by the time the plugin's tree below is listed. */
async function measureState(app: LiveApp): Promise<StateVerdict> {
  const foreign = (await listWorkspaces(app.origin)).filter((name) => !name.includes(RUN_ID));
  const tree = join(app.statePath, 'v3', 'do');

  return {
    root: app.statePath,
    namespaces: existsSync(tree) ? readdirSync(tree).sort() : [],
    foreign,
  };
}

const { attempt, verdictOf, broken } = rowVerdicts('live-app-tier', () => observed.bootFailure);

async function run(): Promise<void> {
  // The script answers the live-indicator row's paced turn, the paced first
  // turn of the mid-turn row, the kept-tab row's two asks, every row's
  // throwaway turn with prose and the walkthrough's turns with the plan and
  // the slate — one server, decided per request.
  const firstTurn = heldCall();

  const model = await startScriptedModel((request) => pacedTurn(request) ?? pacedFirstTurn(request, firstTurn)
    ?? keptTabProbe(request) ?? planWalkthrough(request));

  await withLiveApp(async (app) => {
    const { newPage, origin } = app;

    await registerScriptedModel(origin, model.port);
    observed.liveIndicator = await attempt('live-indicator', () => measureLiveIndicator(newPage, origin));
    observed.openedMidTurn = await attempt('opened-mid-turn', () => measureOpenedMidTurn(newPage, origin, firstTurn));
    observed.panel = await attempt('panel', () => measurePanel(newPage, origin));
    observed.planTabs = await attempt('plan-tabs', () => measurePlanTabs(newPage, origin));
    observed.geometry = await attempt('geometry', () => measureGeometry(newPage, origin));
    observed.controls = await attempt('controls', () => measureControls(newPage, origin));
    observed.stamped = await attempt('stamped', () => measureStampedCard(newPage, origin));
    observed.walkthrough = await attempt('walkthrough', () => measureWalkthrough(newPage, origin));
    observed.keptTab = await attempt('kept-tab', () => measureKeptTab(newPage, origin));
    observed.state = await attempt('state', () => measureState(app));
  });

  await model.stop();
}

beforeAll(async () => {
  try {
    await run();
  } catch (cause) {
    observed.bootFailure = renderThrownChain({ cause });
  }

  // Every measured number into the run's own log, the ones no assertion reads
  // included: a red is read with its figures, and a green prints what it saw.
  process.stderr.write(`live-app-tier verdicts: ${JSON.stringify({ observed, broke: broken() }, null, 2)}\n`);
});

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

describe('the right panel keeps its Work, Files and Env state when the chat tab changes', () => {
  test('the Files surface DOM node identity and scroll position survive', () => {
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

describe('a running turn draws exactly one live state', () => {
  test("the pane was sampled through the paced turn's four silences", () => {
    expect(verdictOf(observed.liveIndicator, 'live-indicator').runningMs).toBeGreaterThanOrEqual(4 * PACED_SILENCE_MS);
  });

  test('Stop never stands over a pane that draws nothing happening', () => {
    expect(verdictOf(observed.liveIndicator, 'live-indicator').blank).toBe(0);
  });

  test('Thinking never stands beside a part that draws itself live', () => {
    expect(verdictOf(observed.liveIndicator, 'live-indicator').doubled).toBe(0);
  });
});

describe('a page opened during a turn stops showing it once the turn ends', () => {
  test('while the turn runs, the composer offers Stop and the header says working', () => {
    expect(verdictOf(observed.openedMidTurn, 'opened-mid-turn').held).toEqual({ stop: true, task: 'working' });
  });

  test('the composer offers no Stop and the thread draws no live state', () => {
    const ended = verdictOf(observed.openedMidTurn, 'opened-mid-turn');

    expect({ stop: ended.stop, states: ended.states }).toEqual({ stop: false, states: 0 });
  });

  test('every sample reads the header, and the header never disagrees with the composer', () => {
    const verdict = verdictOf(observed.openedMidTurn, 'opened-mid-turn');

    expect({ headerless: verdict.headerless, disagreed: verdict.disagreed }).toEqual({ headerless: 0, disagreed: 0 });
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
  test("the reader's own control shuts it", () => {
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

describe('the plan review flow end to end', () => {
  test('a plan comes back for review, with its decision reachable by role', () => {
    const flow = verdictOf(observed.walkthrough, 'walkthrough');

    expect(flow.planReviewShown).toBeTrue();
    expect(flow.approveControl).toMatch(/approve/iu);
  });

  test('the inspector opens on the plan and not before it', () => {
    const flow = verdictOf(observed.walkthrough, 'walkthrough');

    expect(flow.inspectorBeforePlan).toBeLessThanOrEqual(INSPECTOR_SHUT_PX);
    expect(flow.inspectorOnPlan).toBeGreaterThan(INSPECTOR_SHUT_PX);
  });

  test('approving records the decision and enqueues the turn that implements it', () => {
    const flow = verdictOf(observed.walkthrough, 'walkthrough');

    expect(flow.planStatus).toBe('Approved');
    expect(flow.toolCardsAfterImplement).toBeGreaterThan(flow.toolCardsBeforeApproval);
  });

  test("the slate that turn wrote stands in the strip under its own title", () => {
    expect(verdictOf(observed.walkthrough, 'walkthrough').stripLabels).toContain(SLATE_TITLE);
  });
});

describe('the inspector never moves its selection on its own', () => {
  test('a new workspace resolves to Files, and the one change after is the reader\'s click', () => {
    // The row itself ends unless the product read Work filled after the first turn and empty after the second.
    expect(verdictOf(observed.keptTab, 'kept-tab').marks).toEqual(['Files', 'Work']);
  });
});

describe('the live app boots on its own Durable Object state', () => {
  test("the dev server persisted under this run's scratch, never the checkout", () => {
    const state = verdictOf(observed.state, 'state');

    expect(state.root).toStartWith(join(tmpdir(), SCRATCH_ROOT_PREFIX));
    // The plugin's own tree there, not just a directory the harness named:
    // UserDO is the namespace every row's roster and credential goes through.
    expect(state.namespaces).toContain('kinu-UserDO');
  });

  test('nothing but this run stood in that state', () => {
    expect(verdictOf(observed.state, 'state').foreign).toEqual([]);
  });
});
