/**
 * Real Worker, client and browser; scripted model. The combined row exceeded 480 s alone on 2026-09-26.
 *
 * SCOPE. These rows own only what a rendered document can prove: geometry,
 * node identity, and what the DOM shows after a real interaction. The
 * behavioural half of the old draft — a subagent chat opening and answering,
 * text rendering before the tool card it preceded — is RPC and data shape,
 * provable inside the workerd pool without a DOM, and lives there (the
 * cloudflare-os in-pool session harness); it is deliberately NOT here.
 */

import { Effect } from 'effect';
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TurnClaimFrameSchema } from '@kinu.run/core';
import { renderThrownChain, tolerate, detach } from '@kinu.run/core/obs';
import { SCRIPTED_MODEL_SPEC } from '../packages/test-utils/src/scripted-model-spec';

import { DESKTOP, withLiveApp, type LiveApp } from './live-app-harness';
import { recordDeadEnds } from '../evals/src/browser';
import { createWorkspace, listWorkspaces, LOOPBACK_IDENTITY } from '../evals/src/workspace-roster';
import { CHAT_COMPOSER_LIVE, INSPECTOR_PANEL, INSPECTOR_SHUT_PX, INSPECTOR_WIDTH, OPEN_NAMES, countRpc, frameLedger, named, openInspector, PAGE_TABS, painted, pressSend, pressUntil, recordRenderTasks, rendered, sendInChat, settled, settledAfter, until, waitOn, type ControlAttempt, type RpcCounter } from './browser-page';
import { rowVerdicts, type RowVerdicts } from './row-verdicts';
import { registerScriptedModel, startScriptedModel } from './scripted-model';
import { KEPT_TAB_FORGET, KEPT_TAB_NOTE, PACED_FIRST_TURN_MISSION, PACED_TURN_ANSWER, ANSWERED_TURN_ASK, CLEARED_TURN_ASK, OBSERVED_TURN_ASK, PACED_TURN_ASK, RECONNECT_STEPS, RECONNECT_TURN_ASK, SLEPT_TURN_ASK, TOLD_BACK_ANSWER, TOLD_BACK_ASK, UNANSWERED_PROBE_TURN_ASK, UNSENT_TURN_MISSION, WATCHED_ANSWER_TURN_ASK, WATCHED_SLEPT_TURN_ASK, laterReconnectTurn, toldBackTurn, unsentFirstTurn, DROPPED_FILE_ASK, DROPPED_FILE_ROW, droppedFileTurn, heldCall, keptTabProbe, pacedFirstTurn, thinkingTurn, THINKING_TURN_ASK, THINKING_TURN_ANSWER, pacedTurn, planWalkthrough, reconnectTurn, type HeldCall, LOGO_WAITED_MISSION, MINUTE_LIMITED_ASK, MINUTE_WAITED_OUT, ProviderWaitProbe, providerWaitTurn, WAITED_TURN_ASK, PLAN_TASKS_CHORE, PLAN_TASKS_PLAN, planTasksProbe, SLATE_ID, SLATE_UI_ASK, SLATE_UI_FORGED, SLATE_UI_PAGES, SLATE_UI_SENT, slateUiTurn } from './live-app-scripts';
import { FALLBACK_ANSWER, type ScriptedRequest } from './scripted-protocol';
import { openPublicSocket } from '../tests/first-run/public-socket';
import { drivePlanReview, type WalkthroughVerdict } from './plan-demo-film';
import { evidenceDir } from '@kinu.run/test-utils';

/** Screenshots land beside the other lanes' evidence, outside the worktree. */
const SHOTS = evidenceDir('live-app-rows');

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
  await recordDeadEnds(page);

  // 'load', not 'networkidle0': the app holds its event socket open from
  // first paint, so there is never a zero-connection window to wait for.
  await named('the workspace page to load', () => page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' }));
  await until(page, 'the workspace page', `document.querySelector('textarea') !== null`);

  return page;
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

/** The answer's blocks in order, as `P:` and a prose block's first words or `T:` and a tool row's name, just before
 *  the page's socket dropped and once the replay after its reconnect had been drawn (#30). */
interface ReconnectVerdict {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** A turn sent by hand while the reopened socket's resume probe went unanswered, read once it was answered. */
interface UnansweredProbeVerdict {
  /** Whether the probe's answer was still held when the send was pressed. */
  readonly sentWhileHeld: boolean;
  /** Each change of whether Stop was shown, in order, from the press until well after the probe's answer. */
  readonly stop: readonly boolean[];
  /** Whether the held turn then answered. */
  readonly answered: boolean;
}

/** A page asleep while its turn ended: the answer on a page that stayed awake, the sleeper's once it woke, and
 *  whether the sleeper still offered Stop. */
interface SleptVerdict {
  readonly truth: readonly string[];
  readonly after: readonly string[];
  readonly stopAfter: boolean;
}

/** Row 14's verdict, and whether its page's probe was held for the transcript, as the row means it to be. */
interface WatchedSleptVerdict extends SleptVerdict {
  readonly probeHeld: boolean;
}

/** A turn's answer on one page: while it waits after its steps, once it ends, and after a reload. */
interface AnsweredThroughVerdict {
  readonly live: readonly string[];
  readonly ended: readonly string[];
  readonly reloaded: readonly string[];
}

/** `told` is what the model's next request says the agent said; `watched` is the next turn, which another tab sent. */
interface AnsweredVerdict extends AnsweredThroughVerdict {
  readonly told: readonly string[];
  readonly watched: AnsweredThroughVerdict;
}

/** Where this run's dev server kept its Durable Objects, and what stood there.
 *  The harness mints a scratch directory per boot; before that the Cloudflare
 *  plugin persisted into the checkout's `packages/cf-backend/.wrangler/state`,
 *  one directory per checkout shared by every run on the box. That is how the
 *  deploy wave at 419c31bdc met a `user_workspaces` table written before
 *  `delete_pending` existed and answered 500 to the first credential this
 *  suite wrote, while the same file was green from a fresh worktree. */
interface StateVerdict {
  /** The directory the dev server persisted into. */
  readonly root: string;
  /** The Durable Object namespaces under it, from the plugin's `v3/do` tree. */
  readonly namespaces: readonly string[];
  /** Workspaces on the local server's roster that this run did not create. A
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

export interface TierVerdicts {
  bootFailure: string | null;
  liveIndicator: LiveIndicatorVerdict | null;
  openedMidTurn: OpenedMidTurnVerdict | null;
  reconnect: ReconnectVerdict | null;
  observedReconnect: ReconnectVerdict | null;
  unansweredProbe: UnansweredProbeVerdict | null;
  slept: SleptVerdict | null;
  watchedSlept: WatchedSleptVerdict | null;
  answered: AnsweredVerdict | null;
  unsentAnswer: AnsweredThroughVerdict | null;
  controls: ControlsVerdict | null;
  walkthrough: WalkthroughVerdict | null;
  ownServer: OwnServerVerdict | null;
  keptTab: KeptTabVerdict | null;
  chatScroll: ChatScrollVerdict | null;
  midThought: MidThoughtVerdict | null;
  droppedFile: DroppedFileVerdict | null;
  cleared: ClearedVerdict | null;
  planTasks: PlanTasksVerdict | null;
  slateUi: SlateUiVerdict | null;
  providerWait: ProviderWaitVerdict | null;
  state: StateVerdict | null;
}

/** The lane the rail occupies, measured as the space left of the content
 *  column: `main`'s own left edge in the shell's flex row. Read this way on
 *  purpose — a rail may collapse by narrowing its `aside`, by unmounting it for
 *  a zero-width holder, or by any third shape, and what the reader sees either
 *  way is how much of the window sits left of the content. -1 when the shell
 *  has no content column at all. */
const CONTENT_COLUMN = `document.querySelector('main')`;

const RAIL_LANE = `(() => {
  const content = ${CONTENT_COLUMN};
  return content === null ? -1 : Math.round(content.getBoundingClientRect().left);
})()`;

/** A collapsed rail: an icon strip at most. Its open lane is 240px (`w-60`). */
export const RAIL_SHUT_PX = 64;

const SHUT_NAMES = 'hide|collapse|close';

/** Main's tab in the workspace bar: its status mark names what the chat is doing, and it is absent at rest. */
const MAIN_TAB = 'nav[aria-label="Chats"] [data-agent-tab="main"]';

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
      task: document.querySelector(${JSON.stringify(MAIN_TAB)}) === null ? null
        : document.querySelector(${JSON.stringify(`${MAIN_TAB} [role="img"]`)})?.getAttribute('aria-label')?.toLowerCase() ?? 'idle',
    });
  }, 20);
})()`;

const READ_LIVE_SAMPLES = `(() => { clearInterval(window.__liveSampler); return window.__liveSamples; })()`;

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
    origin, LOOPBACK_IDENTITY, { name: `live-row-indicator-${RUN_ID}`, purpose: 'live indicator probe', model: SCRIPTED_MODEL_SPEC });

  const page = await openWorkspace(newPage, origin, workspace);
  const turns = await watchTurns(page);
  let samples: v.InferOutput<typeof LiveSampleSchema>[];

  try {
    await until(page, "the workspace's first turn to end", FIRST_TURN_ENDED);
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await page.evaluate(INSTALL_LIVE_SAMPLER);

    const paced = turns.afterTurn();

    await sendInChat(page, PACED_TURN_ASK);
    await waitOn(page, 'the paced turn to close', paced);
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

const LayoutProbeSchema = v.object({
  inspectorWidth: v.number(),
  railLane: v.number(),
});

/** Both measurements at once, off the same reads the presses settle on. */
const probeLayoutScript = `({ inspectorWidth: ${INSPECTOR_WIDTH}, railLane: ${RAIL_LANE} })`;

async function measureControls(newPage: LiveApp['newPage'], origin: string): Promise<ControlsVerdict> {
  const workspace = await createWorkspace(
    origin, LOOPBACK_IDENTITY, { name: `live-row-controls-${RUN_ID}`, purpose: 'collapse controls probe', model: SCRIPTED_MODEL_SPEC });

  const page = await openWorkspace(newPage, origin, workspace);

  const before = v.parse(LayoutProbeSchema, await page.evaluate(probeLayoutScript));

  // Opened first, from whatever state the product chose: a fresh workspace
  // holds nothing worth showing, so the column arrives shut.
  const opened = await pressUntil(page, {
    names: OPEN_NAMES, read: INSPECTOR_WIDTH, box: INSPECTOR_PANEL, reached: (width) => width > INSPECTOR_SHUT_PX,
  });

  await shoot(page, 'b8-opened');

  // Shut it with the reader's own control, so the reopen below faces the
  // defect's own situation: a panel the reader collapsed. The control is NOT
  // inside the column any more — the owner asked for a panel button in the
  // tab strip instead of a handle on the column's edge (2026-09-18), so this
  // probe presses it wherever it is, and only the effect is pinned.
  const shut = await pressUntil(page, {
    names: SHUT_NAMES, read: INSPECTOR_WIDTH, box: INSPECTOR_PANEL, outside: '#inspector',
    reached: (width) => width <= INSPECTOR_SHUT_PX,
  });

  const reopened = await pressUntil(page, {
    names: OPEN_NAMES, read: INSPECTOR_WIDTH, box: INSPECTOR_PANEL, reached: (width) => width > INSPECTOR_SHUT_PX,
  });

  await shoot(page, 'b8-reopened');

  // The left rail: every visible control outside the column whose name offers
  // collapsing, hiding or closing, or names the rail, the sidebar or the menu.
  const rail = await pressUntil(page, {
    names: `${SHUT_NAMES}|sidebar|rail|menu`, read: RAIL_LANE, box: CONTENT_COLUMN, outside: '#inspector',
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

/** Row 6: the plan review flow end to end, on the product, over the same
 *  script the README's film is cut from. The drive lives in the recorder
 *  (`drivePlanReview`) so the film and this row cannot tell different stories:
 *  the recorder is that drive plus a camera. */
async function measureWalkthrough(newPage: LiveApp['newPage'], origin: string): Promise<WalkthroughVerdict> {
  const workspace = await createWorkspace(
    origin, LOOPBACK_IDENTITY,
    { name: `live-row-plan-flow-${RUN_ID}`, purpose: 'plan review walkthrough', model: SCRIPTED_MODEL_SPEC });

  const page = await newPage();

  const verdict = await drivePlanReview(page, origin, workspace, async () => {});
  await shoot(page, 'walkthrough-settled');
  await page.close();

  return verdict;
}

/** The walkthrough again, in a workspace of its own, read for the slate its implement turn wrote. */
async function measureOwnServer(newPage: LiveApp['newPage'], origin: string): Promise<OwnServerVerdict> {
  const workspace = await createWorkspace(
    origin, LOOPBACK_IDENTITY,
    { name: `live-row-own-server-${RUN_ID}`, purpose: 'own-server slate in the chat', model: SCRIPTED_MODEL_SPEC });

  const page = await newPage();

  try {
    await drivePlanReview(page, origin, workspace, async () => {});

    return await measureOwnServerSlate(page);
  } finally {
    await shoot(page, 'own-server-settled');
    await page.close();
  }
}

/** The implement turn's slate, drawn in its answer, read in one theme. */
interface OwnServerReading {
  /** The frame's height, and its page's own: a frame at its content's height is neither a fixed box nor a scroller. */
  readonly frame: number;
  readonly page: number;
  /** Whether the page scrolls inside its frame. */
  readonly scrolls: boolean;
}

export interface OwnServerVerdict {
  readonly dark: OwnServerReading;
  readonly light: OwnServerReading;
}

/** The support queue slate answers its page from its class's own `fetch`: read as the chat draws it, in each theme. */
async function measureOwnServerSlate(page: Page): Promise<OwnServerVerdict> {
  const card = `#chat [data-slate-inline=${JSON.stringify(SLATE_ID)}] iframe`;

  // Bounded: a card, a page or a theme that never arrives is the failure this row names, not a hang.
  const bound = { timeout: 60_000 };

  await named('the support queue drawn in its answer', () => page.waitForSelector(card, bound));
  const src = await page.$eval(card, (frame) => frame.getAttribute('src') ?? '');
  const frame = await named('the support queue frame', () => page.waitForFrame((each) => src !== '' && each.url().startsWith(new URL(src).origin), bound));

  await named('the support queue page', () => frame.waitForFunction(() => document.querySelector('table') !== null, bound));

  const read = async (scheme: 'dark' | 'light'): Promise<OwnServerReading> => {
    // The page follows the host's scheme.
    await named(`the support queue in ${scheme}`, () => frame.waitForFunction((want) => document.documentElement.dataset['mode'] === want, bound, scheme));
    // The card is drawn once its frame has a height: a page loads inside a frame still held shut until it says its size.
    await named(`the support queue's frame drawn in ${scheme}`, () => page.waitForFunction(
      (selector) => (document.querySelector(selector)?.getBoundingClientRect().height ?? 0) > 0, bound, card));
    // Settled: the frame takes the height its page last said, and the page stops growing.
    await painted(page);
    await painted(page);

    const outer = await page.$eval(card, (element) => ({ frame: element.getBoundingClientRect().height }));

    const inner = await frame.evaluate(() => {
      const scroller = document.scrollingElement ?? document.documentElement;

      return {
        page: Math.ceil(document.documentElement.getBoundingClientRect().height),
        scrolls: scroller.scrollHeight > scroller.clientHeight + 1,
      };
    });

    return { ...outer, ...inner };
  };

  const first = await page.evaluate(() => (document.documentElement.dataset['mode'] === 'light' ? 'light' : 'dark'));
  const before = await read(first);

  // The theme switch is in the sidebar's account menu, opened from its head.
  await page.click('aside [data-account-menu]');
  await page.waitForSelector('aside [data-mode-toggle]');
  await page.click('aside [data-mode-toggle]');
  const after = await read(first === 'light' ? 'dark' : 'light');

  return first === 'light' ? { light: before, dark: after } : { dark: before, light: after };
}

const MARKED_TAB = `(document.querySelector('#inspector :is(nav[aria-label="Pages"], nav[aria-label="Workspace"]) [aria-current="true"]')?.getAttribute('aria-label') ?? null)`;

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
const PRESENCE_READS = new Set(['getWorkspaceTabPresence', 'getWorkspaceSnapshot', 'getWorkspaceOpening']);

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
 *  asks that read from the effect that follows the turn's last render (`refreshLiveData`),
 *  after the page drew it, and it is final for that turn: a row waits on it,
 *  never on the value it hopes for. */
interface TurnWatch {
  /** Every Work presence the page was answered, in order. */
  workPresence(): readonly boolean[];
  afterTurn(): Promise<boolean>;
  /** A turn no page sent, such as a workspace's first: the one the root's claim names as open when this is
   *  taken, else the next it admits. It follows that turn's own id through the claim every snapshot and
   *  `turn_claim` frame the page receives carries, closes once a claim no longer names it, and settles as
   *  `afterTurn` does. A claim does not say how its turn ended; the page's own record of the error frames its
   *  turns sent ({@link recordDeadEnds}) does, so a turn error recorded while this waits rejects it. */
  afterClaimedTurn(): Promise<boolean>;
  stop(): Promise<void>;
}

interface TurnWaiter {
  /** What names the turn: the chat request the page sends, or the root's claim. */
  readonly follows: 'request' | 'claim';
  /** The request's id or the claimed turn's, once known. */
  id: string | null;
  /** How many presence reads the page had asked when the turn closed; null while it runs. */
  closedAtAsk: number | null;
  readonly settle: ReturnType<typeof Promise.withResolvers<boolean>>;
}

const ClaimStateSchema = TurnClaimFrameSchema.entries.claim;

/** The turn a claim names as open (null once settled), read when the page had asked `atAsk` presence reads. */
interface ClaimRead {
  readonly turnId: string | null;
  readonly atAsk: number;
}

/** The claim a workspace snapshot or opening answer carries (its `turnClaim`). */
const SnapshotClaimSchema = v.looseObject({ turnClaim: ClaimStateSchema });

/** The turn errors {@link recordDeadEnds} recorded on this page, oldest first. */
async function turnErrors(page: Page): Promise<string[]> {
  return v.parse(v.array(v.string()), await page.evaluate('window.__turnErrors ?? []'));
}

async function watchTurns(page: Page): Promise<TurnWatch> {
  const cdp = await page.createCDPSession();

  await cdp.send('Network.enable');

  // Each presence read the page asked, by id, with its place among the reads asked.
  const asked = new Map<string, number>();
  const answers: boolean[] = [];
  let asks = 0;
  let waiters: TurnWaiter[] = [];
  // The newest claim the page read: a snapshot asked before it may answer with an older claim, so it is not read.
  let claimed: ClaimRead = { turnId: null, atAsk: -1 };

  const readClaim = (claim: v.InferOutput<typeof ClaimStateSchema>, atAsk: number): void => {
    if (atAsk < claimed.atAsk) return;
    claimed = { turnId: claim.kind === 'settled' ? null : claim.turnId, atAsk };

    for (const waiter of waiters) {
      if (waiter.follows !== 'claim' || waiter.closedAtAsk !== null) continue;

      if (waiter.id === null) waiter.id = claimed.turnId;
      else if (waiter.id !== claimed.turnId) waiter.closedAtAsk = asks;
    }
  };

  cdp.on('Network.webSocketFrameSent', (event: { response?: { payloadData?: string } }) => {
    const frame = tolerate<unknown>(() => JSON.parse(event.response?.payloadData ?? ''), 'malformed-input');
    const request = v.safeParse(ChatRequestSchema, frame);
    const unsent = waiters.find((waiter) => waiter.follows === 'request' && waiter.id === null);

    if (request.success && unsent !== undefined) unsent.id = request.output.id;

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
      const waiter = waiters.find((candidate) => candidate.follows === 'request' && candidate.id === turn.output.id);

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

    const claimFrame = v.safeParse(TurnClaimFrameSchema, frame);

    if (claimFrame.success) {
      readClaim(claimFrame.output.claim, asks);

      return;
    }

    const answer = v.safeParse(RpcAnswerSchema, frame);
    const place = answer.success ? asked.get(answer.output.id) : undefined;

    if (!answer.success || place === undefined) return;
    asked.delete(answer.output.id);
    const snapshot = v.safeParse(SnapshotClaimSchema, answer.output.result);

    if (snapshot.success) readClaim(snapshot.output.turnClaim, place);

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

      waiters.push({ follows: 'request', id: null, closedAtAsk: null, settle });

      return settle.promise;
    },
    afterClaimedTurn: async () => {
      const settle = Promise.withResolvers<boolean>();
      const waiter: TurnWaiter = { follows: 'claim', id: claimed.turnId, closedAtAsk: null, settle };

      waiters.push(waiter);

      const before = await turnErrors(page);
      const presence = await settle.promise;
      const failures = (await turnErrors(page)).slice(before.length);

      if (failures.length > 0) throw new Error(`the turn ${waiter.id ?? 'the claim named'} failed: ${failures.join('; ')}`);

      return presence;
    },
    stop: async () => { await cdp.detach(); },
  };
}

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
    origin, LOOPBACK_IDENTITY, { name: `live-row-mid-turn-${RUN_ID}`, purpose: PACED_FIRST_TURN_MISSION, model: SCRIPTED_MODEL_SPEC });

  const page = await newPage();
  const turns = await watchTurns(page);
  const reads = await frameLedger(page);

  try {
    await page.setViewport(DESKTOP);
    await recordDeadEnds(page);
    await recordRenderTasks(page);
    await page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' });
    await until(page, 'the workspace page', `document.querySelector('textarea') !== null`);

    // No page sent the workspace's first turn, so its close is read off the claim that names it; a turn that
    // closes before its model call has nothing to hold.
    const closed = turns.afterClaimedTurn();

    const outcome = await waitOn(page, "the workspace's first turn to reach its model",
      Promise.race([firstTurn.arrived.then(() => 'held' as const), closed.then(() => 'closed' as const)]));

    if (outcome !== 'held') throw new Error("the workspace's first turn closed before it reached its model");

    // Loaded again now that the turn is admitted and waiting on its model: the page a new workspace opens on.
    reads.restart();
    await page.reload({ waitUntil: 'load' });
    await until(page, 'the workspace page, reloaded', `document.querySelector('textarea') !== null`);
    await until(page, "the bar's Main tab", `document.querySelector(${JSON.stringify(MAIN_TAB)}) !== null`);
    await page.evaluate(INSTALL_LIVE_SAMPLER);
    await waitOn(page, 'the reloaded page\'s opening', settledAfter(page, reads, 'getWorkspaceOpening'));
    await rendered(page);

    const held = v.parse(v.nullable(LiveSampleSchema), await page.evaluate(LAST_LIVE_SAMPLE));

    firstTurn.release();
    await waitOn(page, "the workspace's first turn to close", closed);
    await rendered(page);

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
    await reads.stop();
    await turns.stop();
    await page.close();
  }
}

const RECORD_SOCKETS = `(() => {
  window.__sockets = [];
  window.__replaysComplete = 0;
  window.__transcripts = 0;
  window.__resumeAnswers = 0;
  window.__asleep = false;
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(url, protocols) {
      // Asleep, every connection is refused, as a sleeping laptop's are; the page keeps retrying on its own.
      super(window.__asleep ? 'ws://127.0.0.1:1/' : url, protocols);
      window.__sockets.push(this);
      this.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        if (event.data.includes('"replayComplete":true')) window.__replaysComplete += 1;
        if (event.data.includes('"type":"cf_agent_chat_messages"')) {
          window.__transcripts += 1;
          window.__releaseProbe?.();
        }
        // The chat hook's stream probe answered: a stream resuming, or none in the reply carrying the probe's id.
        if (event.data.includes('"type":"cf_agent_stream_resuming"')
          || (event.data.includes('"type":"cf_agent_stream_resume_none"') && event.data.includes('"probeId"'))) window.__resumeAnswers += 1;
      });
    }
  };
})()`;

/** Close every open socket the way a sleeping laptop loses them; the page reconnects on its own. */
const DROP_SOCKETS = `(() => {
  let dropped = 0;
  for (const socket of window.__sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(3000, 'asleep');
      dropped += 1;
    }
  }
  return dropped;
})()`;

const ANSWER_BLOCKS = `[...document.querySelectorAll('#chat .prose-chat, #chat [data-tool-state]')].map((node) =>
  node.matches('[data-tool-state]')
    ? 'T:' + (node.querySelector('strong')?.textContent ?? '').trim()
    : 'P:' + (node.textContent ?? '').trim().slice(0, 40))`;

/** A workspace's page that records its sockets and queued render work, once its first turn has ended. */
async function openRecorded(newPage: LiveApp['newPage'], origin: string, workspace: string): Promise<Page> {
  const page = await named('a new recorded tab', async () => {
    const opened = await newPage();

    await opened.setViewport(DESKTOP);
    await recordDeadEnds(opened);
    await opened.evaluateOnNewDocument(RECORD_SOCKETS);
    await recordRenderTasks(opened);

    return opened;
  });

  await named('the workspace page to load', () => page.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' }));
  await until(page, 'the workspace page', `document.querySelector('textarea') !== null`);
  await until(page, "the workspace's first turn to end", FIRST_TURN_ENDED);
  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);

  return page;
}

const answerOf = async (page: Page): Promise<string[]> => v.parse(v.array(v.string()), await page.evaluate(ANSWER_BLOCKS));

/** Waits until the page shows the reconnect turn's steps while it still runs, past the `before` tool rows of earlier
 *  turns, and reads its answer. */
async function answerMidTurn(page: Page, before = 0): Promise<string[]> {
  await until(page, `the turn's ${String(RECONNECT_STEPS)} finished tool rows`,
    `document.querySelectorAll('#chat [data-tool-state="done"]').length >= ${String(before + RECONNECT_STEPS)}`);
  await painted(page);

  // A turn that ended before the drop has nothing to replay, and the wait for one would never end.
  if (!v.parse(v.boolean(), await page.evaluate(STOP_OFFERED))) throw new Error('the turn ended before its sockets dropped');

  return answerOf(page);
}

/** Drops the page's sockets and reads its answer once the replay after the reconnect is drawn. The replays are
 *  counted from the drop: a page that resumed at load has seen one complete already. */
async function answerAfterReplay(page: Page): Promise<string[]> {
  const replays = v.parse(v.number(), await page.evaluate('window.__replaysComplete'));

  if (v.parse(v.number(), await page.evaluate(DROP_SOCKETS)) === 0) throw new Error('the page held no open socket to drop');

  await until(page, 'the replay after the page reconnected', `window.__replaysComplete > ${String(replays)}`);
  await rendered(page);

  return answerOf(page);
}

/** Row 10 (#30): a page whose socket drops while its turn runs draws the answer in the same order once it
 *  reconnects and the server has replayed the turn from its start. The turn's steps each say what they do and call
 *  a tool, then it waits on a held model call, so it is still running through the drop and the replay. */
async function measureReconnect(newPage: LiveApp['newPage'], origin: string, held: HeldCall): Promise<ReconnectVerdict> {
  const workspace = await named('the reconnect workspace to be created', () => createWorkspace(
    origin, LOOPBACK_IDENTITY, { name: `live-row-reconnect-${RUN_ID}`, purpose: 'reconnect probe', model: SCRIPTED_MODEL_SPEC }));

  const page = await openRecorded(newPage, origin, workspace);

  try {
    await sendInChat(page, RECONNECT_TURN_ASK);
    const before = await answerMidTurn(page);
    const after = await answerAfterReplay(page);

    await named('the replayed page\'s screenshot', () => shoot(page, 'reconnect-replayed'));

    return { before, after };
  } finally {
    held.release();
    await named('the reconnect tab to close', () => page.close());
  }
}

/** Row 11 (#30): the same, on a page that only watched the turn: another tab sent it. */
async function measureObservedReconnect(newPage: LiveApp['newPage'], origin: string, held: HeldCall): Promise<ReconnectVerdict> {
  const workspace = await createWorkspace(
    origin, LOOPBACK_IDENTITY, { name: `live-row-observed-${RUN_ID}`, purpose: 'observed reconnect probe', model: SCRIPTED_MODEL_SPEC });

  const watcher = await openRecorded(newPage, origin, workspace);
  const sender = await openRecorded(newPage, origin, workspace);

  try {
    await sendInChat(sender, OBSERVED_TURN_ASK);
    // A hidden tab never paints, so the page being read is the one in front.
    await watcher.bringToFront();
    const before = await answerMidTurn(watcher);
    const after = await answerAfterReplay(watcher);

    await shoot(watcher, 'reconnect-observed');

    return { before, after };
  } finally {
    held.release();
    await sender.close();
    await watcher.close();
  }
}

const TURN_ANSWERED = `(${ANSWER_BLOCKS}).at(-1) === 'P:Done.' && !(${STOP_OFFERED})`;

/** What a page's sockets have heard, counted before it sleeps so the answers to its waking are told apart. */
const HEARD = '[window.__transcripts, window.__resumeAnswers]';

const HeardSchema = v.tuple([v.number(), v.number()]);

/**
 * Wakes a page and reads it once the server has answered its new socket: the transcript, which the turn's claim
 * precedes, and the chat hook's stream probe. Read at once, so a page still offering Stop then fails, never waited out.
 */
async function wakeAndRead(page: Page, heard: v.InferOutput<typeof HeardSchema>, shot: string): Promise<Omit<SleptVerdict, 'truth'>> {
  await page.bringToFront();
  await page.evaluate('window.__asleep = false');
  await until(page, 'the transcript after the page woke', `window.__transcripts > ${String(heard[0])}`);
  await until(page, "the stream probe's answer after the page woke", `window.__resumeAnswers > ${String(heard[1])}`);
  await painted(page);
  await shoot(page, shot);

  return { after: await answerOf(page), stopAfter: v.parse(v.boolean(), await page.evaluate(STOP_OFFERED)) };
}

/** Row 12 (#30): a page asleep while its turn ends shows the finished answer once it wakes, as a page that stayed
 *  awake shows it, and offers no Stop. */
async function measureSlept(newPage: LiveApp['newPage'], origin: string, held: HeldCall): Promise<SleptVerdict> {
  const workspace = await createWorkspace(
    origin, LOOPBACK_IDENTITY, { name: `live-row-slept-${RUN_ID}`, purpose: 'slept probe', model: SCRIPTED_MODEL_SPEC });

  const sleeper = await openRecorded(newPage, origin, workspace);
  const awake = await openRecorded(newPage, origin, workspace);

  try {
    // A hidden tab never paints, so the page being read is the one in front.
    await sleeper.bringToFront();
    await sendInChat(sleeper, SLEPT_TURN_ASK);
    await answerMidTurn(sleeper);
    const heard = v.parse(HeardSchema, await sleeper.evaluate(HEARD));

    await sleeper.evaluate('window.__asleep = true');

    if (v.parse(v.number(), await sleeper.evaluate(DROP_SOCKETS)) === 0) throw new Error('the page held no open socket to drop');

    held.release();
    await awake.bringToFront();
    await until(awake, 'the turn to end on the page that stayed awake', TURN_ANSWERED);
    await painted(awake);
    const truth = await answerOf(awake);

    return { truth, ...await wakeAndRead(sleeper, heard, 'reconnect-slept') };
  } finally {
    held.release();
    await awake.close();
    await sleeper.close();
  }
}

/** Holds the next socket's answer to the chat hook's resume probe, and every frame after it in order, until
 *  `__releaseAnswer`: the answer comes late, as a slow server's does. The listeners held are the ones a reopened
 *  socket is given; its prototype is read off a recorded socket, since each is a plain WebSocket built through the
 *  dead-end recorder's proxy, never the subclass `window.WebSocket` names. */
const HOLD_PROBE_ANSWER = `(() => {
  const prototype = Object.getPrototypeOf(window.__sockets[0]);
  const add = prototype.addEventListener;
  const held = [];
  let holding = true;
  window.__answerHeld = false;
  window.__releaseAnswer = () => {
    holding = false;
    delete prototype.addEventListener;
    for (const deliver of held.splice(0)) deliver();
  };
  prototype.addEventListener = function (type, listener, options) {
    if (type !== 'message' || typeof listener !== 'function') return add.call(this, type, listener, options);
    return add.call(this, type, function (event) {
      const answer = typeof event.data === 'string' && /"type":"cf_agent_stream_resum(ing|e_none)"/u.test(event.data);
      if (!holding || (!answer && held.length === 0)) return listener.call(this, event);
      window.__answerHeld = true;
      held.push(() => listener.call(this, event));
    }, options);
  };
})()`;

/** Every change of whether Stop is shown, kept in `__stopShown`. */
const WATCH_STOP = `(() => {
  window.__stopShown = [];
  const read = () => {
    const shown = [...document.querySelectorAll('#chat button[aria-label="Stop this turn"]')].some((button) => button.getClientRects().length > 0);
    if (window.__stopShown.at(-1) !== shown) window.__stopShown.push(shown);
  };
  new MutationObserver(read).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  read();
})()`;

/**
 * Row (2026-10-14): a turn sent by hand before the reopened socket's resume probe is answered keeps its Stop once the
 * answer comes. `useChat` keeps one status for a resume and a send: a "none" answered after the send ended the send's
 * state, and a new chat's opening turn showed Stop for 10 ms. The answer is held ({@link HOLD_PROBE_ANSWER}) past the
 * press, then let go.
 */
async function measureUnansweredProbe(newPage: LiveApp['newPage'], origin: string, held: HeldCall): Promise<UnansweredProbeVerdict> {
  const workspace = await named('the probe-wait workspace to be created', () => createWorkspace(
    origin, LOOPBACK_IDENTITY, { name: `live-row-probe-wait-${RUN_ID}`, purpose: 'probe wait probe', model: SCRIPTED_MODEL_SPEC }));

  const page = await openRecorded(newPage, origin, workspace);

  try {
    await page.evaluate(HOLD_PROBE_ANSWER);

    if (v.parse(v.number(), await page.evaluate(DROP_SOCKETS)) === 0) throw new Error('the page held no open socket to drop');
    await until(page, "the reopened socket's probe answer, held", 'window.__answerHeld === true');
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await page.evaluate(WATCH_STOP);
    await pressSend(page, UNANSWERED_PROBE_TURN_ASK);
    await painted(page);
    const sentWhileHeld = v.parse(v.boolean(), await page.evaluate('window.__answerHeld'));

    await page.evaluate('window.__releaseAnswer()');
    await named('the held call to arrive', () => held.arrived);
    // Read across the answer and the turn's frames that follow it, while the turn still waits on its held call.
    await settled(page, 'JSON.stringify(window.__stopShown)');
    const stop = v.parse(v.array(v.boolean()), await page.evaluate('window.__stopShown'));

    held.release();
    await until(page, 'the held turn to answer', TURN_ANSWERED);

    return { sentWhileHeld, stop, answered: true };
  } finally {
    held.release();
    await page.close();
  }
}

/**
 * Holds a woken page's chat-hook probe (the stream resume request carrying a probe id) until a probeless resume
 * request has gone out or the socket's transcript has come in. So a probeless request's answer lands first, the order
 * a remount of the hook's listeners gives: that answer spent the probe's wait and left the watched stream's Stop
 * standing after the turn (#30). A page with one resume path, the hook's, sends no probeless request.
 */
const PROBE_ANSWERED_LAST = `(() => {
  // A recorded socket's own prototype, as HOLD_PROBE_ANSWER reads it: patched on \`WebSocket\`, the recorder's subclass,
  // the hold never met a socket, every one a plain WebSocket built through the dead-end recorder's proxy.
  const prototype = Object.getPrototypeOf(window.__sockets[0]);
  const send = prototype.send;
  let held = null;
  window.__probeHeld = false;
  window.__releaseProbe = () => {
    if (held === null) return;
    const [socket, data] = held;
    held = null;
    send.call(socket, data);
  };
  prototype.send = function (data) {
    if (typeof data !== 'string' || !data.includes('"type":"cf_agent_stream_resume_request"')) return send.call(this, data);
    if (data.includes('"probeId"')) {
      held = [this, data];
      window.__probeHeld = true;
      return;
    }
    send.call(this, data);
    window.__releaseProbe();
  };
})()`;

/** Row 14 (#30): a page that only watched a turn, asleep from part-way through its final text until the turn ended,
 *  wakes to the finished answer: the copy it was building had as many parts as the answer, and must not win. Its
 *  hook's probe is answered last ({@link PROBE_ANSWERED_LAST}). */
async function measureWatchedSlept(newPage: LiveApp['newPage'], origin: string, held: HeldCall): Promise<WatchedSleptVerdict> {
  const workspace = await createWorkspace(
    origin, LOOPBACK_IDENTITY, { name: `live-row-watched-slept-${RUN_ID}`, purpose: 'watched slept probe', model: SCRIPTED_MODEL_SPEC });

  const watcher = await openRecorded(newPage, origin, workspace);
  const sender = await openRecorded(newPage, origin, workspace);

  try {
    await sendInChat(sender, WATCHED_SLEPT_TURN_ASK);
    // A hidden tab never paints, so the page being read is the one in front.
    await watcher.bringToFront();
    await until(watcher, "the final text's first word on the watching page", `(${ANSWER_BLOCKS}).at(-1) === 'P:Do'`);
    const heard = v.parse(HeardSchema, await watcher.evaluate(HEARD));

    await watcher.evaluate('window.__asleep = true');

    if (v.parse(v.number(), await watcher.evaluate(DROP_SOCKETS)) === 0) throw new Error('the page held no open socket to drop');

    held.release();
    await sender.bringToFront();
    await until(sender, 'the turn to end on the sending page', TURN_ANSWERED);
    await painted(sender);
    const truth = await answerOf(sender);

    await watcher.evaluate(PROBE_ANSWERED_LAST);
    const woke = await wakeAndRead(watcher, heard, 'reconnect-watched-slept');

    return { truth, ...woke, probeHeld: v.parse(v.boolean(), await watcher.evaluate('window.__probeHeld')) };
  } finally {
    held.release();
    await sender.close();
    await watcher.close();
  }
}

/** The answer `page` draws while its turn waits on `held` after its steps, once it ends, and after a reload: the blocks
 *  past the `since` that earlier turns drew. */
async function answeredThrough(page: Page, held: HeldCall, shot: string, since: readonly string[] = []): Promise<AnsweredThroughVerdict> {
  const live = await answerMidTurn(page, since.filter((block) => block.startsWith('T:')).length);

  held.release();
  await until(page, 'the turn to end', TURN_ANSWERED);
  await painted(page);
  const ended = await answerOf(page);

  await page.reload({ waitUntil: 'load' });
  await until(page, 'the answer after the reload', TURN_ANSWERED);
  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
  await painted(page);
  const reloaded = await answerOf(page);

  await shoot(page, shot);

  return { live: live.slice(since.length), ended: ended.slice(since.length), reloaded: reloaded.slice(since.length) };
}

/** Row 13 (#30): an answer keeps each step's text where it streamed: while it runs, once it ends, after a reload, and
 *  in the model's next request. Row 15: so does the next turn's, which another tab sends while this page watches. */
async function measureAnswered(
  newPage: LiveApp['newPage'], origin: string, held: { answered: HeldCall; watched: HeldCall }, told: Promise<ScriptedRequest>,
): Promise<AnsweredVerdict> {
  const workspace = await createWorkspace(
    origin, LOOPBACK_IDENTITY, { name: `live-row-answered-${RUN_ID}`, purpose: 'answered probe', model: SCRIPTED_MODEL_SPEC });

  const page = await openRecorded(newPage, origin, workspace);
  let sender: Page | null = null;

  try {
    await sendInChat(page, ANSWERED_TURN_ASK);
    const answer = await answeredThrough(page, held.answered, 'answered-reloaded');

    await sendInChat(page, TOLD_BACK_ASK);
    const heard = (await told).assistantTexts;

    await until(page, 'the told-back answer', `(${ANSWER_BLOCKS}).at(-1) === ${JSON.stringify(`P:${TOLD_BACK_ANSWER}`)} && !(${STOP_OFFERED})`);
    const since = await answerOf(page);

    sender = await openRecorded(newPage, origin, workspace);
    await sendInChat(sender, WATCHED_ANSWER_TURN_ASK);
    // A hidden tab never paints, so the page being read is the one in front.
    await page.bringToFront();

    return { ...answer, told: heard, watched: await answeredThrough(page, held.watched, 'watched-answer-reloaded', since) };
  } finally {
    held.answered.release();
    held.watched.release();
    await sender?.close();
    await page.close();
  }
}

/** Row 16 (#30): and a turn no page sent, the workspace's own first turn, on a page open while it runs. */
async function measureUnsentAnswer(newPage: LiveApp['newPage'], origin: string, held: HeldCall): Promise<AnsweredThroughVerdict> {
  const workspace = await createWorkspace(
    origin, LOOPBACK_IDENTITY, { name: `live-row-unsent-${RUN_ID}`, purpose: UNSENT_TURN_MISSION, model: SCRIPTED_MODEL_SPEC });

  // Not `openRecorded`, which waits for the first turn to end: here that turn is the one held.
  const page = await openWorkspace(newPage, origin, workspace);

  try {
    return await answeredThrough(page, held, 'unsent-answer-reloaded');
  } finally {
    held.release();
    await page.close();
  }
}

const WORK_TAB = `document.querySelector('#inspector nav[aria-label="Workspace"] [aria-label="Work"]')`;

/** Row 8: the inspector never moves its selection on its own. In a new
 *  workspace the panel resolves to its first tab; the first turn saves a note,
 *  which gives Work content; the reader opens Work; the next turn forgets the
 *  note, which empties Work under the reader. A third turn is the fence: it
 *  closes after the page has taken in the emptied read, so a move the panel
 *  made on that read is in the record by then. A turn that did not fill or
 *  empty Work ends the row there, naming the read the page made after it. */
async function measureKeptTab(newPage: LiveApp['newPage'], origin: string): Promise<KeptTabVerdict> {
  const workspace = await createWorkspace(
    origin, LOOPBACK_IDENTITY, { name: `live-row-kept-tab-${RUN_ID}`, purpose: 'kept tab probe', model: SCRIPTED_MODEL_SPEC });

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

    if (!(await waitOn(page, 'the note turn to close', noted))) {
      throw new Error(`waiting for the note turn to fill Work, the page read Work empty once the turn closed; `
        + `the chat ends ${JSON.stringify(await page.evaluate(CHAT_TAIL))}`);
    }

    await until(page, 'the Work tab in the inspector strip', `${WORK_TAB} !== null`);
    await page.evaluate(`${WORK_TAB}.click()`);
    await until(page, 'Work marked current', `${MARKED_TAB} === 'Work'`);

    const forgotten = turns.afterTurn();

    await sendInChat(page, KEPT_TAB_FORGET);

    if (await waitOn(page, 'the forget turn to close', forgotten)) {
      throw new Error(`waiting for the forget turn to empty Work, the page read Work filled once the turn closed; `
        + `the chat ends ${JSON.stringify(await page.evaluate(CHAT_TAIL))}`);
    }

    const fenced = turns.afterTurn();

    await sendInChat(page, 'Kept-tab probe: the fence.');
    await waitOn(page, 'the fence turn to close', fenced);

    const marks = v.parse(v.array(v.nullable(v.string())), await page.evaluate('window.__keptTabMarks'));

    return { marks: marks.map((mark) => mark ?? '(none)'), workPresence: turns.workPresence() };
  } finally {
    await turns.stop();
    await page.close();
  }
}

/** Older history pages each chat asked for, and where its view sat: the owner's 2026-09-26 report was a
 *  chat that paged through its history while he sat still, and did not open at its newest message. */
interface ChatScrollVerdict {
  readonly pagesIdleAfterOpen: number;
  readonly openFromBottom: number;
  readonly pagesOnScrollToTop: number;
  readonly pagesIdleAfterReturn: number;
  readonly returnFromBottom: number;
}

/** Enough turns that the transcript overruns the socket's newest window by more than one older page. */
const LONG_CHAT_TURNS = 70;

const HISTORY_PAGE_METHOD = 'getChatHistoryPage';

const CHAT_SCROLLER = `[...document.querySelectorAll('#chat, #chat *')].find((el) => getComputedStyle(el).overflowY === 'auto' && el.scrollHeight > el.clientHeight)`;

const FROM_BOTTOM = `(() => { const el = ${CHAT_SCROLLER}; return el === undefined ? -1 : Math.round(el.scrollHeight - el.scrollTop - el.clientHeight); })()`;

const SCROLL_METRICS = `(() => { const el = ${CHAT_SCROLLER}; return el === undefined ? '' : String(el.scrollHeight) + ':' + String(el.scrollTop); })()`;

const CHAT_ROWS = `(() => { const el = ${CHAT_SCROLLER}; return el === undefined ? 0 : [...el.children].filter(row => !row.hasAttribute('data-scroll-edge')).length; })()`;

/** History pages asked for between two reads, the second taken once the view has stopped growing: a
 *  runaway walk keeps it growing, so it cannot read settled early. */
async function pagesUntilSettled(page: Page, counter: RpcCounter): Promise<number> {
  const before = counter.counts().sent[HISTORY_PAGE_METHOD] ?? 0;

  await painted(page);
  await settled(page, SCROLL_METRICS, { scroller: CHAT_SCROLLER });

  return (counter.counts().sent[HISTORY_PAGE_METHOD] ?? 0) - before;
}

async function measureChatScroll(newPage: LiveApp['newPage'], origin: string): Promise<ChatScrollVerdict> {
  const long = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-row-long-${RUN_ID}`, purpose: 'long chat', model: SCRIPTED_MODEL_SPEC });
  const other = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-row-short-${RUN_ID}`, purpose: 'short chat', model: SCRIPTED_MODEL_SPEC });
  const socket = openPublicSocket(origin, { kind: 'loopback' }, `/agents/orchestrator-agent/${long}`, new AbortController().signal);

  if (!(await socket.opened)) throw new Error('the seeding socket did not open');

  for (let turn = 1; turn <= LONG_CHAT_TURNS; turn += 1) await socket.chat(`Long chat turn ${String(turn)}.`);
  socket.close('seeded');

  const page = await openWorkspace(newPage, origin, long);
  const counter = await countRpc(page);
  const reads = await frameLedger(page);

  const fetchOlderPage = async (): Promise<boolean> => {
    const before = counter.counts().sent[HISTORY_PAGE_METHOD] ?? 0;
    const rows = v.parse(v.number(), await page.evaluate(CHAT_ROWS));

    const box = v.parse(v.object({ x: v.number(), y: v.number(), height: v.number() }), await page.evaluate(`(() => {
      const el = ${CHAT_SCROLLER};
      if (el === undefined) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, height: el.clientHeight };
    })()`));

    reads.restart();
    await page.mouse.move(box.x, box.y);

    while ((counter.counts().sent[HISTORY_PAGE_METHOD] ?? 0) === before) {
      const wasAtTop = await page.evaluate(`(${CHAT_SCROLLER})?.scrollTop === 0`);
      await page.mouse.wheel({ deltaY: -box.height / 2 });
      await painted(page);

      if (wasAtTop && await page.evaluate(`(${CHAT_SCROLLER})?.scrollTop === 0`)
        && (counter.counts().sent[HISTORY_PAGE_METHOD] ?? 0) === before) return false;
    }

    await waitOn(page, 'the history page response', settledAfter(page, reads, HISTORY_PAGE_METHOD));
    await until(page, 'the older messages to render', `${CHAT_ROWS} > ${String(rows)}`);
    await settled(page, SCROLL_METRICS, { scroller: CHAT_SCROLLER });

    return true;
  };

  try {
    await until(page, 'the newest turn to render', `(document.querySelector('#chat')?.textContent ?? '').includes('Long chat turn ${String(LONG_CHAT_TURNS)}.')`);

    // Counted from the socket's first frame: an eager page the pane asks for on its own is the defect.
    await painted(page);
    await settled(page, SCROLL_METRICS, { scroller: CHAT_SCROLLER });

    const pagesIdleAfterOpen = counter.counts().sent[HISTORY_PAGE_METHOD] ?? 0;
    const openFromBottom = v.parse(v.number(), await page.evaluate(FROM_BOTTOM));

    const beforeTop = counter.counts().sent[HISTORY_PAGE_METHOD] ?? 0;

    const fetched = await fetchOlderPage();

    const pagesOnScrollToTop = (counter.counts().sent[HISTORY_PAGE_METHOD] ?? 0) - beforeTop;

    if (fetched && !(await page.evaluate(`[...document.querySelectorAll('#chat [data-scroll-edge]')].some(edge => edge.textContent?.includes('Beginning of the conversation') === true)`))) await fetchOlderPage();
    await page.evaluate(`(() => { const el = ${CHAT_SCROLLER}; if (el) el.scrollTop = el.scrollHeight - el.clientHeight - 600; })()`);
    await painted(page);
    await page.evaluate(`document.querySelector('a[href="/workspace/${other}"]')?.click()`);
    await until(page, 'the other chat to open', `location.pathname === '/workspace/${other}' && document.querySelector('textarea') !== null`);
    await page.evaluate(`document.querySelector('a[href="/workspace/${long}"]')?.click()`);
    await until(page, 'the long chat to reopen', `(document.querySelector('#chat')?.textContent ?? '').includes('Long chat turn ${String(LONG_CHAT_TURNS)}.')`);

    const pagesIdleAfterReturn = await pagesUntilSettled(page, counter);
    const returnFromBottom = v.parse(v.number(), await page.evaluate(FROM_BOTTOM));

    return { pagesIdleAfterOpen, openFromBottom, pagesOnScrollToTop, pagesIdleAfterReturn, returnFromBottom };
  } finally {
    await counter.stop();
    await reads.stop();
    await page.close();
  }
}

interface MidThoughtVerdict {
  readonly reconnectedErrors: readonly string[];
  readonly joinedErrors: readonly string[];
  /** Each `POST /api/client-errors` a page made: its status and the event it named. */
  readonly reports: readonly { readonly status: number; readonly event: string; readonly refusal: string }[];
  /** A well-formed report posted the way the reporter posts one, and the route's answer. */
  readonly probe: string;
}

const STREAM_ERROR_TEXT = `[...document.querySelectorAll('[data-chat-error]')].map((node) => (node.textContent ?? '').trim()).filter(Boolean)`;

const ReportBodySchema = v.looseObject({ event: v.string() });

function recordReports(page: Page, into: { status: number; event: string; refusal: string }[]): void {
  page.on('response', (response) => detach(Effect.promise(async () => {
    const request = response.request();

    if (request.method() !== 'POST' || !request.url().endsWith('/api/client-errors')) return;
    const body = v.safeParse(ReportBodySchema, tolerate<unknown>(() => JSON.parse(request.postData() ?? ''), 'malformed-input'));
    const refusal = response.status() < 300 ? '' : (await response.text()).slice(0, 200);

    into.push({ status: response.status(), event: body.success ? body.output.event : '?', refusal });
  })));
}

/** Owner report 2026-09-26: "Received reasoning-delta for missing reasoning part". A page whose socket drops while the
 *  model reasons, and a page opened on a slow link while it reasons, each join the stream part-way through a
 *  reasoning part; each must read the whole turn without a stream error. */
async function measureMidThought(newPage: LiveApp['newPage'], origin: string): Promise<MidThoughtVerdict> {
  const workspace = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-row-thought-${RUN_ID}`, purpose: 'reasoning probe', model: SCRIPTED_MODEL_SPEC });
  const reports: { status: number; event: string; refusal: string }[] = [];
  const sender = await openRecorded(newPage, origin, workspace);
  const joiner = await newPage();

  recordReports(sender, reports);
  recordReports(joiner, reports);

  try {
    await sendInChat(sender, THINKING_TURN_ASK);
    await until(sender, 'the reasoning to stream', STOP_OFFERED);

    if (v.parse(v.number(), await sender.evaluate(DROP_SOCKETS)) === 0) throw new Error('the page held no open socket to drop');

    // The joining page's acknowledgement takes a round trip while the reasoning keeps streaming.
    const link = await joiner.createCDPSession();

    await link.send('Network.enable');
    await link.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: -1, uploadThroughput: -1 });
    await joiner.setViewport(DESKTOP);
    await joiner.goto(`${origin}/workspace/${workspace}`, { waitUntil: 'load' });

    const answered = `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(THINKING_TURN_ANSWER)}) || (${STREAM_ERROR_TEXT}).length > 0`;

    await until(joiner, 'the turn to answer or fail', answered);
    await painted(joiner);
    // A hidden tab never paints, so the sender is read in front.
    await sender.bringToFront();
    await until(sender, 'the turn to answer or fail', answered);
    await painted(sender);

    const probe = v.parse(v.string(), await sender.evaluate(`fetch('/api/client-errors', {
      method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ event: 'client.chat_stream_failed', errorName: 'AI_UIMessageStreamError', route: '/workspace/:agentId',
        pane: 'root', stack: '', part: { type: 'reasoning-delta', id: 'reasoning-0' } }),
    }).then(async (answer) => String(answer.status) + ' ' + (await answer.text()).slice(0, 160))`));

    return {
      probe,
      reconnectedErrors: v.parse(v.array(v.string()), await sender.evaluate(STREAM_ERROR_TEXT)),
      joinedErrors: v.parse(v.array(v.string()), await joiner.evaluate(STREAM_ERROR_TEXT)),
      reports,
    };
  } finally {
    await sender.close();
    await joiner.close();
  }
}

/** The end of the chat once the turn a dropped file went out with has answered. */
interface DroppedFileVerdict {
  readonly answer: string;
}

/** Issue #33: a file dropped on the chat column rides the next message into the agent's turn, through the real
 *  composer, upload and turn; the scripted model answers with whether the file's row reached it. */
async function measureDroppedFile(newPage: LiveApp['newPage'], origin: string): Promise<DroppedFileVerdict> {
  const workspace = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-row-drop-${RUN_ID}`, purpose: 'dropped file probe', model: SCRIPTED_MODEL_SPEC });
  const page = await openWorkspace(newPage, origin, workspace);

  try {
    await until(page, "the workspace's first turn to end", FIRST_TURN_ENDED);
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await page.$eval('[data-agent-pane$="/main"]', (pane, row) => {
      const files = new DataTransfer();

      files.items.add(new File([`coupon,discount\n${row}\n`], 'coupons.csv', { type: 'text/csv' }));
      pane.dispatchEvent(new DragEvent('dragover', { dataTransfer: files, bubbles: true, cancelable: true }));
      pane.dispatchEvent(new DragEvent('drop', { dataTransfer: files, bubbles: true, cancelable: true }));
    }, DROPPED_FILE_ROW);
    await until(page, 'the dropped file in the composer', `(document.querySelector('#chat [data-composer-root]')?.textContent ?? '').includes('coupons.csv')`);
    await sendInChat(page, DROPPED_FILE_ASK);
    await until(page, 'the turn to answer', `/file arrived|No file reached/u.test(document.querySelector('#chat')?.textContent ?? '')`);

    return { answer: v.parse(v.string(), await page.evaluate(CHAT_TAIL)) };
  } finally {
    await page.close();
  }
}

/** The Work tab's plan cards once the approved plan's turn ran: each card's tasks by title and depth, and the titles
 *  listed apart from any plan. */
interface PlanTasksVerdict {
  readonly plans: readonly (readonly (readonly [string, number])[])[];
  readonly unlinked: readonly string[];
}

const TASK_TITLE = `(row) => row.querySelector('.p-row-text')?.firstChild?.textContent ?? ''`;

const PLAN_CARDS = `[...document.querySelectorAll('[data-plan-card]')].map((card) => [...card.querySelectorAll('[data-task-depth]')]
  .map((row) => [(${TASK_TITLE})(row), Number(row.getAttribute('data-task-depth'))]))`;

/** Now lists every open task, a plan's too, so the planless ones are those no plan card holds. */
const PLANLESS_TASKS = `((planned) => [...document.querySelectorAll('[data-task-depth]')].filter((row) => row.closest('[data-plan-card]') === null)
  .map(${TASK_TITLE}).filter((title) => !planned.has(title)))(new Set([...document.querySelectorAll('[data-plan-card] [data-task-depth]')].map(${TASK_TITLE})))`;

/** An answer's `<slate-ui>` blocks: the names the chat drew, what each frame's page shows, and the same once the
 *  page is reloaded and the answer is read back. */
interface SlateUiVerdict {
  readonly drawn: readonly string[];
  readonly shown: Readonly<Record<string, string>>;
  /** What the first page read through `workspace`, whether its click reached the agent as a slate event, and whether
   *  the page the person clicked is still the one drawn once that turn has ended. */
  readonly read: string;
  readonly heard: boolean;
  readonly kept: boolean;
  /** The work surface's page tabs on a page opened while both pages run: an unsaved page has none (#90). */
  readonly tabs: readonly string[];
  /** What the first page shows once its card's open control brought it up in the work surface. */
  readonly opened: string;
  readonly redrawn: readonly string[];
  readonly reshown: Readonly<Record<string, string>>;
  /** After a browser sent a block of its own: the blocks the chat draws, and what a preview of each forged id answered. */
  readonly forged: {
    readonly drawn: readonly string[];
    /** The browser's own message, named as a block. */
    readonly sent: string;
    /** The agent's answer, under a name it holds no block of. */
    readonly renamed: string;
    /** The agent's answer under a block it wrote, which does preview. */
    readonly answered: string;
  };
}

const HistoryEntriesSchema = v.object({ items: v.array(v.object({ id: v.string(), role: v.string(), content: v.string() })) });

/** What a preview of `id` answered: `ok`, or the refusal's reason. */
async function previewAnswer(socket: ReturnType<typeof openPublicSocket>, id: string): Promise<string> {
  const answered = v.parse(v.looseObject({ ok: v.boolean(), reason: v.optional(v.string()) }), await socket.rpc('previewSlate', [id]));

  return answered.ok ? 'ok' : answered.reason ?? 'refused';
}

/** A browser's own block draws nothing and previews nothing; an answer's id previews only the blocks the answer wrote. */
async function forgedBlocks(page: Page, origin: string, workspace: string): Promise<SlateUiVerdict['forged']> {
  const socket = openPublicSocket(origin, { kind: 'loopback' }, `/agents/orchestrator-agent/${workspace}`, new AbortController().signal);

  if (!(await socket.opened)) throw new Error('the forging socket did not open');

  try {
    await socket.chat(SLATE_UI_FORGED);
    await until(page, 'the forged message in the chat', `(document.querySelector('#chat')?.textContent ?? '').includes('slate-ui name="forged"') && !(${STOP_OFFERED})`);
    const { items } = v.parse(HistoryEntriesSchema, await socket.rpc('getChatHistoryPage', [{}]));
    const sent = items.find((item) => item.role === 'user' && item.content.includes('name="forged"'))?.id ?? 'none';
    const answer = items.find((item) => item.role === 'assistant' && item.content.includes('<slate-ui name="first">'))?.id ?? 'none';

    return {
      drawn: await page.$$eval('[data-slate-ui]', (found) => found.map((card) => card.getAttribute('data-slate-ui') ?? '')),
      sent: await previewAnswer(socket, `${sent}/forged`),
      renamed: await previewAnswer(socket, `${answer}/forged`),
      answered: await previewAnswer(socket, `${answer}/first`),
    };
  } finally {
    socket.close('forged');
  }
}

const SLATE_UI_DRAWN = `document.querySelectorAll('[data-slate-ui] iframe[src]').length === ${String(Object.keys(SLATE_UI_PAGES).length)}`;

/** Each drawn block's name and the text its frame's page shows, once it shows any. */
async function slateUiFrames(page: Page): Promise<{ drawn: string[]; shown: Record<string, string> }> {
  const cards = await page.$$eval('[data-slate-ui]', (found) => found.map((card) => ({
    name: card.getAttribute('data-slate-ui') ?? '', src: card.querySelector('iframe')?.getAttribute('src') ?? '',
  })));

  const shown: Record<string, string> = {};

  for (const { name, src } of cards) {
    const origin = new URL(src).origin;
    const frame = await named(`the ${name} frame`, () => page.waitForFrame((each) => each.url().startsWith(origin)));

    await named(`the ${name} page's words`, () => frame.waitForFunction(() => document.querySelector('[data-words]') !== null));
    shown[name] = await frame.evaluate(() => document.querySelector('[data-words]')?.textContent ?? '');
  }

  return { drawn: cards.map((card) => card.name), shown };
}

/** The first page's frame, once it has read the file through `workspace`: what it read, and whether its click then
 *  reaches the agent. */
async function firstPageReach(page: Page, heard: Promise<ScriptedRequest>): Promise<{ read: string; heard: boolean; kept: boolean }> {
  const src = await page.$eval('[data-slate-ui="first"] iframe', (frame) => frame.getAttribute('src') ?? '');
  const frame = await page.waitForFrame((each) => each.url().startsWith(new URL(src).origin));

  await named("the first page's read", () => frame.waitForFunction(() => (document.getElementById('read')?.textContent ?? '') !== ''));
  const read = await frame.evaluate(() => document.getElementById('read')?.textContent ?? '');

  // The page's own state, which a page drawn again from scratch would not have.
  await frame.evaluate(() => { document.body.dataset['clicked'] = 'yes'; });
  await frame.click('#send');
  const request = await waitOn(page, 'the click reaching the agent', heard);

  await until(page, 'the click turn to end', `!(${STOP_OFFERED})`);
  // A page drawn again is a new frame, and the one clicked is detached.
  const kept = !frame.detached && await frame.evaluate(() => document.body.dataset['clicked'] === 'yes');

  return { read, heard: request.userTexts.some((text) => text.includes(SLATE_UI_SENT)), kept };
}

/** The first page, opened from its card in the work surface: what the work surface's frame of it shows. */
const RpcFrameSchema = v.object({ type: v.literal('rpc'), id: v.string(), method: v.optional(v.string()) });

/** Settles once a `getExposedPorts` the page asks from now on has been answered on its socket. */
async function previewsListed(page: Page): Promise<() => Promise<void>> {
  const cdp = await page.createCDPSession();
  const asked = new Set<string>();
  const answered = Promise.withResolvers<void>();

  const frame = (payload: string | undefined) => v.safeParse(RpcFrameSchema, tolerate<unknown>(() => JSON.parse(payload ?? ''), 'malformed-input'));

  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameSent', (event: { response?: { payloadData?: string } }) => {
    const sent = frame(event.response?.payloadData);

    if (sent.success && sent.output.method === 'getExposedPorts') asked.add(sent.output.id);
  });
  cdp.on('Network.webSocketFrameReceived', (event: { response?: { payloadData?: string } }) => {
    const reply = frame(event.response?.payloadData);

    if (reply.success && asked.has(reply.output.id)) answered.resolve();
  });

  return async () => {
    await named("the workspace's previews listed", () => answered.promise);
    await cdp.detach();
  };
}

/** Every page the work surface's bar holds, those behind its opener among them. */
async function pageTabs(page: Page): Promise<readonly string[]> {
  await painted(page);

  return v.parse(v.array(v.string()), await page.evaluate(PAGE_TABS));
}

async function openedInWorkSurface(page: Page): Promise<string> {
  await page.$eval('[data-slate-ui="first"] button[aria-label="Open first in the work surface"]', (open) => {
    if (open instanceof HTMLElement) open.click();
  });

  const pane = await named('the first page in the work surface', () => page.waitForSelector('#inspector iframe[title$="/first"]'));
  const frame = await named("the work surface frame's document", async () => await pane?.contentFrame() ?? null);

  if (frame === null) throw new Error('the work surface frame has no document');
  await named("the work surface page's words", () => frame.waitForFunction(() => document.querySelector('[data-words]') !== null));

  return await frame.evaluate(() => document.querySelector('[data-words]')?.textContent ?? '');
}

/** An answer with two blocks is drawn as two slates, each its own page, and a reload draws them again from the stored answer. */
async function measureSlateUi(newPage: LiveApp['newPage'], origin: string, heard: Promise<ScriptedRequest>): Promise<SlateUiVerdict> {
  const workspace = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-row-slate-ui-${RUN_ID}`, purpose: 'slate ui probe', model: SCRIPTED_MODEL_SPEC });
  const page = await openRecorded(newPage, origin, workspace);

  try {
    await sendInChat(page, SLATE_UI_ASK);
    await until(page, 'both blocks drawn', `${SLATE_UI_DRAWN} && !(${STOP_OFFERED})`);
    const first = await slateUiFrames(page);
    const reach = await firstPageReach(page, heard);
    const opened = await openedInWorkSurface(page);

    // A page opened while both pages run lists every preview they hold.
    const listed = await previewsListed(page);

    await named('the reload', () => page.reload({ waitUntil: 'load' }));
    await until(page, 'both blocks drawn again', SLATE_UI_DRAWN);
    const again = await slateUiFrames(page);

    await listed();
    const tabs = await pageTabs(page);

    return { ...reach, tabs, opened, drawn: first.drawn, shown: first.shown, redrawn: again.drawn, reshown: again.shown, forged: await forgedBlocks(page, origin, workspace) };
  } finally {
    await page.close();
  }
}

/** Presses the button showing `words` among those `buttons` selects. */
async function pressButton(page: Page, buttons: string, words: string): Promise<void> {
  await page.$$eval(buttons, (found, label) => {
    const button = found.find((each) => each.textContent?.trim() === label);

    if (button instanceof HTMLElement) button.click();
  }, words);
}

/** The plan's tasks, from the turn an approval hands off. A chore added before any plan stays apart from it; the
 *  approved plan's step, its subtask and a step a program adds are the plan's, the subtask under its step. */
async function measurePlanTasks(newPage: LiveApp['newPage'], origin: string): Promise<PlanTasksVerdict> {
  const workspace = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-row-plan-tasks-${RUN_ID}`, purpose: 'plan tasks probe', model: SCRIPTED_MODEL_SPEC });
  const page = await openRecorded(newPage, origin, workspace);

  try {
    await sendInChat(page, PLAN_TASKS_CHORE);
    await until(page, 'the chore turn to end', TURN_ANSWERED);
    // The modes hold still while the composer is busy, and a turn can open between the offer and a press, which is
    // then lost: Plan is pressed each time it is offered until it holds.
    await until(page, 'Plan chosen', `((plan) => {
      if (plan instanceof HTMLButtonElement && !plan.disabled && plan.getAttribute('aria-pressed') !== 'true') plan.click();

      return plan?.getAttribute('aria-pressed') === 'true';
    })([...document.querySelectorAll('#chat [aria-label="Turn mode"] button')].find((button) => button.textContent?.trim() === 'Plan'))`);
    await sendInChat(page, PLAN_TASKS_PLAN);
    await until(page, "the plan's decisions", `[...document.querySelectorAll('[data-plan-decisions] button')].some((button) => /approve/iu.test(button.textContent ?? '') && !button.disabled)`);
    await page.$$eval('[data-plan-decisions] button', (buttons) => {
      const approve = buttons.find((button) => /approve/iu.test(button.textContent ?? ''));

      if (approve instanceof HTMLElement) approve.click();
    });
    // The handoff turn runs on its own; the row reads the Work list once it has answered, whatever it shows.
    await until(page, "the approved plan's turn to end", `(${ANSWER_BLOCKS}).at(-1) === 'P:Implemented the approved plan.' && !(${STOP_OFFERED})`);
    await page.click('#inspector nav[aria-label="Workspace"] button[aria-label="Work"]');
    await until(page, "the Work tab's plans", `document.querySelector('[data-work-plans]') !== null`);
    await painted(page);

    return {
      plans: v.parse(v.array(v.array(v.tuple([v.string(), v.number()]))), await page.evaluate(PLAN_CARDS)),
      unlinked: v.parse(v.array(v.string()), await page.evaluate(PLANLESS_TASKS)),
    };
  } finally {
    await page.close();
  }
}

/** Main's conversation as the page shows it, at each step of a clear. */
interface ClearedVerdict {
  /** The dialog's alert after Clear was pressed while a turn ran; null if the dialog closed without one. */
  readonly refusal: string | null;
  /** Whether the ask was still in the chat after the refusal, and after a reload once the turn had ended. */
  readonly keptAfterRefusal: boolean;
  readonly keptAfterReload: boolean;
  /** Whether the dialog closed once the turn had ended, the ask gone as it closed, and still gone after a reload. */
  readonly closedWhenIdle: boolean;
  readonly emptiedWhenIdle: boolean;
  readonly emptyAfterReload: boolean;
}

const CLEAR_ANSWERED = `document.querySelector('[role="dialog"] [role="alert"]') !== null || document.querySelector('[role="dialog"]') === null`;

const CHAT_HOLDS_ASK = `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(CLEARED_TURN_ASK)})`;

/** Presses Clear Main and Clear, and reads the dialog once the server has answered: its alert, or null once it
 *  closed. A refused dialog is then cancelled, since a notice left standing ends every later wait. */
async function pressClearMain(page: Page): Promise<string | null> {
  await page.hover('nav[aria-label="Chats"] [data-agent-tab="main"] a');
  await page.click('nav[aria-label="Chats"] [data-agent-tab="main"] button[aria-label="Clear Main"]');
  await until(page, 'the Clear Main dialog', `document.querySelector('[role="dialog"]') !== null`);
  await pressButton(page, '[role="dialog"] button', 'Clear');
  await page.waitForFunction(CLEAR_ANSWERED);
  const refusal = v.parse(v.nullable(v.string()), await page.evaluate(`document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? null`));

  if (refusal !== null) {
    await pressButton(page, '[role="dialog"] button', 'Cancel');
    await page.waitForFunction(`document.querySelector('[role="dialog"]') === null`);
  }

  return refusal;
}

/** Reloads and reads whether the chat holds the ask once the socket's transcript has come in. */
async function reloadHoldsAsk(page: Page): Promise<boolean> {
  await page.reload({ waitUntil: 'load' });
  await until(page, 'the transcript after the reload', 'window.__transcripts > 0');
  await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
  await painted(page);

  return v.parse(v.boolean(), await page.evaluate(CHAT_HOLDS_ASK));
}

/** Release-1 review F4: Clear Main while a turn runs is refused in its dialog and keeps every message, reload or not;
 *  once the turn has ended it empties Main, and a reload finds it empty. */
async function measureCleared(newPage: LiveApp['newPage'], origin: string, held: HeldCall): Promise<ClearedVerdict> {
  const workspace = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-row-clear-${RUN_ID}`, purpose: 'clear probe', model: SCRIPTED_MODEL_SPEC });
  const page = await openRecorded(newPage, origin, workspace);

  try {
    await sendInChat(page, CLEARED_TURN_ASK);
    await answerMidTurn(page);
    const refusal = await pressClearMain(page);
    const keptAfterRefusal = v.parse(v.boolean(), await page.evaluate(CHAT_HOLDS_ASK));

    held.release();
    await until(page, 'the turn to end', TURN_ANSWERED);
    const keptAfterReload = await reloadHoldsAsk(page);
    const closedWhenIdle = await pressClearMain(page) === null;

    // The server's clear frame comes ahead of its answer on the one socket, so the chat is empty as the dialog closes.
    await painted(page);
    const emptiedWhenIdle = !v.parse(v.boolean(), await page.evaluate(CHAT_HOLDS_ASK));

    return { refusal, keptAfterRefusal, keptAfterReload, closedWhenIdle, emptiedWhenIdle, emptyAfterReload: !await reloadHoldsAsk(page) };
  } finally {
    held.release();
    await page.close();
  }
}

/** What the composer's status notices said while a turn or a background call waited on its provider. */
export interface ProviderWaitVerdict {
  /** While the workspace's logo, drawn from Settings, was refused twice more and waited out each refusal. */
  readonly whileLogoWaited: readonly string[];
  /** While a turn's own call waited on its provider. */
  readonly duringTurn: readonly string[];
  /** As that turn's answer ended. */
  readonly afterTurn: readonly string[];
  /** A turn whose provider refused every call for a minute, stating no wait: whether it answered or stopped on the
   *  refusal, and what the composer said while it waited. */
  readonly minute: { readonly answered: boolean; readonly stopped: boolean; readonly notices: readonly string[] };
}

const MINUTE_ANSWERED = `(${ANSWER_BLOCKS}).at(-1) === ${JSON.stringify(`P:${MINUTE_WAITED_OUT}`)} && !(${STOP_OFFERED})`;

/** The minute-limited turn ended, answered or stopped on a recorded failure: the row's turns before it failed none. */
const MINUTE_SETTLED = `(${MINUTE_ANSWERED}) || (document.querySelector('#chat [data-turn-failure]') !== null && !(${STOP_OFFERED}))`;

const COMPOSER_NOTICES = `[...document.querySelectorAll('#chat [data-composer-root] [role="status"]')].map((notice) => (notice.textContent ?? '').trim())`;

/** Every distinct notice text the composer shows, sampled every 50 ms from install into `window.__notices`. */
const RECORD_NOTICES = `(() => {
  window.__notices = [];
  setInterval(() => {
    for (const text of ${COMPOSER_NOTICES}) if (text !== '' && !window.__notices.includes(text)) window.__notices.push(text);
  }, 50);
})()`;

async function noticesRead(page: Page, expression: string): Promise<readonly string[]> {
  return v.parse(v.array(v.string()), await page.evaluate(expression));
}

/** Settings' "Draw a new one": the workspace's logo, drawn by the workspace's own model call, outside any turn. */
async function drawLogoFromSettings(newPage: LiveApp['newPage'], origin: string, workspace: string): Promise<Page> {
  const settings = await newPage();

  await settings.setViewport(DESKTOP);
  await named('the settings page to load', () => settings.goto(`${origin}/workspace/${workspace}/settings`, { waitUntil: 'load' }));
  await until(settings, 'the logo field', `document.querySelector('[data-logo-field] button') !== null`);
  await settings.click('[data-logo-field] button');

  return settings;
}

/** #88: a background call's provider wait (the workspace's logo) never stands over the composer as if a turn were
 *  blocked; a turn's own wait does, counting down to its end and never reading 0s. */
async function measureProviderWait(newPage: LiveApp['newPage'], origin: string, probe: ProviderWaitProbe): Promise<ProviderWaitVerdict> {
  const drawn = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-row-logo-wait-${RUN_ID}`, purpose: LOGO_WAITED_MISSION, model: SCRIPTED_MODEL_SPEC });
  const chat = await openRecorded(newPage, origin, drawn);
  let whileLogoWaited: readonly string[];

  try {
    await chat.evaluate(RECORD_NOTICES);
    const refused = probe.logoRefused(2);
    const settings = await drawLogoFromSettings(newPage, origin, drawn);

    // The second refusal comes once the first one's wait is over: that wait was told to the chat, or never.
    await named('the logo to be refused twice more', () => refused);
    whileLogoWaited = await noticesRead(chat, 'window.__notices');
    await settings.close();
  } finally {
    await chat.close();
  }

  const waited = await createWorkspace(origin, LOOPBACK_IDENTITY, { name: `live-row-turn-wait-${RUN_ID}`, purpose: 'turn wait probe', model: SCRIPTED_MODEL_SPEC });
  const page = await openRecorded(newPage, origin, waited);

  try {
    await page.evaluate(RECORD_NOTICES);
    await sendInChat(page, WAITED_TURN_ASK);
    await until(page, 'the waited turn to answer', TURN_ANSWERED);
    const duringTurn = await noticesRead(page, 'window.__notices');
    const afterTurn = await noticesRead(page, COMPOSER_NOTICES);

    await page.evaluate(RECORD_NOTICES);
    await sendInChat(page, MINUTE_LIMITED_ASK);
    // A stopped turn is an outcome here, not a dead end: `until` would end the row on it.
    await named('the minute-limited turn to settle', () => page.waitForFunction(MINUTE_SETTLED, { polling: 100 }));

    const minute = {
      answered: v.parse(v.boolean(), await page.evaluate(MINUTE_ANSWERED)),
      stopped: v.parse(v.boolean(), await page.evaluate(`document.querySelector('#chat [data-turn-failure]') !== null`)),
      notices: await noticesRead(page, 'window.__notices'),
    };

    return { whileLogoWaited, duringTurn, afterTurn, minute };
  } finally {
    await page.close();
  }
}

/** Row 7: the run's own state directory, measured on the local server in both
 *  modes — the question is what the harness booted on, not what a deployment
 *  holds. The roster read goes through UserDO, so its namespace directory is
 *  written by the time the plugin's tree below is listed. */
async function measureState(app: LiveApp): Promise<StateVerdict> {
  const foreign = (await listWorkspaces(app.origin, LOOPBACK_IDENTITY)).map((row) => row.name).filter((name) => !name.includes(RUN_ID));
  const tree = join(app.statePath, 'v3', 'do');

  return {
    root: app.statePath,
    namespaces: existsSync(tree) ? readdirSync(tree).sort() : [],
    foreign,
  };
}

/** A row a file can run, by the name its log line carries, in the order the suite ran them. */
export const LIVE_ROWS = [
  'live-indicator', 'opened-mid-turn', 'reconnect', 'observed-reconnect', 'unanswered-probe', 'slept', 'watched-slept', 'answered',
  'unsent-answer', 'controls', 'walkthrough', 'own-server', 'kept-tab', 'chat-scroll', 'mid-thought', 'dropped-file', 'cleared', 'plan-tasks',
  'slate-ui', 'provider-wait', 'state',
] as const;

export type LiveRow = (typeof LIVE_ROWS)[number];

/** What a row file holds: every verdict (null until its row ran), the reader that turns a missing one into the
 *  failure it names, and the boot that runs the file's rows before its first test. */
export interface LiveRows extends Pick<RowVerdicts, 'verdictOf'> {
  readonly observed: TierVerdicts;
  readonly boot: () => Promise<void>;
}

/**
 * The rows `rows` names, run in `LIVE_ROWS` order against one dev server and one scripted model, as `suite`. The
 * script answers every row's turns, whichever run (the live-indicator row's paced turn, the mid-turn row's paced
 * first turn, the kept-tab row's two asks, every row's throwaway turn with prose, the walkthrough's turns with the
 * plan and the slate): one server, decided per request.
 */
export function liveRows(suite: string, rows: readonly LiveRow[]): LiveRows {
  const observed: TierVerdicts = {
    liveIndicator: null, openedMidTurn: null, reconnect: null, observedReconnect: null, unansweredProbe: null, slept: null, watchedSlept: null, answered: null,
    unsentAnswer: null, bootFailure: null,
    controls: null, walkthrough: null, ownServer: null, keptTab: null, chatScroll: null, midThought: null, droppedFile: null, cleared: null, planTasks: null, slateUi: null, providerWait: null, state: null,
  };

  // Set once the dev server is up: a row that breaks names the file its server's output is kept in.
  let keepOutput: (() => string) | null = null;

  const { attempt, verdictOf, broken } = rowVerdicts(suite, () => observed.bootFailure,
    () => keepOutput === null ? null : `the dev server's output: ${keepOutput()}`);

  async function run(): Promise<void> {
    const firstTurn = heldCall();
    const reconnectHeld = heldCall();
    const observedHeld = heldCall();
    const sleptHeld = heldCall();
    const answeredHeld = heldCall();
    const watchedSleptHeld = heldCall();
    const watchedAnswerHeld = heldCall();
    const unsentHeld = heldCall();
    const clearedHeld = heldCall();
    const probeWaitHeld = heldCall();
    const toldBack = Promise.withResolvers<ScriptedRequest>();
    const slateHeard = Promise.withResolvers<ScriptedRequest>();
    const waitProbe = new ProviderWaitProbe();

    // The watched turn follows the answered one in its conversation, so it is matched first, by the latest ask.
    const model = await startScriptedModel((request) => providerWaitTurn(request, waitProbe) ?? droppedFileTurn(request) ?? toldBackTurn(request, toldBack.resolve) ?? pacedTurn(request)
      ?? laterReconnectTurn(request, WATCHED_ANSWER_TURN_ASK, watchedAnswerHeld)
      ?? pacedFirstTurn(request, firstTurn) ?? reconnectTurn(request, ANSWERED_TURN_ASK, answeredHeld)
      ?? reconnectTurn(request, RECONNECT_TURN_ASK, reconnectHeld) ?? reconnectTurn(request, OBSERVED_TURN_ASK, observedHeld)
      ?? reconnectTurn(request, UNANSWERED_PROBE_TURN_ASK, probeWaitHeld)
      ?? reconnectTurn(request, SLEPT_TURN_ASK, sleptHeld) ?? reconnectTurn(request, WATCHED_SLEPT_TURN_ASK, watchedSleptHeld, true)
      ?? unsentFirstTurn(request, unsentHeld) ?? reconnectTurn(request, CLEARED_TURN_ASK, clearedHeld)
      ?? keptTabProbe(request) ?? thinkingTurn(request) ?? planTasksProbe(request) ?? slateUiTurn(request, slateHeard.resolve) ?? planWalkthrough(request));

    await withLiveApp(async (app) => {
      const { newPage, origin } = app;

      keepOutput = app.keepOutput;

      const measures: Record<LiveRow, () => Promise<void>> = {
        'live-indicator': async () => { observed.liveIndicator = await attempt('live-indicator', () => measureLiveIndicator(newPage, origin)); },
        'opened-mid-turn': async () => { observed.openedMidTurn = await attempt('opened-mid-turn', () => measureOpenedMidTurn(newPage, origin, firstTurn)); },
        'reconnect': async () => { observed.reconnect = await attempt('reconnect', () => measureReconnect(newPage, origin, reconnectHeld)); },
        'unanswered-probe': async () => {
          observed.unansweredProbe = await attempt('unanswered-probe', () => measureUnansweredProbe(newPage, origin, probeWaitHeld));
        },
        'observed-reconnect': async () => {
          observed.observedReconnect = await attempt('observed-reconnect', () => measureObservedReconnect(newPage, origin, observedHeld));
        },
        'slept': async () => { observed.slept = await attempt('slept', () => measureSlept(newPage, origin, sleptHeld)); },
        'watched-slept': async () => { observed.watchedSlept = await attempt('watched-slept', () => measureWatchedSlept(newPage, origin, watchedSleptHeld)); },
        'answered': async () => {
          observed.answered = await attempt('answered', () => measureAnswered(
            newPage, origin, { answered: answeredHeld, watched: watchedAnswerHeld }, toldBack.promise));
        },
        'unsent-answer': async () => { observed.unsentAnswer = await attempt('unsent-answer', () => measureUnsentAnswer(newPage, origin, unsentHeld)); },
        'controls': async () => { observed.controls = await attempt('controls', () => measureControls(newPage, origin)); },
        'walkthrough': async () => { observed.walkthrough = await attempt('walkthrough', () => measureWalkthrough(newPage, origin)); },
        'own-server': async () => { observed.ownServer = await attempt('own-server', () => measureOwnServer(newPage, origin)); },
        'kept-tab': async () => { observed.keptTab = await attempt('kept-tab', () => measureKeptTab(newPage, origin)); },
        'chat-scroll': async () => { observed.chatScroll = await attempt('chat-scroll', () => measureChatScroll(newPage, origin)); },
        'mid-thought': async () => { observed.midThought = await attempt('mid-thought', () => measureMidThought(newPage, origin)); },
        'dropped-file': async () => { observed.droppedFile = await attempt('dropped-file', () => measureDroppedFile(newPage, origin)); },
        'cleared': async () => { observed.cleared = await attempt('cleared', () => measureCleared(newPage, origin, clearedHeld)); },
        'plan-tasks': async () => { observed.planTasks = await attempt('plan-tasks', () => measurePlanTasks(newPage, origin)); },
        'slate-ui': async () => { observed.slateUi = await attempt('slate-ui', () => measureSlateUi(newPage, origin, slateHeard.promise)); },
        'provider-wait': async () => { observed.providerWait = await attempt('provider-wait', () => measureProviderWait(newPage, origin, waitProbe)); },
        'state': async () => { observed.state = await attempt('state', () => measureState(app)); },
      };

      await registerScriptedModel(origin, model.baseURL);

      for (const row of LIVE_ROWS.filter((name) => rows.includes(name))) await measures[row]();
    });

    await model.stop();
  }

  return {
    observed,
    verdictOf,
    boot: async () => {
      try {
        await run();
      } catch (cause) {
        observed.bootFailure = renderThrownChain({ cause });
      }

      // Every measured number into the run's own log, the ones no assertion reads
      // included: a red is read with its figures, and a green prints what it saw.
      process.stderr.write(`${suite} verdicts: ${JSON.stringify({ observed, broke: broken() }, null, 2)}\n`);
    },
  };
}
