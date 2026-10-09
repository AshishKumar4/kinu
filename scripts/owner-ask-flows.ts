/**
 * The owner's asks of 2026-10-08 as product flows (`docs/research/REQUESTS-LEDGER.md`, 1008-c, e, g, ac, ad, ao, ar):
 * each drives the deployment's own pages in Chrome as the owner would, on the tiers' scripted model
 * (`scripts/flows-script.ts`), and returns what the page showed for the suite to judge.
 */
import type { ElementHandle, Frame, Page } from 'puppeteer';
import * as v from 'valibot';
import {
  CONTINUE, CONTINUED, FEEDBACK_HEARD, HIRED, HOME_ASK, HOME_REPORTED, INTERRUPTED_BRIEF, PIN_ASK, PIN_PAGE, PLAN_COMMENT,
  PLAN_COMMENT_ASK, REACH_REPLY, REACH_SLATE, REACH_SLATE_ASK, REACH_STREAM, THREAD_REPLY,
} from './flows-script';
import {
  CHAT_IDLE, CHATS, createFlowWorkspace, frameLedger, openInspector, openWorkspacePage, PAGE_TABS, removeFlowWorkspace, sendAndSettle,
  settled, settledAfter, signedInPage, startNewChat, until, waitOn, type FlowTarget,
} from './product-flows';
import { webHeaders } from '../evals/src/session';

const ChatTextSchema = v.string();

/** What the chat column says now, as a person reads it. */
async function chatText(page: Page): Promise<string> {
  return v.parse(ChatTextSchema, await page.evaluate(`document.querySelector('#chat')?.innerText ?? ''`));
}

export interface PinVerdict {
  /** The slate the pin kept the page as, by its directory; null when the pin never answered. */
  readonly kept: string | null;
  /** The pin's accessible name once it answered. */
  readonly keptName: string;
  /** The workspace's slates as the account lists them (`GET /api/shared`), each by its directory and title: the
   *  Pages strip shows an answer's page whether or not it was kept, so it is no receipt. */
  readonly listed: readonly string[];
}

/** In the page: the account's own slates in `workspace`, each as `<id> <title>`, from the route My stuff reads. */
function slatesOf(workspace: string): string {
  return `(async () => {
    const answer = await fetch('/api/shared');
    if (!answer.ok) return [];
    const { slates } = await answer.json();
    return slates.filter((slate) => slate.workspace === ${JSON.stringify(workspace)}).map((slate) => slate.id + ' ' + slate.title);
  })()`;
}

const KeptSchema = v.object({ id: v.nullable(v.string()), name: v.string() });

/**
 * Row (1008-c): a page an answer draws in the chat is kept, by its pin, as a slate of the workspace. The answer's
 * `<slate-ui>` card is pinned as a person would, hovering it to show its controls; the slate it became is then one of
 * the workspace's pages, under the page's own title.
 */
export async function pinKeepsAnInChatPage(target: FlowTarget): Promise<PinVerdict> {
  const workspace = await createFlowWorkspace(target, 'pin');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);
    const card = `[data-slate-ui="${PIN_PAGE.name}"]`;

    await sendAndSettle(page, PIN_ASK);
    await until(page, 'the page the answer drew in the chat', `document.querySelector(${JSON.stringify(`${card} button[data-slate-save]`)}) !== null`);
    await page.hover(card);
    await page.click(`${card} button[data-slate-save]`);
    await until(page, 'the pin, answered', `document.querySelector(${JSON.stringify(`${card} button[data-slate-saved]`)}) !== null`);

    const kept = v.parse(KeptSchema, await page.$eval(`${card} button[data-slate-saved]`, (button) => ({
      id: button.getAttribute('data-slate-saved'), name: button.getAttribute('aria-label') ?? '',
    })));

    const receipt = `${kept.id ?? ''} ${PIN_PAGE.title}`;

    await waitOn(page, "the kept page among the workspace's slates", page.waitForFunction(`${slatesOf(workspace)}.then((listed) => listed.includes(${JSON.stringify(receipt)}))`, { polling: 500 }));

    return { kept: kept.id, keptName: kept.name, listed: v.parse(v.array(v.string()), await page.evaluate(slatesOf(workspace))) };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface TitledChatVerdict {
  /** Whether the brief's turn offered Stop and stopped on it. */
  readonly stopped: boolean;
  /** Whether Continue's turn answered. */
  readonly continued: boolean;
  /** The chat's tab, once Continue's turn ended. */
  readonly title: string;
}

/** The current chat's tab in the workspace bar, as it reads. */
const CURRENT_CHAT_TAB = `(document.querySelector('${CHATS} a[aria-current="page"] .p-status-label')?.textContent ?? '').trim()`;

const STOP = '#chat button[aria-label="Stop this turn"]';

/**
 * Row (1008-e): a chat is named from its brief, its first words, even when its first turn is stopped and the owner
 * then says Continue: the owner's chat was titled "Continue" (2026-10-08). The brief's turn is slow to its first
 * token, so its Stop is there to press.
 */
export async function chatTitledFromItsBrief(target: FlowTarget): Promise<TitledChatVerdict> {
  const workspace = await createFlowWorkspace(target, 'titled-chat');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await page.click(`${CHATS} a[aria-label="New chat"]`);
    await until(page, 'the new-chat question', `document.querySelector('[data-new-chat] textarea') !== null`);
    await page.type('[data-new-chat] textarea', INTERRUPTED_BRIEF);
    await page.click('[data-new-chat] button[type="submit"]');
    await until(page, "the new chat's page", `location.pathname.includes('/agents/')`);
    await until(page, "Stop, while the brief's turn runs", `[...document.querySelectorAll(${JSON.stringify(STOP)})].some((button) => button.getClientRects().length > 0)`);
    await page.click(STOP);
    await until(page, "the stopped turn's end, Send offered again", CHAT_IDLE);
    await sendAndSettle(page, CONTINUE);
    await until(page, "the chat's tab, named", `${CURRENT_CHAT_TAB} !== ''`);
    await settled(page, CURRENT_CHAT_TAB);

    return {
      stopped: true,
      continued: (await chatText(page)).includes(CONTINUED),
      title: v.parse(v.string(), await page.evaluate(CURRENT_CHAT_TAB)),
    };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface HireHomeVerdict {
  /** The name the hire was given, as Main read it off the hire's answer. */
  readonly hired: string;
  /** The working directory the hire's own shell reported, as Main relayed it. */
  readonly home: string;
}

/**
 * Row (1008-g): a hire is named, and lives in /home/<its name>, not /home/sub-<uuid>. Main hires on the owner's ask;
 * the hire runs `pwd` in its own shell and reports it; Main relays the report into the owner's chat.
 */
export async function hireLivesUnderItsName(target: FlowTarget): Promise<HireHomeVerdict> {
  const workspace = await createFlowWorkspace(target, 'hire-home');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await sendAndSettle(page, HOME_ASK);
    await until(page, "the hire's home, relayed by Main", `(document.querySelector('#chat')?.innerText ?? '').includes(${JSON.stringify(HOME_REPORTED)})`);

    const said = await chatText(page);

    return {
      hired: new RegExp(`${HIRED} (\\S+)`, 'u').exec(said)?.[1] ?? '',
      home: new RegExp(`${HOME_REPORTED} (\\S+)`, 'u').exec(said)?.[1] ?? '',
    };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

/** One stream read off the slate's page: what it showed while the answer was still coming, and at its end. */
export interface StreamRead {
  /** The page's text while it said streaming and held the answer's lead without its end. */
  readonly partway: string | null;
  readonly final: string;
  readonly state: string;
}

export interface SlateReachVerdict {
  /** `ai.stream` from the slate's server, read in its page. */
  readonly modelStream: StreamRead;
  /** `agent.ask` from the slate's server: the agent's own reply, read in its page. */
  readonly agentStream: StreamRead;
  /** What the slate's hire answered its page, its owner's. */
  readonly ownerHire: string;
  /** What the same hire answered a viewer of the slate's public share link, signed out; null when no link was made. */
  readonly viewerHire: string | null;
}

const StreamStateSchema = v.object({ state: v.string(), text: v.string() });

/** Press `control` in the slate's page and read the stream it starts: a look while it streams, then its end. */
async function streamed(page: Page, frame: Frame, control: string, answer: { readonly lead: string; readonly end: string }): Promise<StreamRead> {
  const read = async () => v.parse(StreamStateSchema, await frame.evaluate(`({
    state: document.querySelector('[data-stream-state]')?.textContent ?? '', text: document.querySelector('[data-stream-text]')?.textContent ?? '',
  })`));

  await frame.click(control);

  // The answer's lead comes alone, then a pause: a page that showed it only at the end held the stream back.
  const partway = await waitOn(page, `the lead of ${control}'s stream, alone`, frame.waitForFunction((lead, end) => {
    const text = document.querySelector('[data-stream-text]')?.textContent ?? '';

    return text.includes(lead) && !text.includes(end) ? text : false;
  }, { polling: 100 }, answer.lead.trim(), answer.end).then(async (handle) => v.parse(v.string(), await handle.jsonValue())));

  await waitOn(page, `${control}'s stream, ended`, frame.waitForFunction(`document.querySelector('[data-stream-state]')?.textContent !== 'streaming'`, { polling: 100 }));

  const end = await read();

  return { partway, final: end.text, state: end.state };
}

/**
 * Row (1008-ac, 1008-ad): a slate streams answers as they are written, the model's through `ai.stream` and the
 * agent's own reply through `agent.ask`, and its owner's slate may hire a helper. The slate is built by a turn; its
 * page is opened from the Pages strip, as the owner opens it.
 */
export async function slateStreamsAndHires(target: FlowTarget): Promise<SlateReachVerdict> {
  const workspace = await createFlowWorkspace(target, 'slate-reach');
  let share: { readonly id: string } | null = null;

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);
    const ledger = await frameLedger(page);

    await sendAndSettle(page, REACH_SLATE_ASK);
    await settledAfter(page, ledger);
    await ledger.stop();
    await openInspector(page);
    await until(page, "the slate's tab", `${PAGE_TABS}.includes(${JSON.stringify(REACH_SLATE.title)})`);
    await page.click(`#inspector nav[aria-label="Pages"] button[aria-label="${REACH_SLATE.title}"]`);

    const frameSelector = `#inspector iframe[title="${REACH_SLATE.id}"]`;

    await until(page, "the slate's frame", `document.querySelector(${JSON.stringify(frameSelector)}) !== null`);
    const frame = await frameOf(page, frameSelector);

    await waitOn(page, "the slate's page to draw", frame.waitForFunction('document.querySelector("[data-stream-ai]") !== null', { polling: 100 }));

    const modelStream = await streamed(page, frame, '[data-stream-ai]', REACH_STREAM);
    const agentStream = await streamed(page, frame, '[data-stream-ask]', REACH_REPLY);

    const ownerHire = await hired(page, frame);

    const made = await sharedPublicly(target, workspace);

    share = made;

    return { modelStream, agentStream, ownerHire, viewerHire: made.url === null ? null : await viewerHired(target, made.url) };
  } finally {
    if (share !== null) await revokeShare(target, workspace, share.id);
    await removeFlowWorkspace(target, workspace);
  }
}

/** Press the slate page's Hire, and read what it answered. */
async function hired(page: Page, frame: Frame): Promise<string> {
  await frame.click('[data-hire]');
  await waitOn(page, "the slate's hire, answered", frame.waitForFunction(`(document.querySelector('[data-hire-result]')?.textContent ?? '') !== ''`, { polling: 100 }));

  return v.parse(v.string(), await frame.evaluate(`document.querySelector('[data-hire-result]')?.textContent ?? ''`));
}

const SharedSchema = v.object({ id: v.string(), url: v.nullable(v.string()) });

/** The reach slate shared with anyone who has the link, from its tile in My stuff: the share and its link. */
async function sharedPublicly(target: FlowTarget, workspace: string): Promise<v.InferOutput<typeof SharedSchema>> {
  const page = await signedInPage(target.browser, target.identity);
  const tile = `[data-drive-slate="${REACH_SLATE.id}"][data-drive-workspace="${workspace}"]`;

  await page.goto(`${target.origin}/drive`, { waitUntil: 'load' });
  await until(page, "the slate's tile in My stuff", `document.querySelector(${JSON.stringify(tile)}) !== null`);
  await page.click(`${tile} [data-drive-menu]`);
  await page.click(`${tile} [data-drive-share-slate]`);
  await until(page, 'the share dialog', `document.querySelector('[data-share-access]') !== null`);
  await page.click('[data-share-access]');
  await page.click('[data-share-access-option="public"]');
  await page.click('[data-share-submit]');
  await until(page, 'the share, made', `document.querySelector('[data-share-created]') !== null`);

  const url = v.parse(v.nullable(v.string()), await page.evaluate(`document.querySelector('[role="dialog"] a[href]')?.href ?? null`));
  const listed = await fetch(`${target.origin}/api/shared`, { headers: webHeaders(target.identity) });

  if (!listed.ok) throw new Error(`listing the account's shares answered ${String(listed.status)}`);

  const id = v.parse(SharesSchema, await listed.json()).mine
    .find((row) => row.kind === 'live' && row.workspace === workspace && row.slate === REACH_SLATE.id)?.share;

  await page.close();

  if (id === undefined) throw new Error('the share was made, but the workspace lists no live share');

  return { id, url };
}

/** The account's shares (`GET /api/shared`): each of its own by kind, workspace and slate, and the share's id. */
const SharesSchema = v.looseObject({
  mine: v.array(v.looseObject({ share: v.string(), kind: v.string(), workspace: v.optional(v.string()), slate: v.optional(v.string()) })),
});

/** Open `url` signed out, as anyone with the link, and press the slate page's Hire there. */
async function viewerHired(target: FlowTarget, url: string): Promise<string> {
  const context = await target.browser.createBrowserContext();

  try {
    const viewer = await context.newPage();

    await viewer.goto(url, { waitUntil: 'load' });
    await until(viewer, "the shared slate's page", `document.querySelector('[data-hire], iframe') !== null`);
    const framed = await viewer.$('iframe');
    const frame = framed === null || await viewer.$('[data-hire]') !== null ? viewer.mainFrame() : await frameOf(viewer, 'iframe');

    await waitOn(viewer, "the shared slate's Hire", frame.waitForSelector('[data-hire]'));

    return await hired(viewer, frame);
  } finally {
    await context.close();
  }
}

async function revokeShare(target: FlowTarget, workspace: string, share: string): Promise<void> {
  const left = await fetch(`${target.origin}/api/shared/revoke`, {
    method: 'POST', headers: { ...webHeaders(target.identity), 'content-type': 'application/json' }, body: JSON.stringify({ workspace, share }),
  });

  if (!left.ok) console.warn(`owner-ask-flows: revoking ${share} answered ${String(left.status)}`);
}

/** The page a frame element holds, once it holds a document of its own. */
async function frameOf(page: Page, selector: string): Promise<Frame> {
  const element: ElementHandle | null = await page.$(selector);
  const frame = await element?.contentFrame();

  if (frame === null || frame === undefined) throw new Error(`${selector} holds no frame`);

  // The frame first holds its initial about:blank, which is already complete and empty.
  await waitOn(page, "the slate's page to load", frame.waitForFunction('location.href !== "about:blank" && document.readyState === "complete"', { polling: 100 }));

  return frame;
}

export interface PlanCommentVerdict {
  /** Whether the review admitted the comment on the whole plan: no refusal showed, and Request changes opened. */
  readonly commentAdmitted: boolean;
  /** What the agent said once the request for changes woke it. */
  readonly heard: string;
  /** The replies the comment's thread shows once the agent answered. */
  readonly threadReplies: readonly string[];
}

const PLAN_DECISION = (label: string) => `[...document.querySelectorAll('#inspector [data-plan-decisions] button')]
  .find((button) => (button.textContent ?? '').includes(${JSON.stringify(label)}))`;

const PLAN_MODE = `[...document.querySelectorAll('#chat [aria-label="Turn mode"] button')].find((button) => /^plan$/iu.test(button.textContent?.trim() ?? ''))`;

const GLOBAL_COMMENT_DIALOG = '[role="dialog"][aria-label="Global plan comment"]';

/** Each reply the comment threads show, by its text. */
const THREAD_REPLIES = `[...document.querySelectorAll('[data-annotation-panel="true"] [data-comment-reply]')].map((reply) => (reply.textContent ?? '').trim())`;

/**
 * Row (1008-ao, 1008-ar): a comment on the whole plan, with no block under it, reaches the agent when the owner
 * requests changes (it was refused, "annotation 0 requires id and blockId"), and the agent answers it in the
 * comment's own thread, where the owner reads it.
 */
export async function planCommentReachesTheAgent(target: FlowTarget): Promise<PlanCommentVerdict> {
  const workspace = await createFlowWorkspace(target, 'plan-comment');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    // In an agent's pane, as the agent-plan row reviews: a Plan ask sent while Main's opening runs steers it.
    await startNewChat(page);
    await page.evaluate(`${PLAN_MODE}?.click()`);
    await until(page, 'the composer in Plan', `${PLAN_MODE}?.getAttribute('aria-pressed') === 'true'`);
    await sendAndSettle(page, PLAN_COMMENT_ASK);
    await until(page, 'the plan, decidable beside the chat', `${PLAN_DECISION('Approve')}?.disabled === false`);

    await page.evaluate(`[...document.querySelectorAll('#inspector button')].find((button) => button.textContent?.trim() === 'Global comment')?.click()`);
    await until(page, 'the global comment box', `document.querySelector(${JSON.stringify(`${GLOBAL_COMMENT_DIALOG} textarea`)}) !== null`);
    await page.type(`${GLOBAL_COMMENT_DIALOG} textarea`, PLAN_COMMENT);
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await until(page, 'the global comment, sent', `document.querySelector(${JSON.stringify(GLOBAL_COMMENT_DIALOG)}) === null`);
    await until(page, 'Request changes, open once the comment saved', `${PLAN_DECISION('Request changes')}?.disabled === false`);

    const commentAdmitted = await page.evaluate(`document.querySelector('#inspector [role="alert"]') === null`) === true;

    await page.evaluate(`${PLAN_DECISION('Request changes')}?.click()`);
    await until(page, "the agent's answer to the request", `(document.querySelector('#chat')?.innerText ?? '').includes(${JSON.stringify(FEEDBACK_HEARD)})`);
    await until(page, 'Send offered again', CHAT_IDLE);

    const heard = (await chatText(page)).split('\n').find((line) => line.includes(FEEDBACK_HEARD))?.trim() ?? '';

    await page.click('#inspector [data-plan-comments-toggle]');
    await until(page, "the comment's thread, answered", `${THREAD_REPLIES}.some((reply) => reply.includes(${JSON.stringify(THREAD_REPLY)}))`);

    return { commentAdmitted, heard, threadReplies: v.parse(v.array(v.string()), await page.evaluate(THREAD_REPLIES)) };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}
