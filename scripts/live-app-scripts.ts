/**
 * The scripts the live-app rows' turns are answered by: each turn's ask, its paced or held answer, and the words a
 * row asserts against. Served by the scripted model (`scripts/scripted-model.ts`), driven by the rows
 * (`scripts/live-app-rows.ts`) and the plan film (`scripts/plan-demo-film.ts`).
 */
import * as v from 'valibot';
import { SLATES_ROOT, workspacePath, WORKSPACE_LOGO_SYSTEM_PROMPT, WORKSPACE_ROOT } from '@kinu.run/core';
import { FALLBACK_ANSWER, type ScriptedAnswer, type ScriptedCall, type ScriptedModel, type ScriptedPace, type ScriptedRequest } from './scripted-protocol';


/* ── The paced turn ───────────────────────────────────────────────────── */

/** The words that ask for the paced turn, and the prose it closes on. */
export const PACED_TURN_ASK = 'Pace this turn: list the home folder, then say what is in it.';

export const PACED_TURN_ANSWER = 'The home folder holds the workspace soul and its projects folder.';

/** Long enough for a 20 ms sampler to read each silence many times over, short enough to keep the row small. */
export const PACED_SILENCE_MS = 3_000;

const PACED: ScriptedPace = { firstTokenMs: PACED_SILENCE_MS, lead: '\n\n', leadMs: PACED_SILENCE_MS };

/** The paced steps: a tool call, then the closing prose, each behind the silences a thinking model leaves. */
function pacedSteps(request: ScriptedRequest): ScriptedAnswer {
  if (!request.available.includes('file')) return { text: FALLBACK_ANSWER };

  if (!request.called.includes('file')) {
    return {
      pace: PACED,
      text: 'Listing the home folder.',
      toolCall: { name: 'file', arguments: { op: 'list', path: '/home/main' } },
    };
  }

  return { pace: PACED, text: PACED_TURN_ANSWER };
}

/**
 * A turn that streams the way a thinking model does: silence before the first token, a first token that opens
 * the answer's text with nothing to draw, silence, then a tool call; the next step the same before its closing
 * prose. Null for any request that did not ask for it, so it composes in front of another script.
 */
export function pacedTurn(request: ScriptedRequest): ScriptedAnswer | null {
  return request.userTexts.some((text) => text.includes(PACED_TURN_ASK)) ? pacedSteps(request) : null;
}

export const THINKING_TURN_ASK = 'Think this through aloud before you answer.';

export const THINKING_TURN_ANSWER = 'Thought it through.';

/** A turn that reasons for a few seconds in small steps before it answers, so a tab can join or reconnect mid-thought. */
/** The dropped-file row's ask, and the attachment's one data row: the model answers with whether that row reached it. */
export const DROPPED_FILE_ASK = 'Check these coupons';

export const DROPPED_FILE_ROW = 'SAVE20,20';

export const DROPPED_FILE_ARRIVED = 'The file arrived; SAVE20 is in it.';

export function droppedFileTurn(request: ScriptedRequest): ScriptedAnswer | null {
  const last = request.userTexts.at(-1) ?? '';

  if (!last.includes(DROPPED_FILE_ASK)) return null;

  return { text: last.includes(DROPPED_FILE_ROW) ? DROPPED_FILE_ARRIVED : 'No file reached me.' };
}

export function thinkingTurn(request: ScriptedRequest): ScriptedAnswer | null {
  if (!request.userTexts.some((text) => text.includes(THINKING_TURN_ASK))) return null;

  return { text: THINKING_TURN_ANSWER, pace: { firstTokenMs: 0, lead: '', leadMs: 0, reasoning: { deltas: 150, everyMs: 20 } } };
}

/* ── The provider-wait row ────────────────────────────────────────────── */

/** A workspace made with this mission has every drawing of its logo refused as a rate limit: the logo is the
 *  workspace's own call, made after the first turn and from Settings, so it waits on the provider in the background. */
export const LOGO_WAITED_MISSION = 'Background wait probe: the logo waits on the provider.';

/** The ask whose first call is refused as a rate limit, and answered once the provider's wait is over. */
export const WAITED_TURN_ASK = 'Turn wait probe: answer once the provider lets you.';

/** Long enough for the composer to count down several seconds, short enough to keep the row small. */
export const TURN_WAIT_SECONDS = 4;

/** Short, so the logo asks again soon after each refusal. */
const LOGO_WAIT_SECONDS = 3;

/** The ask whose calls Workers AI's per-minute limit refuses, stating no wait header, for a minute from the first. */
export const MINUTE_LIMITED_ASK = 'Minute limit probe: answer once the minute is up.';

export const MINUTE_WAITED_OUT = 'Waited out the minute.';

/** Workers AI's text-generation limits are per minute (developers.cloudflare.com/workers-ai/platform/limits, read
 *  2026-10-13); its recorded 429s answered again 63 s after the first (prod-glm-1 evals, 2026-09-30). */
const MINUTE_MS = 60_000;

/** The row's side of the provider-wait script: the waited turn refused once, and the logo's refusals counted, so the
 *  row waits on the server having refused, never on a clock. */
export class ProviderWaitProbe {
  turnRefused = false;

  /** When the minute-limited turn's first call was refused. */
  minuteFrom: number | null = null;

  private logos = 0;

  private readonly waiting: { readonly at: number; readonly reached: () => void }[] = [];

  /** Settles once the logo has been refused `more` more times. */
  logoRefused(more: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();

    this.waiting.push({ at: this.logos + more, reached: resolve });

    return promise;
  }

  refuseLogo(): ScriptedAnswer {
    this.logos += 1;

    for (const wait of this.waiting) if (wait.at <= this.logos) wait.reached();

    return { rateLimited: { retryAfterSeconds: LOGO_WAIT_SECONDS } };
  }
}

export function providerWaitTurn(request: ScriptedRequest, probe: ProviderWaitProbe): ScriptedAnswer | null {
  if (request.system.includes(WORKSPACE_LOGO_SYSTEM_PROMPT) && request.userTexts.some((text) => text.includes(LOGO_WAITED_MISSION))) {
    return probe.refuseLogo();
  }

  if (request.streamed && (request.userTexts.at(-1) ?? '').includes(MINUTE_LIMITED_ASK)) {
    probe.minuteFrom ??= Date.now();

    return Date.now() - probe.minuteFrom < MINUTE_MS ? { rateLimited: { perMinute: true } } : { text: MINUTE_WAITED_OUT };
  }

  if (!request.streamed || !(request.userTexts.at(-1) ?? '').includes(WAITED_TURN_ASK)) return null;

  if (probe.turnRefused) return { text: 'Done.' };
  probe.turnRefused = true;

  return { rateLimited: { retryAfterSeconds: TURN_WAIT_SECONDS } };
}

/** A model call a row holds open: its turn is admitted and its model silent until the row lets it answer. */
export interface HeldCall {
  /** Settles once the held call has reached the scripted server. */
  readonly arrived: Promise<void>;
  /** Lets the call answer. The row releases on every path, or the server's `stop()` waits on the open response. */
  release(): void;
  /** The script's side: marks the call arrived and returns what its first silence waits on. */
  hold(): Promise<void>;
}

export function heldCall(): HeldCall {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  return {
    arrived: arrived.promise,
    release: () => { released.resolve(); },
    hold: () => {
      arrived.resolve();

      return released.promise;
    },
  };
}

/** A workspace created with this mission takes its first turn paced, its first call held until its page is open. */
export const PACED_FIRST_TURN_MISSION = 'Take the first turn slowly: a page opens while it runs.';

/** The paced steps for every turn of a workspace made with {@link PACED_FIRST_TURN_MISSION}; the call that opens
 *  them waits on `held`. Its row runs only the first turn. */
export function pacedFirstTurn(request: ScriptedRequest, held: HeldCall): ScriptedAnswer | null {
  if (!request.system.includes(PACED_FIRST_TURN_MISSION)) return null;

  const answer = pacedSteps(request);

  return answer.pace === undefined || request.called.includes('file')
    ? answer
    : { ...answer, pace: { ...answer.pace, hold: held.hold() } };
}

/* ── The reconnect turn ───────────────────────────────────────────────── */

/** The words that ask for the reconnect turn: one per row, since each row's turn waits on a call of its own. */
export const RECONNECT_TURN_ASK = 'Reconnect probe: take your steps, then wait.';

export const OBSERVED_TURN_ASK = 'Observer probe: take your steps, then wait.';

export const UNANSWERED_PROBE_TURN_ASK = 'Probe-wait probe: take your steps, then wait.';

export const SLEPT_TURN_ASK = 'Sleep probe: take your steps, then wait.';

export const WATCHED_SLEPT_TURN_ASK = 'Watched sleep probe: take your steps, then wait mid-answer.';

export const CLEARED_TURN_ASK = 'Clear probe: take your steps, then wait.';

export const ANSWERED_TURN_ASK = 'Answer probe: take your steps, then wait.';

export const WATCHED_ANSWER_TURN_ASK = 'Watched answer probe: take your steps, then wait.';

/** The ask after an answered turn, whose request carries what that turn said. */
export const TOLD_BACK_ASK = 'Answer probe: what did you just do?';

/** The folders the reconnect turn lists before its held call, one step each; a new workspace has both. (Listing its
 *  `memory` folder fails, which would leave a row that never reads done.) */
const RECONNECT_FOLDERS = ['', 'scaffold', ''];

/** The reconnect turn's steps before its held call, each a sentence and a tool call. */
export const RECONNECT_STEPS = RECONNECT_FOLDERS.length;

/**
 * The reconnect turn: {@link RECONNECT_STEPS} steps that each say what they do and list a folder, then a call held on
 * `held` whose answer closes the turn, so the turn is still running whatever the row does meanwhile. Each lists a
 * different folder, since a third identical call makes the harness steer the turn (turn-steering.ts). `midAnswer`
 * holds the answer after its first word instead of before it.
 */
function heldSteps(request: ScriptedRequest, held: HeldCall, midAnswer: boolean, called = request.called): ScriptedAnswer {
  if (!request.available.includes('file')) return { text: FALLBACK_ANSWER };

  const done = called.filter((name) => name === 'file').length;

  const folder = RECONNECT_FOLDERS[done];

  if (folder !== undefined) {
    return {
      text: `Step ${String(done + 1)}: listing ${folder === '' ? 'the workspace' : folder}.`,
      toolCall: { name: 'file', arguments: { op: 'list', path: workspacePath(folder, WORKSPACE_ROOT) } },
    };
  }

  if (midAnswer) return { text: 'ne.', pace: { firstTokenMs: 0, lead: 'Do', leadMs: 0, rest: held.hold() } };

  return { text: 'Done.', pace: { firstTokenMs: 0, lead: '', leadMs: 0, hold: held.hold() } };
}

/** The reconnect turn for a request that sent `ask`, else null. */
export function reconnectTurn(request: ScriptedRequest, ask: string, held: HeldCall, midAnswer = false): ScriptedAnswer | null {
  return request.userTexts.some((text) => text.includes(ask)) ? heldSteps(request, held, midAnswer) : null;
}

/** The reconnect turn when the latest ask is `ask`, counting only its own calls: a turn after others in one conversation. */
export function laterReconnectTurn(request: ScriptedRequest, ask: string, held: HeldCall): ScriptedAnswer | null {
  return request.userTexts.at(-1)?.includes(ask) === true ? heldSteps(request, held, false, request.turn.map((call) => call.name)) : null;
}

/** A workspace created with this mission takes its own first turn as the reconnect turn: a turn no page sent. */
export const UNSENT_TURN_MISSION = 'Take the first turn in steps, then wait: no page sends it.';

/** The reconnect turn for every turn of a workspace made with {@link UNSENT_TURN_MISSION}; its row runs only the first. */
export function unsentFirstTurn(request: ScriptedRequest, held: HeldCall): ScriptedAnswer | null {
  return request.system.includes(UNSENT_TURN_MISSION) ? heldSteps(request, held, false) : null;
}

export const TOLD_BACK_ANSWER = 'I listed the folders.';

/** Answers {@link TOLD_BACK_ASK}, handing `heard` the request that carried it. */
export function toldBackTurn(request: ScriptedRequest, heard: (request: ScriptedRequest) => void): ScriptedAnswer | null {
  if (request.userTexts.at(-1)?.includes(TOLD_BACK_ASK) !== true) return null;
  heard(request);

  return { text: TOLD_BACK_ANSWER };
}

/* ── Slates in an answer ───────────────────────────────────────────────── */

/** The slate-ui row's ask, and the words each block's page shows. */
export const SLATE_UI_ASK = 'Slate UI probe: draw two inline slates.';

export const SLATE_UI_PAGES = { first: 'first-slate-page-3c1a', second: 'second-slate-page-8e02' } as const;

/** The file the first page reads through `workspace`, what it holds, and what its button sends the agent. */
export const SLATE_UI_FILE = { path: '/home/main/slate-ui-probe.txt', content: 'read-through-workspace-94d2' } as const;

export const SLATE_UI_SENT = 'slate-ui-click-5e7d';

/** The first page reads the file and sends on a click, as the agent that wrote it; the second only shows its words. */
function slateUiPage(name: string, words: string): string {
  const reach = name !== 'first' ? '' : [
    '<p id="read"></p><button id="send">Send</button><script type="module">',
    'import { workspace } from "kinu:slate";',
    `document.getElementById("read").textContent = await workspace.readFile(${JSON.stringify(SLATE_UI_FILE.path)});`,
    `document.getElementById("send").onclick = () => workspace.agent.send({ text: ${JSON.stringify(SLATE_UI_SENT)} });`,
    '</script>',
  ].join('');

  return `<!doctype html><html><head><title>${name}</title></head><body><p data-words>${words}</p>${reach}</body></html>`;
}

/** What a browser sends to forge a block: a page of its own, in its own words, under a name the answer does not use. */
export const SLATE_UI_FORGED = '<slate-ui name="forged">\n<!doctype html><html><body><p>forged-page-71b0</p></body></html>\n</slate-ui>';

/** The file the first page reads, then an answer that writes both blocks, each a page of its own. A click on the
 *  first page reaches the agent as a slate event, which `heard` is told of. */
export function slateUiTurn(request: ScriptedRequest, heard: (request: ScriptedRequest) => void): ScriptedAnswer | null {
  if (request.available.length === 0) return null;

  // The click's turn writes a file before it answers, as an agent acting on a page's choice does.
  if (request.userTexts.at(-1)?.includes(SLATE_UI_SENT) === true) {
    heard(request);

    if (request.turn.every((call) => call.name !== 'file')) {
      return { toolCall: { name: 'file', arguments: { op: 'write', path: '/home/main/slate-ui-chosen.txt', content: SLATE_UI_SENT } } };
    }

    return { text: 'Done.' };
  }

  if (request.userTexts.at(-1) !== SLATE_UI_ASK) return null;

  if (request.turn.every((call) => call.name !== 'file')) {
    return { toolCall: { name: 'file', arguments: { op: 'write', path: SLATE_UI_FILE.path, content: SLATE_UI_FILE.content } } };
  }

  return {
    text: ['Here are both.', ...Object.entries(SLATE_UI_PAGES).flatMap(([name, words]) => ['', `<slate-ui name="${name}">`, slateUiPage(name, words), '</slate-ui>'])].join('\n'),
  };
}

/* ── Stop, then a send ─────────────────────────────────────────────────── */

/** The stop-then-send row's asks, numbered per attempt: one stopped as it opens, whose turn never answers on its own,
 *  then a follow-up sent as the Stop leaves, answered at once. */
export const STOPPED_ASK = 'Stop probe: wait before the first word';

/** What the stopped ask's turn would answer: a page drawing it ran a message its Stop had stopped. */
export const STOPPED_ANSWER = 'The stopped ask answered.';

export const FOLLOW_UP_ASK = 'Stop probe: the follow-up';

export const FOLLOW_UP_ANSWER = 'Followed up after the Stop';

/** A new chat opened with this waits on its first call until its row lets the call go. */
export const OPENING_ASK = 'New chat probe: wait before the first word.';

export const OPENING_ANSWER = 'Opened after the wait.';

/** The stop-then-send and new-chat rows' turns, or null for any other request. */
export function stopProbeTurn(request: ScriptedRequest, opening: HeldCall): ScriptedAnswer | null {
  const last = request.userTexts.at(-1) ?? '';

  if (request.available.length === 0) return null;

  if (last.includes(FOLLOW_UP_ASK)) return { text: `${FOLLOW_UP_ANSWER}${last.slice(last.indexOf(FOLLOW_UP_ASK) + FOLLOW_UP_ASK.length)}.` };

  if (last.includes(STOPPED_ASK)) return { text: STOPPED_ANSWER, pace: { firstTokenMs: 60_000, lead: '\n\n', leadMs: 0 } };

  return last.includes(OPENING_ASK) ? { text: OPENING_ANSWER, pace: { firstTokenMs: 0, lead: '', leadMs: 0, hold: opening.hold() } } : null;
}

/* ── The plan's own tasks ──────────────────────────────────────────────── */

/** The handoff an approval enqueues names the approved plan; only a decision puts it in the conversation. */
const APPROVAL_TEXT = /approved plan/i;

/** The plan-tasks row's asks: a chore before any plan exists, then the plan itself, sent on a Plan turn. */
export const PLAN_TASKS_CHORE = 'Plan tasks probe: note the old chore before any plan.';

export const PLAN_TASKS_PLAN = 'Plan tasks probe: plan the guard fix.';

/** What the plan-tasks row's turns add: a chore before the plan, then the approved plan's step, its subtask, and a
 *  step added from a program. */
export const PLAN_TASK_TITLES = {
  chore: 'Sweep the old logs', step: 'Guard the segment read', sub: 'Cover the guest cart', programmed: 'Ship the guard fix',
} as const;

const PLAN_TASKS_MARKDOWN = ['# Guard the segment read', '', '1. Guard the read.', '2. Cover the guest cart.', '3. Ship it.'].join('\n');

/** The ids a native `tasks` add answers with. */
const TasksAddedSchema = v.pipe(v.string(), v.parseJson(), v.looseObject({ added: v.array(v.looseObject({ id: v.string() })) }));

/** Whether the conversation already holds a call to `name` whose arguments name `named`. */
function madeCall(request: ScriptedRequest, name: string, named = ''): ScriptedCall | undefined {
  return request.calls.find((call) => call.name === name && call.arguments.includes(named));
}

/** The approved plan's build turn: the step, its subtask under the id the step was given, then a step from a program. */
function planTasksBuild(request: ScriptedRequest): ScriptedAnswer {
  const step = madeCall(request, 'tasks', PLAN_TASK_TITLES.step);

  if (step === undefined) return { toolCall: { name: 'tasks', arguments: { op: 'add', titles: [PLAN_TASK_TITLES.step] } } };

  if (madeCall(request, 'tasks', PLAN_TASK_TITLES.sub) === undefined) {
    const added = v.safeParse(TasksAddedSchema, step.result);
    const parent = added.success ? added.output.added[0]?.id : undefined;

    if (parent === undefined) return { text: `The step's id was not in its answer: ${step.result}` };

    return { toolCall: { name: 'tasks', arguments: { op: 'add', titles: [PLAN_TASK_TITLES.sub], parent } } };
  }

  if (madeCall(request, 'eval') === undefined) {
    return { toolCall: { name: 'eval', arguments: { code: `// Add the last step\nawait tasks.add([${JSON.stringify(PLAN_TASK_TITLES.programmed)}]);\nreturn 'added';` } } };
  }

  return { text: 'Implemented the approved plan.' };
}

/**
 * The plan-tasks row's turns, or null for any other request. Each step is keyed on what the conversation already
 * holds, by the titles its calls name, so a request repeated within a turn never repeats a call.
 */
export function planTasksProbe(request: ScriptedRequest): ScriptedAnswer | null {
  if (request.available.length === 0 || !request.userTexts.some((text) => text.includes('Plan tasks probe'))) return null;
  const last = request.userTexts.at(-1) ?? '';

  if (last.includes(PLAN_TASKS_CHORE)) {
    return madeCall(request, 'tasks', PLAN_TASK_TITLES.chore) === undefined
      ? { toolCall: { name: 'tasks', arguments: { op: 'add', titles: [PLAN_TASK_TITLES.chore] } } }
      // The words the rows read as a page-sent turn's end (live-app-rows' TURN_ANSWERED).
      : { text: 'Done.' };
  }

  if (last.includes(PLAN_TASKS_PLAN)) {
    if (madeCall(request, 'submit_plan') !== undefined || !request.available.includes('submit_plan')) return { text: 'The plan is ready for your review.' };

    return { toolCall: { name: 'submit_plan', arguments: { edits: [{ start: 1, content: PLAN_TASKS_MARKDOWN }] } } };
  }

  return APPROVAL_TEXT.test(last) ? planTasksBuild(request) : null;
}

/* ── The plan walkthrough ──────────────────────────────────────────────── */

/** The mission the walkthrough is driven with, sent on a Plan turn. */
export const PLAN_MISSION
  = 'The SAVE20 coupon 500s at checkout. Plan the fix, then build me a dashboard of the support queue.';

export const SLATE_ID = 'support-queue';

/** The slate's title, which is where the inspector's tab gets its name. */
export const SLATE_TITLE = 'Support queue';

/** The plan the scripted agent submits — Markdown, as `submit_plan` takes it. */
export const PLAN_MARKDOWN = [
  '# Repair the `applyCoupon` eligibility guard',
  '',
  '## What is wrong',
  '',
  '`applyCoupon` reads `cart.customer.segment` before the guest cart has a',
  'customer, so a guest applying SAVE20 throws and checkout answers 500.',
  '',
  '## Steps',
  '',
  '1. Guard the segment read in `applyCoupon`: a guest cart has no segment, and',
  '   a coupon with no segment rule applies to every cart.',
  '2. Refuse an ineligible coupon with the cart untouched, and return the',
  '   refusal to the checkout route instead of throwing.',
  '3. Add the guest-cart case to the coupon regression suite.',
  '',
  '## How it is verified',
  '',
  '- A guest applying SAVE20 gets the discount; the response is 200.',
  '- A refused coupon leaves the cart total and the discount rows unchanged.',
].join('\n');

const SLATE_MANIFEST = JSON.stringify({
  name: SLATE_ID,
  main: 'server.ts',
  slate: { title: SLATE_TITLE },
}, null, 2);

const SLATE_SERVER = [
  'import { SlateObject } from "kinu:slate";',
  '',
  'const ROWS = [',
  '  { queue: "Billing", open: 14, breached: 2 },',
  '  { queue: "Checkout", open: 9, breached: 0 },',
  '  { queue: "Accounts", open: 5, breached: 1 },',
  '];',
  '',
  'export class Slate extends SlateObject {',
  '  async fetch() {',
  '    const rows = ROWS.map((row) => `<tr><td>${row.queue}</td><td>${row.open}</td><td>${row.breached}</td></tr>`);',
  '',
  '    return new Response(`<h1>Support queue</h1><table>${rows.join("")}</table>`, {',
  '      headers: { "content-type": "text/html" },',
  '    });',
  '  }',
  '}',
].join('\n');

const SLATE_ROOT = `${SLATES_ROOT}/${SLATE_ID}`;

/** The implement turn's writes, in the order the script plays them. */
const SLATE_WRITES: readonly ScriptedAnswer[] = [
  {
    text: 'Writing the slate.',
    toolCall: { name: 'file', arguments: { op: 'write', path: `${SLATE_ROOT}/package.json`, content: SLATE_MANIFEST } },
  },
  {
    toolCall: { name: 'file', arguments: { op: 'write', path: `${SLATE_ROOT}/server.ts`, content: SLATE_SERVER } },
  },
];

/**
 * The walkthrough the README's film records and the live-app tier asserts:
 * a Plan turn that submits a plan, then — after the owner approves and the
 * product enqueues the handoff — a Build turn that writes the slate.
 *
 * Every branch is keyed on the request. The plan step needs `submit_plan` to
 * be offered, which only a Plan turn does; the build step needs the approval
 * handoff to be in the conversation, which only a decision puts there.
 */
export const planWalkthrough: ScriptedModel = (request) => {
  const approved = request.userTexts.some((text) => APPROVAL_TEXT.test(text));
  const asked = request.userTexts.some((text) => text.includes('SAVE20'));

  if (!asked || request.available.length === 0) return { text: FALLBACK_ANSWER };

  if (!approved) {
    if (!request.available.includes('submit_plan')) return { text: FALLBACK_ANSWER };

    if (request.called.includes('submit_plan')) {
      return { text: 'The plan is ready for your review. Nothing is written yet.' };
    }

    return {
      text: 'Reading the checkout code before I plan the fix.',
      toolCall: { name: 'submit_plan', arguments: { edits: [{ start: 1, content: PLAN_MARKDOWN }] } },
    };
  }

  const written = request.called.filter((name) => name === 'file').length;
  const next = SLATE_WRITES[written];

  if (next !== undefined && request.available.includes('file')) return next;

  return {
    text: [
      'The guard is fixed and the guest-cart case is in the regression suite.',
      `The support queue dashboard is a slate: ${SLATE_TITLE}, open in its own tab.`,
    ].join(' '),
  };
};

/** The kept-tab row's two asks, by the words the row sends. */
export const KEPT_TAB_NOTE = 'Kept-tab probe: save one note.';

export const KEPT_TAB_FORGET = 'Kept-tab probe: forget every note.';

/** The workspace's notes file, where the agent's file tool finds it. */
const NOTES_FILE = workspacePath('memory/MEMORY.md', WORKSPACE_ROOT);

/**
 * The kept-tab row's turns, or null for any other request: the first saves a
 * note, which gives the Work tab content; the second reads the notes file and
 * rewrites it with no note in it, which takes that content away again (the
 * file tool refuses to overwrite a file the turn has not read).
 */
export function keptTabProbe(request: ScriptedRequest): ScriptedAnswer | null {
  const last = request.userTexts.at(-1) ?? '';

  if (request.available.length === 0) return null;

  if (last.includes(KEPT_TAB_NOTE)) {
    return request.called.includes('memory')
      ? { text: 'Saved.' }
      : { toolCall: { name: 'memory', arguments: { op: 'note', content: 'The kept-tab probe was here.' } } };
  }

  if (last.includes(KEPT_TAB_FORGET)) {
    const edits = request.called.filter((name) => name === 'file').length;

    if (edits === 0) return { toolCall: { name: 'file', arguments: { op: 'read', path: NOTES_FILE } } };

    if (edits === 1) return { toolCall: { name: 'file', arguments: { op: 'write', path: NOTES_FILE, content: '# Memory\n' } } };

    return { text: 'Forgotten.' };
  }

  return null;
}
