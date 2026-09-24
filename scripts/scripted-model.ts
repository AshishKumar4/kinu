/**
 * The model behind a live-app run: an OpenAI-compatible endpoint whose answers
 * are a script. Everything else in the run is the product — the real Worker in
 * workerd, real Durable Objects, the real client — so the one thing a local run
 * cannot have (a provider) is the one thing stood in for here.
 *
 * A script reads the request, not a counter: the same server answers a
 * workspace's titling call, a row's throwaway turn and the plan walkthrough's
 * four steps, and each is decided by what the request carries. Counters break
 * the moment two rows share the server, which they do.
 *
 * The streamed shapes are the ones `@ai-sdk/openai-compatible` parses:
 * a `delta.content` chunk finished with `stop`, or a `delta.tool_calls` chunk
 * carrying the complete argument JSON, finished with `tool_calls` (the parser
 * emits the tool call as soon as the arguments parse — see
 * openai-compatible-chat-language-model.ts:605, `isParsableJson`).
 */
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import * as v from 'valibot';
import { DYNAMIC_CONTEXT_OPEN_TAG, TURN_CONTEXT_HEADER, parseJsonValue, workspacePath } from '@kinu.run/core';

import { apiJson } from './live-app-harness';

/** The model spec a scripted workspace runs on, and the credential that serves it. */
export const SCRIPTED_MODEL_SPEC = 'openai-compat/fake-live';

const SCRIPTED_MODEL_ID = 'fake-live';

const SCRIPTED_CREDENTIAL = 'openai-compat.default';

/** What an unscripted request gets. One string, so a row that waits for the
 *  answer waits for the words this server actually sends. */
export const FALLBACK_ANSWER = 'Live answer from the fake model.';

/** A paced answer's silences, in the order a thinking model leaves them: before its first token, and after
 *  `lead`, a first token that opens the answer's text with nothing to draw, as a blank lead line does. */
export interface ScriptedPace {
  readonly firstTokenMs: number;
  readonly lead: string;
  readonly leadMs: number;
  /** A first silence of unknown length, ended by the row that holds it ({@link heldCall}). */
  readonly hold?: Promise<void>;
}

/** One answer: prose, or a tool call with its complete arguments. Unpaced, it is written in one piece. */
export interface ScriptedAnswer {
  readonly text?: string;
  readonly toolCall?: { readonly name: string; readonly arguments: unknown };
  readonly pace?: ScriptedPace;
}

/** The request as a script reads it. `available` is what this turn may call —
 *  a titling call carries no tools at all, and a script that ignored that
 *  would answer it with a tool call the request never offered. */
export interface ScriptedRequest {
  /** What was said to the agent, oldest first: every user-role message's text but the runtime state the
   *  product sends in that role after the words (a `<dynamic_context>` block, the turn-local context), so
   *  the last entry is the latest ask. */
  readonly userTexts: readonly string[];
  /** The system messages' text: where a workspace's mission reaches its model. */
  readonly system: string;
  /** Tool names already called in this conversation, in order. */
  readonly called: readonly string[];
  readonly available: readonly string[];
}

export type ScriptedModel = (request: ScriptedRequest) => ScriptedAnswer;

/** Wrap a script so the run's FIRST request gets `first` — the caller knows
 *  by construction which turn opens the run (a fresh workspace's create
 *  queues its genesis turn before anything else can speak), while matching
 *  on the request's text would guess. */
export function countingScript(script: ScriptedModel, first: ScriptedAnswer): ScriptedModel {
  let seen = 0;

  return (request) => {
    seen += 1;

    return seen === 1 ? first : script(request);
  };
}

const TextPartSchema = v.object({ type: v.optional(v.string()), text: v.optional(v.string()) });

/** A message's text, whatever shape the provider serialized it in: a plain
 *  string, or the parts array the SDK sends for a multi-part message. */
const ContentSchema = v.pipe(
  v.union([v.string(), v.array(TextPartSchema), v.null()]),
  v.transform((content) => (
    Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : content ?? ''
  )),
);

const OutboundMessageSchema = v.object({
  role: v.optional(v.string()),
  content: v.optional(ContentSchema),
  tool_calls: v.optional(v.array(v.object({
    function: v.optional(v.object({ name: v.optional(v.string()) })),
  }))),
});

const OutboundBodySchema = v.object({
  messages: v.optional(v.array(OutboundMessageSchema)),
  tools: v.optional(v.array(v.object({
    function: v.optional(v.object({ name: v.optional(v.string()) })),
  }))),
});

/** A user-role message the product wrote: its live state, sent after the words it describes
 *  (`prompting/volatile-context.ts`). */
function isRuntimeState(text: string): boolean {
  return text.startsWith(DYNAMIC_CONTEXT_OPEN_TAG) || text.startsWith(TURN_CONTEXT_HEADER);
}

/** The request body as a script reads it. */
export function readScriptedRequest(body: string): ScriptedRequest {
  const parsed = v.parse(OutboundBodySchema, parseJsonValue(body));
  const messages = parsed.messages ?? [];

  return {
    userTexts: messages.flatMap((message) => {
      const text = message.content ?? '';

      return message.role === 'user' && !isRuntimeState(text) ? [text] : [];
    }),
    system: messages.flatMap((message) => message.role === 'system' ? [message.content ?? ''] : []).join('\n'),
    called: messages.flatMap((message) => (message.tool_calls ?? []).flatMap(
      (call) => call.function?.name === undefined ? [] : [call.function.name],
    )),
    available: (parsed.tools ?? []).flatMap((tool) => tool.function?.name === undefined ? [] : [tool.function.name]),
  };
}

const CHUNK = { id: 'chatcmpl-scripted', object: 'chat.completion.chunk', created: 1, model: SCRIPTED_MODEL_ID };

/** `step`: the calls the request already holds, so each call a turn makes has its own id, as a provider gives it. */
function streamOf(answer: ScriptedAnswer, step: number): string {
  const events: unknown[] = [];
  const call = answer.toolCall;

  if (answer.text !== undefined) {
    events.push({ ...CHUNK, choices: [{ index: 0, delta: { role: 'assistant', content: answer.text }, finish_reason: null }] });
  }

  if (call !== undefined) {
    events.push({
      ...CHUNK,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: `call-${call.name}-${String(step)}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
        },
        finish_reason: null,
      }],
    });
  }

  events.push({ ...CHUNK, choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' }] });

  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

/** Write a paced answer the way a slow provider streams one: the role chunk at once, then each silence as a real
 *  wait on the socket, then the answer. */
function writePaced(response: ServerResponse, answer: ScriptedAnswer, pace: ScriptedPace, step: number): void {
  const frame = (delta: Record<string, string>): string =>
    `data: ${JSON.stringify({ ...CHUNK, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;

  response.write(frame({ role: 'assistant' }));
  // A hold that fails cuts the call, as a provider that drops the socket does.
  (pace.hold ?? Promise.resolve()).then(() => {
    setTimeout(() => {
      response.write(frame({ content: pace.lead }));
      setTimeout(() => { response.end(streamOf(answer, step)); }, pace.leadMs);
    }, pace.firstTokenMs);
  }, () => { response.destroy(); });
}

export interface ScriptedModelServer {
  readonly port: number;
  /** Every answer this server gave, in order — what a failing row reads first. */
  readonly answers: readonly ScriptedAnswer[];
  stop(): Promise<void>;
}

/** Bind the scripted endpoint on an ephemeral port. */
export async function startScriptedModel(script: ScriptedModel): Promise<ScriptedModelServer> {
  const answers: ScriptedAnswer[] = [];

  const http = createHttpServer((request, response) => {
    let body = '';

    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake.invalid');

      if (url.pathname === '/models' && request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ object: 'list', data: [{ id: SCRIPTED_MODEL_ID, name: 'Fake Live' }] }));

        return;
      }

      if (url.pathname === '/chat/completions' && request.method === 'POST') {
        const asked = readScriptedRequest(body);
        const answer = script(asked);
        // Every request's surface, on the run's own log: a script that answered
        // prose where a tool call was meant is read here first.
        process.stderr.write(`scripted-model: tools=${asked.available.join(',')} called=${asked.called.join(',')} users=${JSON.stringify(asked.userTexts)}\n`);
        answers.push(answer);
        response.setHeader('content-type', 'text/event-stream');

        if (answer.pace === undefined) response.end(streamOf(answer, asked.called.length));
        else writePaced(response, answer, answer.pace, asked.called.length);

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

  const address = v.parse(v.object({ port: v.number() }), http.address());

  return {
    port: address.port,
    answers,
    stop: async () => {
      const closed = Promise.withResolvers<void>();
      http.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

/** Point the deployment's `openai-compat` credential at this server. */
export async function registerScriptedModel(origin: string, port: number): Promise<void> {
  await apiJson(origin, `/api/user/credentials/${SCRIPTED_CREDENTIAL}`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'openai-compat',
      baseURL: `http://127.0.0.1:${String(port)}`,
      apiKey: 'fake-key',
    }),
  });
}

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
      toolCall: { name: 'file', arguments: { action: 'list', path: '/home/user' } },
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

/** The words that ask for the reconnect turn. */
export const RECONNECT_TURN_ASK = 'Reconnect probe: take your steps, then wait.';

/** The folders the reconnect turn lists before its held call, one step each; a new workspace has both. (Listing its
 *  `memory` folder fails, which would leave a row that never reads done.) */
const RECONNECT_FOLDERS = ['', 'scaffold', ''];

/** The reconnect turn's steps before its held call, each a sentence and a tool call. */
export const RECONNECT_STEPS = RECONNECT_FOLDERS.length;

/**
 * The reconnect turn: {@link RECONNECT_STEPS} steps that each say what they do and list a folder, then a call held on
 * `held` whose answer closes the turn, so the turn is still running whatever the row does meanwhile. Each lists a
 * different folder, since a third identical call makes the harness steer the turn (turn-steering.ts). Null for any
 * request that did not ask for it.
 */
export function reconnectTurn(request: ScriptedRequest, held: HeldCall): ScriptedAnswer | null {
  if (!request.userTexts.some((text) => text.includes(RECONNECT_TURN_ASK))) return null;

  if (!request.available.includes('file')) return { text: FALLBACK_ANSWER };

  const done = request.called.filter((name) => name === 'file').length;

  const folder = RECONNECT_FOLDERS[done];

  if (folder !== undefined) {
    return {
      text: `Step ${String(done + 1)}: listing ${folder === '' ? 'the workspace' : folder}.`,
      toolCall: { name: 'file', arguments: { action: 'list', path: workspacePath(folder) } },
    };
  }

  return { text: 'Done.', pace: { firstTokenMs: 0, lead: '', leadMs: 0, hold: held.hold() } };
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

const SLATE_ROOT = workspacePath(`slates/${SLATE_ID}`);

/** The implement turn's writes, in the order the script plays them. */
const SLATE_WRITES: readonly ScriptedAnswer[] = [
  {
    text: 'Writing the slate.',
    toolCall: { name: 'file', arguments: { action: 'write', path: `${SLATE_ROOT}/package.json`, content: SLATE_MANIFEST } },
  },
  {
    toolCall: { name: 'file', arguments: { action: 'write', path: `${SLATE_ROOT}/server.ts`, content: SLATE_SERVER } },
  },
];

const APPROVAL_TEXT = /approved plan/i;

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
const NOTES_FILE = workspacePath('memory/MEMORY.md');

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
      : { toolCall: { name: 'memory', arguments: { action: 'save', content: 'The kept-tab probe was here.' } } };
  }

  if (last.includes(KEPT_TAB_FORGET)) {
    const edits = request.called.filter((name) => name === 'file').length;

    if (edits === 0) return { toolCall: { name: 'file', arguments: { action: 'read', path: NOTES_FILE } } };

    if (edits === 1) return { toolCall: { name: 'file', arguments: { action: 'write', path: NOTES_FILE, content: '# Memory\n' } } };

    return { text: 'Forgotten.' };
  }

  return null;
}
