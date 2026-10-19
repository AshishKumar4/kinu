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
import type { Page } from 'puppeteer';
import * as v from 'valibot';
import { AccountMemoryProposalSchema, CHANGES_MOVED_EVENT, executorLabel, SLATES_ROOT, type AccountMemoryProposal } from '@kinu.run/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalWorkspaceName, scratchDir } from '@kinu.run/test-utils';
import { signedInPage } from '../evals/src/browser';
import { listWorkspaces, webHeaders } from '../evals/src/workspace-roster';
import { DESKTOP_COLOURS, DESKTOP_PANEL, DESKTOP_SIZE } from '../packages/devbox/src/desktop';
import {
  AGENT_PLAN_ASK, FLOW_MEMORY_NOTE, FLOW_SHELL_PROBE, FLOW_SLATE, MEMORY_ASK, SLATE_ASK, STORM_ASK, STORM_DIR, STORM_FILES, STORM_SEED_ASK, WRITE_FILE_ASK,
  JOB_ASK, JOB_NOT_STARTED, JOB_STARTED,
  APPROVALS_ASK, DECISION_HEARD, HIRE_APPROVAL_ASK, HIRE_RAN, PROPOSAL_LINK_REPLY, WORKSPACE_PROPOSAL_ASK, ACCOUNT_FACT, ACCOUNT_FACT_ASK,
  ACCOUNT_RECALL_ASK, ACCOUNT_RECALL_REPLY, STACK_FACT, STACK_FACT_ASK, STACK_RECALL_ASK, STACK_RECALL_REPLY,
  SPLICE_HEARD, SPLICE_PAGE_ASK, SPLICE_SENT, SPLICE_STEPS, SPLICE_WORK_ASK,
} from './flows-script';
import { FALLBACK_ANSWER } from './scripted-protocol';
import {
  ACTIVE_TAB_INDEX, CHATS, CHAT_COMPOSER_LIVE, CHAT_IDLE, FILES_FAILURE, type FlowTarget, type FrameLedger, INSPECTOR_WIDTH, PAGE_TABS, type RpcCounts, type SendSite, countRpc, createFlowWorkspace, frameLedger, openInspector, openInspectorPage, openSlateShareDialog, openWaits, openWorkspacePage, pagesTraffic, painted, recordRenderTasks, removeFlowWorkspace, rendered, sendAndSettle, sendInChat, sessionLine, settled, settledAfter, startNewChat, submitPublicSlateShare, typeIntoComposer, until, waitOn,
} from './browser-page';


/** The waits open now, `; `-joined: what a row stopped for being silent was waiting on (`endedNearSilence`). */
export function openWaitsNamed(): string {
  const traffic = pagesTraffic();

  return [...openWaits].map((pending) => pending.what).join('; ') + (traffic === '' ? '' : `\n${traffic}`);
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

/** One ping's card as the chat draws it: its delivery mark and the colour it wears, and whether it is drawn inside the
 *  answer rather than as a loose card. */
export interface SpliceCard {
  readonly ping: number;
  readonly state: string | null;
  readonly tone: string | null;
  readonly spliced: boolean;
}

/** The chat as one reading of the page sees the work turn. */
export interface SpliceReading {
  /** Each ping's card drawn, in the chat's reading order. */
  readonly cards: readonly SpliceCard[];
  /** The reading order of each step's words, each ping's card after it, and the answer (-1: not found). */
  readonly order: readonly number[];
  /** Whether the turn was still working. */
  readonly working: boolean;
}

export interface SpliceVerdict {
  /** Once each ping's card is drawn: what the chat showed then. */
  readonly arrivals: readonly SpliceReading[];
  /** Once the turn ended, and again after a reload. */
  readonly answered: SpliceReading;
  readonly reloaded: SpliceReading;
  /** The answer's words: the pings the agent heard, in the order they reached it. */
  readonly heard: string;
}

/** The chat as it draws the work turn, read in the page: each ping's card by the numbered word it carries. */
const SPLICE_READING = `(() => {
  const all = [...document.querySelectorAll('#chat *')];
  const at = (needle) => all.findIndex((el) => (el.textContent ?? '').includes(needle)
    && ![...el.children].some((child) => (child.textContent ?? '').includes(needle)));
  const ping = (el) => Number(new RegExp(${JSON.stringify(`${SPLICE_SENT}-(\\d+)`)}).exec(el.textContent ?? '')?.[1] ?? 0);
  const cards = [...document.querySelectorAll('#chat [data-signal-card]')].filter((el) => ping(el) > 0).map((card) => {
    const mark = card.querySelector('[data-delivery]');

    return {
      ping: ping(card),
      state: mark?.getAttribute('data-delivery') ?? null,
      tone: ['p-warning', 'p-success'].find((name) => mark?.classList.contains(name)) ?? null,
      spliced: card.closest('[data-spliced-signal]') != null,
    };
  });
  const steps = ${JSON.stringify(SPLICE_STEPS)};

  return {
    cards,
    order: [...steps.flatMap((step, i) => [at(step), at(${JSON.stringify(SPLICE_SENT)} + '-' + String(i + 1))]), at(${JSON.stringify(SPLICE_HEARD)})],
    working: !(${CHAT_IDLE}),
  };
})()`;

const SpliceReadingSchema = v.object({
  cards: v.array(v.object({ ping: v.number(), state: v.nullable(v.string()), tone: v.nullable(v.string()), spliced: v.boolean() })),
  order: v.array(v.number()),
  working: v.boolean(),
});

/**
 * Row: a page in the chat sends the agent a word at each step of its work. Each card is drawn as it arrives, while the
 * agent still works, after the words of the step it arrived in; once read, each sits there green, every one of them,
 * and a reload draws them there still (1008-r, 1008-x).
 */
export async function spliceSitsWhereItWasRead(target: FlowTarget): Promise<SpliceVerdict> {
  const workspace = await createFlowWorkspace(target, 'splice');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);
    const reading = async (): Promise<SpliceReading> => v.parse(SpliceReadingSchema, await page.evaluate(SPLICE_READING));
    const chatHas = (words: string): string => `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(words)})`;

    await sendAndSettle(page, SPLICE_PAGE_ASK);
    await until(page, 'the Ping page drawn', `document.querySelector('[data-slate-ui="ping"] iframe') !== null`);
    const src = await page.$eval('[data-slate-ui="ping"] iframe', (frame) => frame.getAttribute('src') ?? '');
    const frame = await page.waitForFrame((each) => each.url().startsWith(new URL(src).origin));

    await frame.waitForSelector('#ping');

    // The work turn: sent, and clicked into once at each step while it waits.
    const composer = await typeIntoComposer(page, SPLICE_WORK_ASK);
    await composer.press('Enter');
    const arrivals: SpliceReading[] = [];

    for (const [index, step] of SPLICE_STEPS.entries()) {
      const sent = `${SPLICE_SENT}-${String(index + 1)}`;

      await until(page, `step ${String(index + 1)} waiting on its build`, chatHas(step));
      await frame.click('#ping');
      await until(page, `ping ${String(index + 1)}'s card`, `[...document.querySelectorAll('#chat [data-signal-card]')].some((el) => (el.textContent ?? '').includes(${JSON.stringify(sent)}))`);
      arrivals.push(await reading());
    }

    await until(page, 'the answer that read the pings', `${chatHas(SPLICE_HEARD)} && ${CHAT_IDLE}`);
    const answered = await reading();
    const heard = v.parse(v.string(), await page.evaluate(`(document.querySelector('#chat')?.innerText ?? '').split('\\n').find((line) => line.includes(${JSON.stringify(SPLICE_HEARD)}))?.trim() ?? ''`));

    await page.reload({ waitUntil: 'load' });
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await until(page, 'the answer drawn again', chatHas(SPLICE_HEARD));
    const again = await reading();

    return { arrivals, answered, reloaded: again, heard };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface ApprovalStackVerdict {
  /** The asks once both commands parked, newest first, as the parked card lists them. */
  readonly stacked: readonly string[];
  /** What the parked card showed before any answer. */
  readonly openWords: string;
  /** The flow's asks once the newer was approved alone. */
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

/**
 * The flow's own card, opened first if another holds the front, as a page expression: the account's other runs raise
 * cards too (account memory reaches every workspace), and one created meanwhile takes the front of a stack no pointer
 * is on, so a card opened in one step can be behind by the next. Each step that touches the card opens it in the
 * same page task.
 */
function ownCard(key: string): string {
  return `(() => {
    const open = () => document.querySelector(${JSON.stringify(`[data-attention-card=${JSON.stringify(key)}]`)});

    if (open() === null) document.querySelector(${JSON.stringify(`[data-attention-behind=${JSON.stringify(key)}]`)})?.click();

    return open();
  })()`;
}

/** Presses `words` on the flow's own card, opening it first if another took the front, until the press lands. */
export async function answerStackCard(page: Page, key: string, words: string): Promise<void> {
  await until(page, `the flow's own card answered ${words}`, `(() => {
    const button = [...(${ownCard(key)}?.querySelectorAll('button') ?? [])].find((each) => each.textContent?.trim() === ${JSON.stringify(words)});

    button?.click();

    return button !== undefined;
  })()`);
}

/**
 * Unticks the parked command `row` on the flow's own batch card `key`, opening it first, until its box stands
 * unticked. On 2026-10-17 a card another run raised took the front between finding the box and pressing it, and the
 * press met a box no longer in the page ("Node is detached from document").
 */
export async function untickOwnRow(page: Page, key: string, row: string): Promise<void> {
  await until(page, `the flow's command ${row} unticked on its own card`, `(() => {
    const box = ${ownCard(key)}?.querySelector(${JSON.stringify(`[data-parked-command=${JSON.stringify(row)}] input`)});

    if (!(box instanceof HTMLInputElement)) return false;
    if (box.checked) box.click();

    return !box.checked;
  })()`);
}

const CHAT_TEXT = `(document.querySelector('#chat')?.textContent ?? '')`;

/** The parked commands the flow's batch card lists, newest first, as their asks' keys. */
const PARKED_ROWS = `[...document.querySelectorAll('[data-attention-card] [data-parked-command]')].map((row) => 'action:' + row.getAttribute('data-parked-command'))`;

/**
 * Row: one turn parks two commands for its owner. They wait together on one card docked to the composer, the newer
 * first; the newer approved alone, the other is its own card, and denying it clears the stack. Each answer reaches the
 * agent: its wake shows in the chat as the event it is, and the agent answers each.
 */
export async function approvalsStackAtTheComposer(target: FlowTarget): Promise<ApprovalStackVerdict> {
  const workspace = await createFlowWorkspace(target, 'approvals');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await sendAndSettle(page, APPROVALS_ASK);
    // Actions belong to this fresh workspace; account-memory cards belong to every workspace of the account. The
    // flow's card is opened first if another took the front.
    await until(page, "both of the flow's parked commands on one card", `(() => {
      if (${PARKED_ROWS}.length === 2) return true;
      ${STACK_KEYS}.filter((key) => key.startsWith('action:')).forEach((key) => document.querySelector('[data-attention-behind="' + key + '"]')?.click());

      return false;
    })()`);
    const stacked = v.parse(v.tuple([v.string(), v.string()]), await page.evaluate(PARKED_ROWS));
    const openWords = v.parse(v.string(), await page.evaluate(`document.querySelector('[data-attention-card]')?.textContent ?? ''`));
    const remaining = `${STACK_KEYS}.filter((key) => ${JSON.stringify(stacked)}.includes(key))`;

    // The older unticked, the newer approved alone.
    await untickOwnRow(page, stacked[0], stacked[1].slice('action:'.length));
    await answerStackCard(page, stacked[0], 'Approve 1');
    // The batch card stands for both under one key until the answer lands, so the other is only alone once it ends.
    await until(page, "the flow's other card remains", `${PARKED_ROWS}.length < 2 && ${remaining}.length === 1`);
    const afterFirst = v.parse(v.array(v.string()), await page.evaluate(remaining));

    await answerStackCard(page, stacked[1], 'Deny');
    await until(page, "the flow's own stack cleared", `${remaining}.length === 0`);
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

/** The proposal's card in the chat's attention stack, where Work's row for it opens it. */
const PROPOSAL_CARD = '#chat [data-workspace-proposal]';

/** A button in the proposal card, by its words. */
function proposalButton(words: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${PROPOSAL_CARD} button`)})].find((button) => ${words}.test(button.textContent ?? ''))?.click()`;
}

/**
 * Row: the workspace's main agent proposes a new workspace, Work → Needs you lists it, its row opens its card in the
 * chat's attention stack, the owner approves it there once, and it exists under the owner's account with the proposed
 * name, while the agent that asked is woken with its link.
 */
export async function agentProposesAWorkspace(target: FlowTarget): Promise<WorkspaceProposalVerdict> {
  const workspace = await createFlowWorkspace(target, 'proposal');
  let created: string | null = null;

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await sendAndSettle(page, WORKSPACE_PROPOSAL_ASK);
    await openInspector(page);
    await page.evaluate(stripTab('Work'));
    await until(page, 'the proposal in Work → Needs you', `document.querySelector('#inspector [data-section="work-needs-you"] [data-pending-action]') !== null`);
    await page.click('#inspector [data-section="work-needs-you"] [data-pending-action]');
    await until(page, "the proposal's card in the chat", `document.querySelector(${JSON.stringify(PROPOSAL_CARD)}) !== null`);
    const cardTitle = v.parse(v.string(), await page.evaluate(`document.querySelector(${JSON.stringify(PROPOSAL_CARD)})?.textContent ?? ''`));

    await page.evaluate(proposalButton('/show its soul/iu'));
    await until(page, 'the soul approving writes', `document.querySelector('[data-workspace-proposal-soul]') !== null`);
    const cardSoul = v.parse(v.string(), await page.evaluate(`document.querySelector('[data-workspace-proposal-soul]')?.textContent ?? ''`));
    const before = new Set((await listWorkspaces(target.origin, target.identity)).map((row) => row.name));

    await page.evaluate(proposalButton('/create workspace/iu'));
    await until(page, "the agent's reply with the new workspace's link",
      `(document.querySelector('#chat')?.textContent ?? '').includes(${JSON.stringify(PROPOSAL_LINK_REPLY)})`);
    const said = v.parse(v.string(), await page.evaluate(`document.querySelector('#chat')?.textContent ?? ''`));
    const link = /https?:\/\/\S+?\/workspace\/[a-z0-9-]+/u.exec(said.slice(said.lastIndexOf(PROPOSAL_LINK_REPLY)))?.[0] ?? '';

    created = /\/workspace\/([a-z0-9-]+)$/u.exec(link)?.[1] ?? null;
    const row = (await listWorkspaces(target.origin, target.identity)).find((entry) => entry.name === created);

    return {
      cardTitle, cardSoul, link, existedBeforeApproval: created !== null && before.has(created),
      created: row === undefined ? null : { name: row.name, displayName: row.displayName ?? '' },
    };
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

async function flowMemoryProposals(target: FlowTarget, workspace: string, key: string): Promise<readonly AccountMemoryProposal[]> {
  const response = await fetch(`${target.origin}/api/user/memory`, { headers: webHeaders(target.identity) });

  if (!response.ok) throw new Error(`reading the flow's account-memory proposals answered ${String(response.status)}`);
  const view = v.parse(v.object({ pending: v.array(AccountMemoryProposalSchema) }), await response.json());

  return view.pending.filter((row) => row.origin.workspace === workspace && row.proposal.kind === 'fact' && row.proposal.key === key);
}

/** End only this workspace's fixture proposals; the shared account's other proposals stay pending. */
async function clearFlowMemory(target: FlowTarget, workspace: string, key: string): Promise<void> {
  const headers = webHeaders(target.identity);

  for (const proposal of await flowMemoryProposals(target, workspace, key)) {
    const declined = await fetch(`${target.origin}/api/user/memory/proposals/${encodeURIComponent(proposal.id)}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'decline' }),
    });

    if (!declined.ok && declined.status !== 404) throw new Error(`declining the flow's proposal answered ${String(declined.status)}`);
  }

  const forgotten = await fetch(`${target.origin}/api/user/memory/facts/${encodeURIComponent(key)}`, { method: 'DELETE', headers });

  if (!forgotten.ok) throw new Error(`forgetting the flow's fixture fact answered ${String(forgotten.status)}`);
}

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
    const settings = await signedInPage(target.browser, target);

    await settings.goto(`${target.origin}/user/settings#memory`, { waitUntil: 'load' });
    await until(settings, 'Settings → Memory loaded', `document.querySelector('[data-account-memory]') !== null`);

    const filed = (await flowMemoryProposals(target, said, ACCOUNT_FACT.key))[0];

    if (filed === undefined) throw new Error('the flow\'s workspace filed no account-memory proposal');
    const proposal = `[data-account-memory-proposal=${JSON.stringify(filed.id)}]`;

    await until(settings, 'the flow\'s proposal in Settings → Memory', `document.querySelector(${JSON.stringify(proposal)}) !== null`);
    const offered = v.parse(v.string(), await settings.evaluate(`document.querySelector(${JSON.stringify(proposal)})?.textContent ?? ''`));

    await settings.evaluate(`document.querySelector(${JSON.stringify(proposal)})?.querySelector('button')?.click()`);
    await until(settings, 'the fact kept', `document.querySelector('[data-account-memory-fact=${JSON.stringify(ACCOUNT_FACT.key)}]') !== null`);
    await sendAndSettle(second, ACCOUNT_RECALL_ASK);
    const after = await lastReply(second, ACCOUNT_RECALL_REPLY, RECALL_ANSWERS);
    const viewer = await fetch(`${target.origin}/api/user/memory`);

    return { offered, before, after, viewerStatus: viewer.status };
  } finally {
    await clearFlowMemory(target, said, ACCOUNT_FACT.key);
    await removeFlowWorkspace(target, said);
    await removeFlowWorkspace(target, asked);
  }
}

export interface StackMemoryVerdict {
  /** The memory card's words in the stack once the agent proposed the fact. */
  readonly offered: string;
  /** The agent's recall, before the owner kept it and after. */
  readonly before: string;
  readonly after: string;
}

/**
 * Row: an agent proposes an account fact; the proposal waits in the chat's attention stack, pushed by the owner's user
 * object on the socket the page already holds; kept there, the agent's recall returns it.
 */
export async function accountMemoryInTheStack(target: FlowTarget): Promise<StackMemoryVerdict> {
  const workspace = await createFlowWorkspace(target, 'stack-memory');

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);
    const answers = [STACK_FACT.value, 'nowhere I know of'];

    await sendAndSettle(page, STACK_FACT_ASK);
    await sendAndSettle(page, STACK_RECALL_ASK);
    const before = await lastReply(page, STACK_RECALL_REPLY, answers);

    const filed = (await flowMemoryProposals(target, workspace, STACK_FACT.key))[0];

    if (filed === undefined) throw new Error('the flow\'s workspace filed no stack-memory proposal');
    const key = `memory:${filed.id}`;
    const card = `[data-attention-card=${JSON.stringify(key)}]`;
    const behind = `[data-attention-behind=${JSON.stringify(key)}]`;

    await until(page, 'the flow\'s proposal in the attention stack', `document.querySelector(${JSON.stringify(`${card}, ${behind}`)}) !== null`);
    // Brought to the front if anything newer waits.
    await page.evaluate(`document.querySelector(${JSON.stringify(behind)})?.click()`);
    await until(page, 'the proposal open', `document.querySelector(${JSON.stringify(card)}) !== null`);
    const offered = v.parse(v.string(), await page.evaluate(`document.querySelector(${JSON.stringify(card)})?.textContent ?? ''`));

    await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card} button`)})].find((button) => button.textContent?.trim() === 'Keep for every workspace')?.click()`);
    await until(page, 'the flow\'s proposal gone from the stack', `document.querySelector(${JSON.stringify(`${card}, ${behind}`)}) === null`);
    await sendAndSettle(page, STACK_RECALL_ASK);
    const after = await lastReply(page, STACK_RECALL_REPLY, answers);

    return { offered, before, after };
  } finally {
    await clearFlowMemory(target, workspace, STACK_FACT.key);
    await removeFlowWorkspace(target, workspace);
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

    const back = await signedInPage(target.browser, target);
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
    // so this row's number is the frames that socket answered with. The composer
    // turns live on the socket's open, before its first frame, so the row waits
    // for that frame before it counts.
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await waitOn(page, "the agent tab's actor socket to answer", counter.actorAnswered());

    const afterSwitch = counter.counts();

    await page.evaluate(ClickScripts.mainTab);
    await until(page, "Main's tab, current", `${ACTIVE_TAB_INDEX} === 0`);
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    // Let the switch back land before the node is read: a remount replaces the
    // marked element, and the count of marked nodes settles at 0 when it does.
    await settled(page, `document.querySelectorAll('[data-live-probe="work-surface"]').length`);

    const afterBack = counter.counts();

    const survives = v.parse(
      v.object({ scrollTop: v.number() }),
      await page.evaluate(() => ({ scrollTop: document.querySelector('[data-live-probe="work-surface"]')?.scrollTop ?? -1 })),
    );

    await counter.stop();
    await page.close();

    const onSwitch = readsBetween(beforeSwitch.sent, afterSwitch.sent);
    const onBack = readsBetween(afterSwitch.sent, afterBack.sent);

    return {
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
/** Whether the setup offers a way forward: Next or Finish setup, drawn and pressable. */
const WELCOME_OFFERED = `[...document.querySelectorAll('button')]
  .some((b) => !b.disabled && b.getClientRects().length > 0 && ['Next', 'Finish setup'].includes((b.textContent ?? '').trim()))`;

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
  const page = await signedInPage(target.browser, target);

  try {
    await page.goto(`${target.origin}/`, { waitUntil: 'load' });
    await until(page, 'the home page or its setup',
      `location.pathname === '/welcome' || document.querySelector('#workspace-mission') !== null`);

    const welcomed = v.parse(v.boolean(), await page.evaluate(`location.pathname === '/welcome'`));

    for (let pressed = 'next'; welcomed && pressed === 'next'; await painted(page)) {
      // `/welcome` is the address before the page draws its setup: its steps' buttons come once it has.
      await until(page, 'the setup offering Next or Finish setup', WELCOME_OFFERED);
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

const SHOWN_WARNINGS = `[...document.querySelectorAll('.p-notice-warning, [data-notice="warning"]')]
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
  const page = await signedInPage(target.browser, target);
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

/** Press the inspector strip's tab named `name`; an absent tab throws. */
function stripTab(name: string): string {
  return `(() => {
    const tab = document.querySelector(${JSON.stringify(`#inspector button[aria-label="${name}"]`)});
    if (tab === null) throw new Error(${JSON.stringify(`no ${name} tab in the inspector strip`)});
    tab.click();
  })()`;
}

/**
 * The first size choice that restarts the computer: neither the account's default, which may be the size it runs at,
 * nor the size its control names (`current`). Picking the first unselected choice picked the explicit Small on an
 * account whose default was Small, and no restart came (staging rc20, 2026-10-19).
 */
function otherSize(current: string): string {
  return `[...document.querySelectorAll('[role="option"]')].find((option) => {
    const text = (option.textContent ?? '').trim();
    return !text.startsWith('Your default') && !text.startsWith(${JSON.stringify(`${current} ·`)});
  })`;
}

/** Marks {@link otherSize}'s choice for a pointer to press, and names it. */
function markOtherSize(current: string): string {
  return `(() => { const option = ${otherSize(current)}; option.setAttribute('data-flow-size', ''); return (option.textContent ?? '').trim(); })()`;
}

const MARKED_SIZE = '[role="option"][data-flow-size]';

/** Whether the inspector strip draws a tab named `name`. */
function stripHas(name: string): string {
  return `document.querySelector(${JSON.stringify(`#inspector button[aria-label="${name}"]`)}) !== null`;
}

/** The Files tab has listed its directory successfully: no loading row or visible listing failure. */
const FILES_SETTLED = `(() => {
  const list = document.querySelector('[data-files-list]');
  return list !== null && ${FILES_FAILURE} === null && !(list.textContent ?? '').includes('Loading…');
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
  let filesLedger: FrameLedger | null = null;

  try {
    const page = await openWorkspacePage(target, `/workspace/${encodeURIComponent(workspace)}`);

    await sendAndSettle(page, WRITE_FILE_ASK);
    filesLedger = await frameLedger(page);
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

    await filesLedger.stop();
    filesLedger = null;
    await page.close();

    return { workspace, filesListed, changedPaths, afterReview };
  } finally {
    await filesLedger?.stop();
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
  /** Each tab's change-set reads, and the frames that moved its change-set (`changes_moved`), during the burst. Not
   *  every read-moved frame: the turn's own (its claim, its agents, its owed work, its ledger) moved 8 to 11 reads per
   *  turn on staging, none of them the change-set's, and so read 10 and 11 against a bound meant for the burst
   *  (c6dc27da1 and 71d06f4a9, 2026-10-13; three traced runs: changes_moved once, getExecutorDiff 2 or 3 times). */
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
      burstFrames: burst.map((counts) => counts.received[CHANGES_MOVED_EVENT] ?? 0),
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

/** The inspector's tools strip as it stands: the current tool, and the Agent button the page holds now. */
const TOOLS_NOW = `[...document.querySelectorAll('#inspector nav[aria-label="Workspace"] button[aria-current="true"]')].map((tool) => tool.getAttribute('aria-label'))`;

/**
 * One press on the Agent tab, as a person gives it, read back once it has rendered (two frames): whether the tab took
 * it, the tools current then, and whether the button pressed is still the strip's or was replaced by a redraw.
 */
const PRESS_AGENT = `(async () => {
  const tab = document.querySelector('#inspector button[aria-label="Agent"]');
  if (tab === null) throw new Error('no Agent tab in the inspector strip');
  tab.click();
  await new Promise((done) => { requestAnimationFrame(() => { requestAnimationFrame(done); }); });
  const now = document.querySelector('#inspector button[aria-label="Agent"]');
  return { took: now?.getAttribute('aria-current') === 'true', current: ${TOOLS_NOW}, replaced: now !== tab };
})()`;

const PressSchema = v.object({ took: v.boolean(), current: v.array(v.nullable(v.string())), replaced: v.boolean() });

/**
 * The memory section on the Agent tab, failing at once, named, if the tab draws without it or stops being current.
 * Staging a907148d8 waited 366 s here in silence; on the same build a run later the section drew at once.
 */
const AGENT_MEMORY_SHOWN = `(() => {
  const current = ${TOOLS_NOW};
  if (!current.includes('Agent')) throw new Error('the Agent tab stopped being current; current: ' + (current.join(', ') || 'none'));
  const sections = [...document.querySelectorAll('#inspector [data-section]')].map((section) => section.getAttribute('data-section'));
  if (!sections.includes('agent-who')) return false;
  if (!sections.includes('memory')) throw new Error('the Agent tab drew without its memory section; it drew ' + (sections.join(', ') || 'no section'));
  return true;
})()`;

/** The Agent tab pressed once, as a person presses it: a press the strip drops fails here, named, and is not retried. */
async function openAgentTab(page: Page): Promise<void> {
  // A page behind another gets no frames, and the press is read back after two.
  await page.bringToFront();
  const press = v.parse(PressSchema, await page.evaluate(PRESS_AGENT));

  if (!press.took) {
    throw new Error(`the Agent tab did not take its press: current ${JSON.stringify(press.current)}, `
      + `${press.replaced ? 'the button pressed was replaced by a redraw' : 'the button pressed is still the strip\'s'}`);
  }
}

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
    await openAgentTab(watcher);
    await until(watcher, "the Agent tab's memory section", AGENT_MEMORY_SHOWN);
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
  /** Whether the bar held a page under the slate's title once the turn ended. */
  readonly slateTab: boolean;
  /** The slate's preview frame's page text once its React page drew; null when no frame drew. */
  readonly frameText: string | null;
  /** The count the page showed after one Bump, answered by the slate's own method over its RPC; null when unread. */
  readonly bumped: string | null;
  /** Whether the page heard its host's context. */
  readonly hosted: boolean;
  /** Every page of the inspector's bar, by the name it shows: a slate's is its title, never its preview's port
   *  ("workspace :20000", 1008-f). */
  readonly pageTabs: readonly string[];
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

    const slateTab = v.parse(v.boolean(), await page.evaluate(`${PAGE_TABS}.includes(${JSON.stringify(FLOW_SLATE.title)})`));
    let frameText: string | null = null;
    let bumped: string | null = null;
    let hosted = false;

    if (slateTab) {
      await openInspectorPage(page, FLOW_SLATE.title);

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

    const pageTabs = v.parse(v.array(v.string()), await page.evaluate(PAGE_TABS));

    await ledger.stop();
    await page.close();

    return { workspace, slateTab, frameText, bumped, hosted, pageTabs };
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

/** The Drive place a person's files are in, chosen where it is drawn: the column, or below `lg` the switch. */
const MY_STUFF_PLACE = `[...document.querySelectorAll('[data-drive-place="mine"], [data-drive-tab="mine"]')].find((place) => place.getClientRects().length > 0)`;

/**
 * Opens My stuff, where New is: a first visit to the Drive lands on Slates when the account has a slate, as the
 * approved design does. With My stuff the only place there is no column or switch, and the page is already there.
 */
async function openMyStuff(page: Page): Promise<void> {
  await until(page, 'My stuff or its place', `document.querySelector('[data-drive-new]') !== null || ${MY_STUFF_PLACE} !== undefined`);
  await page.evaluate(`document.querySelector('[data-drive-new]') === null && ${MY_STUFF_PLACE}?.click()`);
  await until(page, "My stuff's New", `document.querySelector('[data-drive-new]') !== null`);
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
  const page = await signedInPage(target.browser, target);

  writeFileSync(upload, 'browser flow upload\n');

  try {
    await page.evaluateOnNewDocument(COUNT_DRIVE_LISTINGS);
    await relisted(page, async () => { await page.goto(`${target.origin}/drive`, { waitUntil: 'load' }); }, true);
    await openMyStuff(page);
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

    await relisted(page, async () => { await page.reload({ waitUntil: 'load' }); }, true);
    await openMyStuff(page);
    await painted(page);

    const afterRename = v.parse(v.array(v.string()), await page.evaluate(DRIVE_LISTED));

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
  /** Where `/drive` landed: Slates when there is one, else My stuff, or Shared for an account that owns nothing yet. */
  readonly landedAt: string;
  /** The places the Drive offers, by id (`mine`, `slates`, `shared`), as its column or its switch draws them. */
  readonly places: readonly string[];
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
  const page = await signedInPage(target.browser, target);

  try {
    await page.goto(`${target.origin}/drive`, { waitUntil: 'load' });
    await until(page, 'the Drive to draw what it holds', DRIVE_DRAWN);
    await painted(page);

    const sections = v.parse(v.array(v.object({ title: v.string(), tiles: v.number() })), await page.evaluate(DRIVE_SECTIONS));
    const empty = v.parse(v.boolean(), await page.evaluate(`document.querySelector('[data-drive-empty]') !== null`));

    const sidebarLit = v.parse(v.boolean(), await page.evaluate(
      `[...document.querySelectorAll('a[aria-current="page"]')].some((link) => (link.textContent ?? '').trim() === 'Drive')`,
    ));

    const places = v.parse(v.array(v.string()), await page.evaluate(
      `[...new Set([...document.querySelectorAll('[data-drive-place], [data-drive-tab]')].map((place) => place.getAttribute('data-drive-place') ?? place.getAttribute('data-drive-tab') ?? ''))]`,
    ));

    return { landedAt: new URL(page.url()).pathname, places, sections, empty, sidebarLit };
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

/** The slate's tile in the Drive's Slates, found by the slate and the workspace it lives in. */
function slateTile(workspace: string): string {
  return `[data-drive-slate="${DRIVE_SLATE.id}"][data-drive-workspace="${workspace}"]`;
}

async function driveWithSlate(target: FlowTarget, workspace: string): Promise<Page> {
  const page = await signedInPage(target.browser, target);

  // A first visit to the Drive lands on Slates when the owner has one.
  await page.goto(`${target.origin}/drive`, { waitUntil: 'load' });
  await until(page, 'the slate\'s tile in Slates', `document.querySelector(${JSON.stringify(slateTile(workspace))}) !== null`);
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
 * Row: a slate opens from the Drive's Slates into its workspace, on its own tab.
 *
 * A workspace gets a slate through the Files route; the Drive's tile for it is
 * pressed, and the workspace page it opens must have made the slate's tab the
 * current one. The preview frame is not read: `vite dev` serves no slate.
 */
export async function slateOpensFromSlates(target: FlowTarget): Promise<SlateOpensVerdict> {
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

    await openSlateShareDialog(page, slateTile(workspace));

    const reachRow = v.parse(v.boolean(), await page.evaluate(`document.querySelector('[data-share-reach]') !== null`));

    const link = await submitPublicSlateShare(page);
    let copied: string | null = null;

    if (link !== null) {
      // Chrome's writeText asks for the sanitized-write grant, not clipboard-write (measured on Chrome 151).
      await page.browserContext().overridePermissions(target.origin, ['clipboard-read', 'clipboard-sanitized-write']);
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
    // At the desktop width the Drive's places are its column's.
    await until(page, 'the Shared place', `document.querySelector('[data-drive-place="shared"]') !== null`);
    await page.click('[data-drive-place="shared"]');

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

    return { workspace, reachRow, link, copied, sharedByYou, afterStop };
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

export interface DesktopResizeVerdict {
  readonly workspace: string;
  /** The size the computer ran at, and the one the reader chose. */
  readonly from: string;
  readonly to: string;
  /** Seconds from the choice until the desktop drew again: its session up and its panel at the foot. */
  readonly backAfterS: number;
}

/** The computer's desktop as its client draws it: a session up over no Kinu veil, and the panel at the screen's foot,
 *  read off the client's canvas in its same-origin frame. */
const DESKTOP_DRAWN = `(() => {
  const screen = document.querySelector('#inspector [data-desktop-frame]');
  const doc = screen?.querySelector('iframe')?.contentDocument;
  if (!doc || screen.querySelector('[role="status"]') !== null) return false;
  const canvas = [...doc.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (canvas === undefined || canvas.width < 640) return false;
  const foot = canvas.getContext('2d')?.getImageData(canvas.width / 2, canvas.height * ${String(1 - DESKTOP_PANEL.height / 2 / DESKTOP_SIZE.height)}, 1, 1).data;
  const panel = ${JSON.stringify([1, 3, 5].map((at) => Number.parseInt(DESKTOP_COLOURS.panel.slice(at, at + 2), 16)))};
  return foot !== undefined && panel.every((value, channel) => Math.abs(foot[channel] - value) <= 12);
})()`;

/**
 * Row: a computer resized while its desktop is open shows a working desktop again.
 *
 * The reader opens the computer's desktop, waits for its panel, and picks another size on the computer's own control.
 * The resize restarts the computer, which ends the desktop's session; on 71d06f4a9 the client then sat on its own blue
 * splash with nothing on it until the page was reloaded (staging, 2026-10-13).
 */
export async function computerDesktopSurvivesAResize(target: FlowTarget): Promise<DesktopResizeVerdict> {
  const workspace = await createFlowWorkspace(target, 'desktop-resize');

  try {
    const page = await openWorkspacePage(target, `/workspace/${workspace}`);

    await openInspector(page);
    await page.evaluate(stripTab('Environment'));
    const computer = executorLabel('computer');

    await until(page, 'the computer in the Environment panel', `[...document.querySelectorAll('#inspector button')].some((b) => (b.textContent ?? '').trim() === ${JSON.stringify(computer)})`);
    await page.evaluate(`[...document.querySelectorAll('#inspector button')].find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(computer)}).click()`);
    const desktopTab = `[...document.querySelectorAll('#inspector [role="tab"]')].find((tab) => (tab.textContent ?? '').trim() === 'Desktop')`;

    await until(page, "the computer's Desktop tab", `${desktopTab} !== undefined`);
    await page.evaluate(`${desktopTab}.click()`);
    await until(page, "the computer's desktop", DESKTOP_DRAWN);

    const size = await page.waitForSelector(`#inspector [aria-label="${computer} size"]`);

    if (size === null) throw new Error(`no ${computer} size control`);
    const from = v.parse(v.string(), await size.evaluate((element) => (element.textContent ?? '').trim()));

    await size.click();
    await until(page, 'the size choices', `${otherSize(from)} !== undefined`);

    // A pointer's press, as a person picks: the list selects on the pointer's release, not on a scripted click.
    const to = v.parse(v.string(), await page.evaluate(markOtherSize(from)));

    await page.click(MARKED_SIZE);
    const chosen = performance.now();

    // The restart ends the session: the desktop stops drawing before it can be drawn again.
    await until(page, 'the restart to end the desktop\'s session', `!(${DESKTOP_DRAWN})`);
    await until(page, "the resized computer's desktop", DESKTOP_DRAWN);

    const backAfterS = Math.round((performance.now() - chosen) / 100) / 10;

    await page.close();

    return { workspace, from, to, backAfterS };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface DesktopSwitchVerdict {
  readonly workspace: string;
  /** Milliseconds from choosing the terminal until it showed its prompt, and from choosing the desktop until it drew. */
  readonly terminalAfterMs: number;
  readonly desktopAfterMs: number;
  /** Whether the desktop came back in the client it was left in, and the terminal in its own: nothing reopened. */
  readonly keptDesktop: boolean;
  readonly keptTerminal: boolean;
  /** Expanded: the share of the workspace area the desktop spans on the axis it fills (its shape letterboxes the other),
   *  the sidebar folded, and the client stayed. */
  readonly expandedFill: number | null;
  readonly expandedRailFolded: boolean;
  readonly keptExpanded: boolean;
  /** Back from expanded: the desktop in the column again, in the client it was left in. */
  readonly keptReturned: boolean;
}

/**
 * The terminal a person sees in the inspector: the one shown, of every one the column keeps open (D99). The first in
 * the document is the oldest kept out of sight: staging fcc2e05d6's computer-sessions row read it for a new session's.
 */
const SHOWN_TERMINAL = `[...document.querySelectorAll('#inspector .xterm-rows')].find((rows) => rows.checkVisibility({ visibilityProperty: true }))`;

/** The shown terminal's screen, where a person clicks to type. */
const SHOWN_SCREEN = `${SHOWN_TERMINAL}?.closest('.xterm')?.querySelector('.xterm-screen')`;

/** Clicks the shown terminal's screen as a person does, so what is typed next reaches that terminal. */
async function clickShownTerminal(page: Page): Promise<void> {
  const middle = v.parse(v.nullable(v.object({ x: v.number(), y: v.number() })), await page.evaluate(`(() => {
    const box = ${SHOWN_SCREEN}?.getBoundingClientRect();
    return box === undefined ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`));

  if (middle === null) throw new Error('no terminal shown to type into');
  await page.mouse.click(middle.x, middle.y);
}

/** The desktop's client document, marked so a reopened one is told apart from the one left. */
const DESKTOP_WINDOW = `document.querySelector('#inspector [data-desktop-frame] iframe')?.contentWindow`;

/**
 * Row: a computer's terminal and desktop switch without reopening either, and its desktop expands in place.
 *
 * Production 71d06f4a9 and f9c17ac7b (the owner, 2026-10-14): each switch between Terminal and Desktop showed a loading
 * state, because the column dropped what it did not show and opened it again; and the desktop's full screen opened a
 * new tab drawing a thin strip. The reader opens the desktop, the terminal, the desktop again, then expands it and
 * comes back, and the row reads whether each came back in the client it was left in, and how long each switch took.
 */
export async function computerSwitchKeepsItsScreens(target: FlowTarget): Promise<DesktopSwitchVerdict> {
  const workspace = await createFlowWorkspace(target, 'desktop-switch');

  try {
    const page = await openWorkspacePage(target, `/workspace/${workspace}`);

    await openInspector(page);
    await page.evaluate(stripTab('Environment'));
    const computer = executorLabel('computer');

    await until(page, 'the computer in the Environment panel', `[...document.querySelectorAll('#inspector button')].some((b) => (b.textContent ?? '').trim() === ${JSON.stringify(computer)})`);
    await page.evaluate(`[...document.querySelectorAll('#inspector button')].find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(computer)}).click()`);
    const tab = (name: string) => `[...document.querySelectorAll('#inspector [role="tab"]')].find((each) => (each.textContent ?? '').trim() === ${JSON.stringify(name)})`;
    const shell = `${SESSION_TABS}[0]`;

    await until(page, "the computer's Desktop tab", `${tab('Desktop')} !== undefined && ${shell} !== undefined`);
    await page.evaluate(`${tab('Desktop')}.click()`);
    await until(page, "the computer's desktop", DESKTOP_DRAWN);
    await page.evaluate(`Object.assign(${DESKTOP_WINDOW}, { __kinuLeft: true })`);

    const shellName = v.parse(v.string(), await page.evaluate(shell));
    let chosen = performance.now();

    await page.evaluate(`${tab(shellName)}.click()`);
    await until(page, "the shell's prompt", `/[#$]\\s*$/m.test(${SHOWN_TERMINAL}?.textContent ?? '')`);
    const terminalAfterMs = Math.round(performance.now() - chosen);

    await page.evaluate(`window.__kinuTerminalLeft = ${SHOWN_TERMINAL}`);
    chosen = performance.now();
    await page.evaluate(`${tab('Desktop')}.click()`);
    await until(page, 'the desktop again', DESKTOP_DRAWN);
    const desktopAfterMs = Math.round(performance.now() - chosen);
    const keptDesktop = v.parse(v.boolean(), await page.evaluate(`${DESKTOP_WINDOW}?.__kinuLeft === true`));

    await page.evaluate(`${tab(shellName)}.click()`);
    await until(page, 'the shell again', `${SHOWN_TERMINAL} !== undefined`);
    const keptTerminal = v.parse(v.boolean(), await page.evaluate(`${SHOWN_TERMINAL} === window.__kinuTerminalLeft`));

    await page.evaluate(`${tab('Desktop')}.click()`);
    await until(page, 'the desktop to show', DESKTOP_DRAWN);
    const expand = `document.querySelector('#inspector [data-desktop-expand]')`;
    const expandable = v.parse(v.boolean(), await page.evaluate(`${expand} !== null`));
    let expandedFill: number | null = null;
    let expandedRailFolded = false;
    let keptExpanded = false;
    let keptReturned = false;

    if (expandable) {
      await page.evaluate(`${expand}.click()`);

      const fill = `(() => {
        const screen = document.querySelector('#inspector [data-desktop-frame]')?.getBoundingClientRect();
        const area = document.querySelector('main')?.getBoundingClientRect();
        return screen === undefined || area === undefined ? 0 : Math.max(screen.width / area.width, screen.height / area.height);
      })()`;

      await until(page, 'the desktop to fill the workspace', `${fill} > 0.9`);
      expandedFill = Math.round(v.parse(v.number(), await page.evaluate(fill)) * 100) / 100;
      expandedRailFolded = v.parse(v.boolean(), await page.evaluate(`document.querySelector('[data-rail-collapsed]') !== null`));
      keptExpanded = v.parse(v.boolean(), await page.evaluate(`${DESKTOP_WINDOW}?.__kinuLeft === true`));
      await page.evaluate(`document.querySelector('[data-desktop-return]').click()`);
      await until(page, 'the desktop back in the column', `${fill} < 0.9`);
      keptReturned = v.parse(v.boolean(), await page.evaluate(`${DESKTOP_WINDOW}?.__kinuLeft === true`));
    }

    await page.close();

    return { workspace, terminalAfterMs, desktopAfterMs, keptDesktop, keptTerminal, expandedFill, expandedRailFolded, keptExpanded, keptReturned };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface AgentJobVerdict {
  readonly workspace: string;
  /** What the job's tab and its details said while it waited, and what its terminal showed once answered. */
  readonly markedWaiting: boolean;
  readonly answered: boolean;
}

const JOB_TAB = `[...document.querySelectorAll('#inspector [role="tablist"] [role="tab"]')].find((tab) => (tab.textContent ?? '').includes('Release to production'))`;

/**
 * Row: an agent's job runs in a session the person can open and answer (D95).
 *
 * The reader asks the agent to start a job that stops at a prompt, opens the computer's sessions, finds the job's tab
 * marked as waiting, opens it, types the answer into its terminal, and reads the job's answer on the screen.
 */
export async function agentJobIsAnsweredInItsSession(target: FlowTarget): Promise<AgentJobVerdict> {
  const workspace = await createFlowWorkspace(target, 'agent-job');

  try {
    const page = await openWorkspacePage(target, `/workspace/${workspace}`);

    await sendAndSettle(page, JOB_ASK);
    // Either way the agent says it: a job that did not start fails the row here, in the agent's words.
    const said = `(document.querySelector('#chat')?.textContent ?? '')`;

    await until(page, "the agent's reply that its job started", `[${JSON.stringify(JOB_STARTED)}, ${JSON.stringify(JOB_NOT_STARTED)}].some((words) => ${said}.includes(words))`);
    const reply = v.parse(v.string(), await page.evaluate(said));

    if (!reply.includes(JOB_STARTED)) throw new Error(`the agent's job did not start: ${reply.slice(reply.indexOf(JOB_NOT_STARTED), reply.indexOf(JOB_NOT_STARTED) + 400)}`);
    await openInspector(page);
    await page.evaluate(stripTab('Environment'));
    const computer = executorLabel('computer');

    await until(page, 'the computer in the Environment panel', `[...document.querySelectorAll('#inspector button')].some((b) => (b.textContent ?? '').trim() === ${JSON.stringify(computer)})`);
    await page.evaluate(`[...document.querySelectorAll('#inspector button')].find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(computer)}).click()`);
    await until(page, "the job's tab", `${JOB_TAB} !== undefined`);
    await page.evaluate(`${JOB_TAB}.click()`);
    await until(page, 'the job marked as waiting for input', `document.querySelector('#inspector [data-session-waiting]') !== null`);
    const markedWaiting = true;

    await until(page, "the job's prompt on its screen", `(${SHOWN_TERMINAL}?.textContent ?? '').includes('Release to production?')`);
    await clickShownTerminal(page);
    await page.keyboard.type('y');
    await page.keyboard.press('Enter');
    await until(page, "the job's answer on its screen", `(${SHOWN_TERMINAL}?.textContent ?? '').includes('release answered y')`);
    await until(page, 'the wait mark gone', `document.querySelector('#inspector [data-session-waiting]') === null`);
    await page.close();

    return { workspace, markedWaiting, answered: true };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface SessionsVerdict {
  readonly workspace: string;
  /** What the new session's line said while its server ran: its folder and its ports. */
  readonly folder: string;
  readonly ports: readonly string[];
  /** The tabs' names after the computer restarted at another size, and the renamed session's folder then. */
  readonly namesAfter: readonly string[];
  readonly folderAfter: string;
}

const SESSION_LINE = sessionLine('#inspector');

const SESSION_TABS = `[...document.querySelectorAll('#inspector [role="tablist"] [role="tab"]')].map((tab) => (tab.textContent ?? '').trim()).filter((name) => name !== 'Desktop')`;

/**
 * Row: the computer's terminal sessions are named, report their folder and ports, and come back by name and folder
 * after the computer restarts (D90).
 *
 * The reader opens a second session on the computer, starts a server in a new folder there, and reads the session's
 * line; renames the session; then picks another size, which restarts the container, and reads the tabs and the
 * renamed session's folder once its fresh shell opens.
 */
export async function computerSessionsComeBackByName(target: FlowTarget): Promise<SessionsVerdict> {
  const workspace = await createFlowWorkspace(target, 'computer-sessions');

  try {
    const page = await openWorkspacePage(target, `/workspace/${workspace}`);

    await openInspector(page);
    await page.evaluate(stripTab('Environment'));
    const computer = executorLabel('computer');

    await until(page, 'the computer in the Environment panel', `[...document.querySelectorAll('#inspector button')].some((b) => (b.textContent ?? '').trim() === ${JSON.stringify(computer)})`);
    await page.evaluate(`[...document.querySelectorAll('#inspector button')].find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(computer)}).click()`);
    await until(page, "the computer's first session", `${SESSION_TABS}.length === 1`);
    await page.click('#inspector button[aria-label="New session"]');
    await until(page, 'a second session, open', `${SESSION_TABS}.length === 2 && document.querySelector('#inspector [role="tab"][aria-selected="true"]')?.textContent?.trim() === ${SESSION_TABS}[1]`);
    await until(page, "the new session's shell", `(${SHOWN_TERMINAL}?.textContent ?? '').includes('#')`);
    await clickShownTerminal(page);
    await page.keyboard.type('mkdir -p /workspace/flow-web && cd /workspace/flow-web && python3 -m http.server 8765');
    await page.keyboard.press('Enter');
    await until(page, "the session's line naming its folder and port", `(() => { const line = ${SESSION_LINE}; return line.folder === '/workspace/flow-web' && line.ports.includes(':8765'); })()`);

    const running = v.parse(v.object({ folder: v.string(), ports: v.array(v.string()) }), await page.evaluate(SESSION_LINE));

    await page.evaluate(`document.querySelector('#inspector [role="tab"][aria-selected="true"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const rename = await page.waitForSelector('#inspector input[aria-label^="Rename"]');

    if (rename === null) throw new Error('the session offered no rename');
    await rename.evaluate((input) => { if (input instanceof HTMLInputElement) input.select(); });
    await page.keyboard.type('web');
    await page.keyboard.press('Enter');
    await until(page, 'the renamed session', `${SESSION_TABS}.includes('web')`);

    const size = await page.waitForSelector(`#inspector [aria-label="${computer} size"]`);

    if (size === null) throw new Error(`no ${computer} size control`);
    const from = v.parse(v.string(), await size.evaluate((element) => (element.textContent ?? '').trim()));

    await size.click();
    await until(page, 'the size choices', `${otherSize(from)} !== undefined`);
    await page.evaluate(markOtherSize(from));
    await page.click(MARKED_SIZE);
    await until(page, 'the computer restarting', `document.querySelector('#inspector .xterm-rows') === null`);
    await until(page, "the restarted computer's sessions", `${SESSION_TABS}.includes('web') && ${SHOWN_TERMINAL} !== undefined`);
    await page.evaluate(`[...document.querySelectorAll('#inspector [role="tab"]')].find((tab) => (tab.textContent ?? '').trim() === 'web').click()`);
    await until(page, "the renamed session's fresh shell in its folder", `(${SESSION_LINE}).folder === '/workspace/flow-web'`);

    const namesAfter = v.parse(v.array(v.string()), await page.evaluate(SESSION_TABS));
    const after = v.parse(v.object({ folder: v.string(), ports: v.array(v.string()) }), await page.evaluate(SESSION_LINE));

    await page.close();

    return { workspace, folder: running.folder, ports: running.ports, namesAfter, folderAfter: after.folder };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}

export interface ReopenVerdict {
  readonly workspace: string;
  /** Whether Back showed the page kept whole in the back/forward cache, its sockets closed under it. */
  readonly restored: boolean;
  /** How the browser says it reached the reopened page, and the bytes it moved for its document: none when the
   *  document came out of the browser's own cache. */
  readonly navigation: string;
  readonly transferBytes: number;
}

/** Marks a page shown again from the back/forward cache: its document is the one it had, with no load of its own. */
const MARK_RESTORED = `addEventListener('pageshow', (event) => { if (event.persisted) document.documentElement.dataset.kinuRestored = ''; })`;

/**
 * Row: a workspace reopened by Back loads the build the deployment serves.
 *
 * The reader opens a workspace, leaves it for another page of the app as a new document, and goes Back. On
 * 71d06f4a9 Chrome answered that document and its scripts from its disk cache without asking (staging, 2026-10-13), as
 * it does a restored session, so a workspace reopened that way ran whichever build last loaded at its address: the
 * owner saw an older design come back. With its back/forward cache on, Chrome instead showed the page it had kept,
 * whose sockets had closed: "Could not load preview listings: Connection closed".
 */
export async function reopenedWorkspaceRunsTheDeployedBuild(target: FlowTarget): Promise<ReopenVerdict> {
  const workspace = await createFlowWorkspace(target, 'reopen');

  try {
    const page = await signedInPage(target.browser, target);

    await page.evaluateOnNewDocument(MARK_RESTORED);
    await page.goto(`${target.origin}/workspace/${workspace}`, { waitUntil: 'load' });
    await until(page, "the chat column's live composer", CHAT_COMPOSER_LIVE);
    await page.goto(`${target.origin}/user/settings`, { waitUntil: 'load' });
    // History's own Back: Puppeteer's resolved on the settings page's own address change, before Back landed.
    await page.evaluate(() => { history.back(); });
    await page.waitForFunction((path) => location.pathname === path && document.readyState === 'complete', {}, `/workspace/${workspace}`);

    const reopened = v.parse(v.object({ restored: v.boolean(), type: v.string(), transferSize: v.number() }), await page.evaluate(() => {
      const [navigation] = performance.getEntriesByType('navigation');
      const restored = document.documentElement.dataset.kinuRestored !== undefined;

      return navigation instanceof PerformanceNavigationTiming ? { restored, type: navigation.type, transferSize: navigation.transferSize } : null;
    }));

    // A page loaded again must also come up: its socket answers as on any load.
    if (!reopened.restored) await until(page, "the reopened workspace's live composer", CHAT_COMPOSER_LIVE);
    await page.close();

    return { workspace, restored: reopened.restored, navigation: reopened.type, transferBytes: reopened.transferSize };
  } finally {
    await removeFlowWorkspace(target, workspace);
  }
}
