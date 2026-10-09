/**
 * A turn the workspace object's activation ended inside (a deploy, a reset, an eviction) is re-driven by the next
 * activation's wake under a request id that activation mints: the request the client sent lived only in the dead
 * activation's memory. A tab that redials acks the stream it is told of and draws the turn there to its end; where its
 * own send ended a client asks the workspace (`awaitSend`). Defends the F2 probe on staging a4e564ce1 (2026-09-30): a
 * 12-step turn, the activation ended after step 2, all 12 files written, and the eval client failed at the run's end
 * with "the turn's run ended before its stream could be resumed, so its answer was never observed".
 *
 * A client joining an open turn, a tab's reload or a redial into the activation that re-drives it, is told the steps
 * the ledger records first, restated from it, then the relay's chunks of the steps after them: one path for both.
 * Measured here (2026-09-30): an open turn's transcript frame holds its user row alone, since the answer row is
 * written at the commit, and the next activation's relay holds only what it streamed itself, so before the restated
 * steps a tab that joined the re-drive drew the rest of the answer without the steps before the restart.
 */
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import type { Connection } from 'agents';
import { jsonSchema, tool, type UIMessage } from 'ai';
import type { KinuExtension } from '@kinu.run/core';
import * as v from 'valibot';
import { AwaitedList } from '@kinu.run/test-utils';
import {
  armedWakes, driveUntil, GATEWAY_CATALOG, gatewayWorkspace, reactivateOrchestratorHarness, type HarnessOrchestratorAgent, type StartedHarness,
} from './helpers/actor-harness';
import { answeringGateway, requestOf, stubAiBinding, toolCallCompletion, type StubbedAiBinding } from './helpers/platform-gateway';
import { socketConnection } from './helpers/bindings';

const FrameSchema = v.looseObject({
  type: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()),
  replayComplete: v.optional(v.boolean()),
});

type Frame = v.InferOutput<typeof FrameSchema>;

const ChunkSchema = v.looseObject({ type: v.string(), delta: v.optional(v.string()), toolCallId: v.optional(v.string()) });

const CONNECT = { request: new Request('https://agent/connect') };

const ASK = 'Count to three, one step a number.';

/** Our clients send their message under the request's own id, so the turn's id is the request's. */
function chatRequest(id: string): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id,
    init: { method: 'POST', body: JSON.stringify({ messages: [{ id, role: 'user', parts: [{ type: 'text', text: ASK }] }], trigger: 'submit-message' }) },
  });
}

/** A model that counts one shell step a number and never answers the call for step `held`: the activation either
 *  ends inside it or is still inside it. `reached` hears that call asked. */
function countsUntil(held: number, reached?: () => void): StubbedAiBinding {
  return stubAiBinding((run) => {
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

    if (step >= held) {
      reached?.();

      return new Promise<Response>(() => {});
    }

    return toolCallCompletion(run, { tool: 'shell', args: { command: `echo ${String(step + 1)}` } }, `call_${String(step)}`);
  });
}

function chunkOf(frame: Frame): v.InferOutput<typeof ChunkSchema> | null {
  return frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.body !== undefined && frame.body !== ''
    ? v.parse(ChunkSchema, JSON.parse(frame.body))
    : null;
}

function counted(frames: readonly Frame[], chunk: string): number {
  return frames.filter((frame) => chunkOf(frame)?.type === chunk).length;
}

/** The tool calls `frames` carry, in order, each named by its id. */
function calls(frames: readonly Frame[]): string[] {
  return frames.flatMap((frame) => {
    const chunk = chunkOf(frame);

    return chunk?.type === 'tool-input-available' && chunk.toolCallId !== undefined ? [chunk.toolCallId] : [];
  });
}

/** A socket on `agent` that hears every frame sent it, its own and the broadcasts. */
function socketOn(agent: HarnessOrchestratorAgent, id: string, hear: (raw: string) => void): Connection {
  const fanout = agent.broadcast.bind(agent);

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (exclude === undefined || !exclude.includes(id)) hear(message);
      fanout(message, exclude);
    },
  });

  return socketConnection({ id, send: (data: string) => { hear(data); } });
}

/**
 * `countsUntil(held)`, and when its activation is inside the held call: a reset from then on is the provider's, never
 * the step's own work, so the next activation asks again at once (D12).
 */
function counting(held: number) {
  const reached = Promise.withResolvers<void>();

  return { model: countsUntil(held, () => { reached.resolve(); }), waiting: reached.promise };
}

/** The first activation, inside the turn's third model call when it ends; the second steps never stream. */
function firstActivation(): StartedHarness & { readonly waiting: Promise<void> } {
  const { model, waiting } = counting(2);

  return Object.assign(gatewayWorkspace(model), { waiting });
}

/** The next activation over the rows the first left, its model `model`. */
function nextActivation(first: StartedHarness, model: StubbedAiBinding): Promise<StartedHarness> {
  return reactivateOrchestratorHarness(first.db, undefined, {
    world: { aiGateway: model },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });
}

test('a tab that redials into the activation that re-opens its turn draws the turn there, to its end', async () => {
  const request = 'req-count';
  const rest = 'Three, and done.';
  const first = firstActivation();
  await first.started;
  const sent = new AwaitedList<Frame>();
  const sender = socketOn(first.agent, 'first-socket', (raw) => { sent.push(v.parse(FrameSchema, JSON.parse(raw))); });
  await first.agent.onConnect(sender, CONNECT);
  // A request is answered when its turn ends, which this activation never reaches: it ends inside the third step.
  const answered = Promise.resolve(first.agent.onMessage(sender, chatRequest(request))).then(() => 'answered');
  const streamed = sent.until((frames) => counted(frames, 'finish-step') === 2).then(() => 'two steps streamed');

  expect(await Promise.race([answered, streamed])).toBe('two steps streamed');
  await first.waiting;

  const next = await nextActivation(first, answeringGateway(rest));
  // The client redials before the wake re-drives the turn: the redial is what activates the object.
  const heard = new AwaitedList<Frame>();
  const acks: Promise<void>[] = [];

  const socket: Connection = socketOn(next.agent, 'redialled-socket', (raw) => {
    const frame = v.parse(FrameSchema, JSON.parse(raw));
    heard.push(frame);

    // As the SDK's hook acks it: the stream it is told of, whatever request id the activation gave it.
    if (frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING) {
      acks.push(Promise.resolve(next.agent.onMessage(socket, JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: frame.id }))));
    }
  });

  await next.agent.onConnect(socket, CONNECT);
  await next.agent.terminalRetryPass();
  await heard.until((frames) => frames.some((frame) => frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.done === true));
  await Promise.all(acks);

  const resumed = heard.items.find((frame) => frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING);
  const followed = heard.items.filter((frame) => resumed !== undefined && frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.id === resumed.id);
  const kinds = followed.map((frame) => chunkOf(frame)?.type);

  // The two steps before the restart are restated from the ledger, ahead of every chunk the relay holds; the relay
  // adds the answer's own step.
  expect({
    toldPending: heard.items.some((frame) => frame.type === CHAT_MESSAGE_TYPES.STREAM_PENDING),
    restatedFirst: kinds.indexOf('text-delta') > kinds.lastIndexOf('tool-input-available'),
    calls: calls(followed),
    cuts: counted(followed, 'data-kinu-step-cut'),
    steps: counted(followed, 'finish-step'),
    rest: followed.flatMap((frame) => chunkOf(frame)?.delta ?? []).join(''),
    ended: followed.at(-1)?.done === true,
  }).toEqual({
    toldPending: true, restatedFirst: true, calls: ['call_0', 'call_1'],
    steps: 3, cuts: 0, rest, ended: true,
  });
});

test("an activation ending between a step's seal and its ledger rows leaves the re-driven turn every step's rows once, in order", async () => {
  // F2 probe run 4 on staging d968007de (2026-10-01): a step was sealed and its output kept, but its row never written.
  const models = { [GATEWAY_CATALOG.tiers.default.model]: { id: 'harness', contextWindow: 1_048_576, cost: { input: 1, output: 2 } } };
  const tab = new TabSocket();
  const view = await pane(tab);
  let next: StartedHarness | undefined;

  const first = gatewayWorkspace(countsUntil(2), { turnExtensions: [{
    name: 'restart-after-seal',
    onToolResult: (result) => result.toolCallId === 'call_1' ? new Promise(() => {}) : undefined,
    prepareStep: async ({ stepNumber }) => {
      if (stepNumber !== 2) return undefined;
      next = await nextActivation(first, answeringGateway('Done.'));
      next.agent.harnessCatalogModels(models);
      await tab.drop();

      return undefined;
    },
  }] });

  first.agent.harnessCatalogModels(models);
  await first.started;
  await tab.open(first.agent, 'ledger-first');

  try {
    await act(async () => { await view.say(ASK); });

    if (next === undefined) throw new Error('the turn never reached its third request');
    const resumed = next;
    await tab.open(resumed.agent, 'ledger-next');
    await act(async () => {
      const settled = view.resume();
      await resumed.agent.terminalRetryPass();
      await settled;
    });
    await tab.answered();
    const [run] = (await resumed.agent.getRunSummaries()).items;

    if (run === undefined) throw new Error('the turn left no run');
    const events = await resumed.agent.getRunEvents(run.runId);

    const row = (type: string, toolCallId: string | undefined): string[] => {
      if (type === 'step_finish') return ['step'];

      return type === 'tool_call_end' ? [`tool ${toolCallId ?? ''}`] : [];
    };

    expect({
      ledger: events.flatMap((event) => row(event.type, event.type === 'tool_call_end' ? event.toolCallId : undefined)),
      timeline: (await resumed.agent.getRunTimeline({ runId: run.runId })).flatMap((span) => row(span.rawType ?? '', span.refId)),
      usage: { input: run.usage.input, output: run.usage.output },
      costs: events.flatMap((event) => event.type === 'step_finish' ? [event.usd] : []),
    }).toEqual({
      ledger: ['tool call_0', 'step', 'tool call_1', 'step', 'step'],
      timeline: ['tool call_0', 'step', 'tool call_1', 'step', 'step'],
      usage: { input: 3, output: 3 },
      costs: [0.000003, 0.000003, 0.000003],
    });
  } finally { await view.close(); }
});

/** The pane draws no element, so the container and window are the few fields React reads. */
const KEYS = ['window', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const saved = new Map(KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

beforeAll(() => {
  Object.assign(globalThis, { window: { HTMLIFrameElement: class {}, document: { activeElement: null } }, IS_REACT_ACT_ENVIRONMENT: true });
});

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

/**
 * A person's tab: the socket `useAgentChat` reads, carried to whichever activation answers it. A frame the tab sends
 * before its socket is accepted waits for the accept, as the platform holds it.
 */
class TabSocket extends EventTarget {
  readonly agent = 'orchestrator-agent';
  readonly name = 'harness-parent';
  readonly _pk = 'tab';
  readonly connectionError = null;
  /** What the socket now open heard. */
  heard = new AwaitedList<Frame>();
  /** The activation the socket is open on, and what the tab asked of it. */
  private server: { readonly agent: HarnessOrchestratorAgent; readonly socket: Connection; readonly asks: Promise<void>[] } | null = null;
  private readonly held: string[] = [];

  getHttpUrl(): string { return 'https://agent/agents/orchestrator-agent/harness-parent'; }

  send(raw: string): void {
    if (this.server === null) this.held.push(raw);
    else this.server.asks.push(Promise.resolve(this.server.agent.onMessage(this.server.socket, raw)));
  }

  /** The socket opens on `agent`: the tab's open event, then the platform's accept. */
  async open(agent: HarnessOrchestratorAgent, id: string): Promise<void> {
    const heard = new AwaitedList<Frame>();

    const socket = socketOn(agent, id, (raw) => {
      heard.push(v.parse(FrameSchema, JSON.parse(raw)));
      this.dispatchEvent(new MessageEvent('message', { data: raw }));
    });

    this.heard = heard;
    await act(async () => {
      this.dispatchEvent(new Event('open'));
      await agent.onConnect(socket, CONNECT);
      this.server = { agent, socket, asks: [] };

      for (const raw of this.held.splice(0)) this.send(raw);
    });
  }

  /** The activation ended: the platform closes every socket it held, and what the tab asked of it ends with it. */
  async drop(): Promise<void> {
    this.server = null;
    await act(async () => { this.dispatchEvent(new CloseEvent('close', { code: 1006 })); });
  }

  /** Everything the tab asked of the activation it is open on, answered. */
  async answered(): Promise<void> {
    await act(async () => { await Promise.all(this.server?.asks ?? []); });
  }
}

/** A person's pane on `tab`: the shipped hook, what it draws and its send. */
async function pane(tab: TabSocket): Promise<{ readonly shown: () => readonly UIMessage[]; readonly say: (text: string) => Promise<void>; readonly resume: () => Promise<void>; readonly close: () => Promise<void> }> {
  let shown: readonly UIMessage[] = [];
  let say: (text: string) => Promise<void> = () => Promise.reject(new Error('the pane has not rendered'));
  let resume: () => Promise<void> = () => Promise.reject(new Error('the pane has not rendered'));

  function Pane(): null {
    // SAFETY: of the socket it is handed, the SDK's hook reads `agent`, `name`, `path`, `_pk`, `getHttpUrl`,
    // `connectionError`, `send` and its message, open and close events (agents/dist/chat/react.js); TabSocket provides each.
    const chat = useAgentChat({ agent: tab as never, getInitialMessages: null, throttle: 0 });
    shown = chat.messages;
    say = (text) => chat.sendMessage({ text });
    resume = () => chat.resumeStream();

    return null;
  }

  const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({
    nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: { addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {},
  }));

  const root = createRoot(container);
  await act(async () => { root.render(createElement(Pane)); });

  return { shown: () => shown, say: (text) => say(text), resume: () => resume(), close: () => act(async () => { root.unmount(); }) };
}

/** The shell steps the pane's answer draws, each as the command it ran and whether its output arrived. */
function drawnSteps(shown: readonly UIMessage[]): string[] {
  const answer = shown.filter((message) => message.role === 'assistant').at(-1);

  return (answer?.parts ?? []).flatMap((part) => {
    if (!part.type.startsWith('tool-')) return [];
    const drawn = v.parse(v.looseObject({ state: v.string(), input: v.object({ command: v.string() }) }), part);

    return [`${drawn.input.command}: ${drawn.state}`];
  });
}

/** The pane sends the ask on `agent` and hears the turn's two steps stream; the third call is held. The send is
 *  handed back in an object: returned bare, it would be the promise this one settles with, the whole turn's. */
async function askedAndTwoSteps(tab: TabSocket, view: Awaited<ReturnType<typeof pane>>, agent: HarnessOrchestratorAgent): Promise<{ readonly asked: Promise<void> }> {
  await tab.open(agent, 'tab-first');
  let asked: Promise<void> = Promise.resolve();

  await act(async () => {
    asked = view.say(ASK);
    await tab.heard.until((frames) => counted(frames, 'finish-step') === 2);
  });

  return { asked };
}

/** Step `index`'s tool output has reached `tab`. */
function stepDrawn(tab: TabSocket, index: number): Promise<void> {
  return tab.heard.until((frames) => frames.some((frame) => chunkOf(frame)?.type === 'tool-output-available' && chunkOf(frame)?.toolCallId === `call_${String(index)}`));
}

test('an open web pane removes a cut step before the re-run streams', async () => {
  const partial = new TextEncoder().encode(`data: ${JSON.stringify({
    id: 'cut', object: 'chat.completion.chunk', created: 0, model: 'harness',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'cut draft' }, finish_reason: null }],
  })}\n\n`);

  const first = gatewayWorkspace(stubAiBinding(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(partial); },
  }), { headers: { 'content-type': 'text/event-stream' } })));

  await first.started;
  const tab = new TabSocket();
  const view = await pane(tab);
  await tab.open(first.agent, 'cut-first');
  let asked: Promise<void> = Promise.resolve();

  try {
    await act(async () => {
      asked = view.say(ASK);
      await tab.heard.until((frames) => frames.some((frame) => chunkOf(frame)?.delta === 'cut draft'));
    });

    const text = () => view.shown().filter((message) => message.role === 'assistant')
      .flatMap((message) => message.parts.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('');

    expect(text()).toBe('cut draft');
    const next = await nextActivation(first, answeringGateway('Replacement answer.'));
    await tab.drop();
    await act(async () => { await asked; });
    await tab.open(next.agent, 'cut-next');
    await act(async () => {
      const settled = view.resume();
      await next.agent.terminalRetryPass();
      await settled;
    });
    await tab.answered();
    const chunks = tab.heard.items.flatMap((frame) => chunkOf(frame) ?? []);

    expect(chunks.filter((chunk) => chunk.type === 'data-kinu-step-cut')).toHaveLength(1);
    expect(chunks.findIndex((chunk) => chunk.type === 'data-kinu-step-cut'))
      .toBeLessThan(chunks.findIndex((chunk) => chunk.delta === 'Replacement answer.'));
    expect(text()).toBe('Replacement answer.');
  } finally { await view.close(); }
});

test("a person's open tab redials into each re-drive across two restarts and draws every step once, in order, while it streams", async () => {
  const tab = new TabSocket();
  const view = await pane(tab);
  const first = firstActivation();
  await first.started;
  const { asked } = await askedAndTwoSteps(tab, view, first.agent);
  await first.waiting;

  // Each activation ends inside the call after the step it runs, so the turn still streams when the tab is read.
  const third = counting(3);
  const second = await nextActivation(first, third.model);
  await tab.drop();
  // The send ends with its socket: the activation that took it ended inside its turn.
  await act(async () => { await asked; });
  await tab.open(second.agent, 'tab-second');
  await act(async () => {
    await second.agent.terminalRetryPass();
    await stepDrawn(tab, 2);
  });
  await tab.answered();
  const afterOne = drawnSteps(view.shown());
  await third.waiting;

  const last = await nextActivation(second, countsUntil(4));
  await tab.drop();
  await tab.open(last.agent, 'tab-third');
  await act(async () => {
    await last.agent.terminalRetryPass();
    await stepDrawn(tab, 3);
  });
  await tab.answered();

  expect({ afterOne, afterTwo: drawnSteps(view.shown()) }).toEqual({
    afterOne: ['echo 1: output-available', 'echo 2: output-available', 'echo 3: output-available'],
    afterTwo: ['echo 1: output-available', 'echo 2: output-available', 'echo 3: output-available', 'echo 4: output-available'],
  });
  await view.close();
});

/** Cuts in a step's own work that settle a turn (D12). */
const POISON_WORK_CUTS = 6;

/** The shared backoff after a first cut in a step's own work (`recoveryBackoffMs(1)`). */
const FIRST_WORK_CUT_BACKOFF_MS = 2000;

/** The claim of the turn `id`, as the next decision reads it. */
function claimOf(harness: StartedHarness, id: string): { outcome: string | null; epoch: number } | null {
  return harness.db.query<{ outcome: string | null; epoch: number }, [string]>('SELECT outcome, epoch FROM actor_turn_claims WHERE turn_id = ?').get(id);
}

/** Opens turn `id` on `first` and returns once the activation is inside it; its request is never answered there. */
async function opened(first: StartedHarness, id: string, steps: number): Promise<void> {
  await first.started;
  const sent = new AwaitedList<Frame>();
  const sender = socketOn(first.agent, 'first-socket', (raw) => { sent.push(v.parse(FrameSchema, JSON.parse(raw))); });

  await first.agent.onConnect(sender, CONNECT);
  const answered = Promise.resolve(first.agent.onMessage(sender, chatRequest(id))).then(() => 'answered');
  const streamed = sent.until((frames) => counted(frames, 'finish-step') === steps).then(() => 'streamed');

  expect(await Promise.race([answered, streamed])).toBe('streamed');
}

/** Each activation ends inside the step's own work: the tool starts and never returns, as one that ends its process. */
const POISONED: readonly KinuExtension[] = [{
  name: 'poisoned-step',
  registerTools: () => ({
    poison: tool({ description: 'Ends the process it runs in.', inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }), execute: () => new Promise<string>(() => {}) }),
  }),
}];

/** A model that answers with the poisoned call, and hears each time it is asked. */
function poisonedModel(asked: AwaitedList<true>): StubbedAiBinding {
  return stubAiBinding((run) => {
    asked.push(true);

    return toolCallCompletion(run, { tool: 'poison', args: {} }, 'call_0');
  });
}

test('a turn cut while it waits on the provider, at one step, by six resets in a row, goes on to its one answer', async () => {
  const first = firstActivation();
  let last: StartedHarness = first;
  let at = Date.now();
  await opened(first, 'req-outside', 2);
  await first.waiting;

  try {
    // Five more activations end inside the very call the first ended inside: an outside reset each time, never the
    // step's. Each comes past the backoff a repeated cut earns, so it asks again at once.
    for (let reset = 0; reset < 5; reset += 1) {
      const reached = Promise.withResolvers<void>();

      at += 120_000;
      setSystemTime(new Date(at));
      last = await nextActivation(last, stubAiBinding((run) => {
        const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

        if (step < 2) return toolCallCompletion(run, { tool: 'shell', args: { command: `echo ${String(step + 1)}` } }, `call_${String(step)}`);
        reached.resolve();

        return new Promise<Response>(() => {});
      }));
      await last.started;
      await last.agent.terminalRetryPass();
      await reached.promise;
    }

    const answering = answeringGateway('Three, and done.');
    at += 120_000;
    setSystemTime(new Date(at));
    last = await nextActivation(last, answering);
    await last.started;
    await last.agent.terminalRetryPass();
    const final = last;
    await driveUntil(final, 'the turn never ended', () => claimOf(final, 'req-outside')?.outcome != null);

    expect(claimOf(last, 'req-outside')).toEqual({ outcome: 'completed', epoch: 7 });
    expect(answering.runs.length).toBe(1);
  } finally {
    setSystemTime();
  }
});

test('a step that ends its own process every time it runs is settled at the sixth, not run a seventh', async () => {
  const asked = new AwaitedList<true>();
  let at = Date.now();
  let last = gatewayWorkspace(poisonedModel(asked), { turnExtensions: POISONED });
  await last.started;
  const sender = socketOn(last.agent, 'first-socket', () => {});

  await last.agent.onConnect(sender, CONNECT);
  // Its request is answered only when the turn ends, which no activation here reaches.
  const answered = Promise.resolve(last.agent.onMessage(sender, chatRequest('req-poison'))).then(() => 'answered');
  await asked.until((all) => all.length === 1);
  expect(await Promise.race([answered, Promise.resolve('inside the step')])).toBe('inside the step');

  try {
    for (let run = 2; run <= POISON_WORK_CUTS + 1; run += 1) {
      // Past the backoff a cut in the step's own work earns, so this activation asks again at once.
      at += 120_000;
      setSystemTime(new Date(at));
      last = await reactivateOrchestratorHarness(last.db, undefined, {
        world: { aiGateway: poisonedModel(asked), turnExtensions: POISONED },
        beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
      });
      await last.started;
      await last.agent.terminalRetryPass();
      const current = last;
      await driveUntil(current, `activation ${String(run)} never decided`, () => asked.items.length === run || claimOf(current, 'req-poison')?.outcome != null);
    }
  } finally {
    setSystemTime();
  }

  expect(asked.items.length).toBe(POISON_WORK_CUTS);
  expect(claimOf(last, 'req-poison')).toEqual({ outcome: 'error', epoch: POISON_WORK_CUTS });
});

test('a turn cut inside its own work is asked again only after the backoff, which its wake carries', async () => {
  const asked = new AwaitedList<true>();
  // On a whole second, which is where a wake lands.
  const at = Math.ceil(Date.now() / 1000) * 1000;
  setSystemTime(new Date(at));

  try {
    const first = gatewayWorkspace(poisonedModel(asked), { turnExtensions: POISONED });
    await first.started;
    const sender = socketOn(first.agent, 'first-socket', () => {});

    await first.agent.onConnect(sender, CONNECT);
    const answered = Promise.resolve(first.agent.onMessage(sender, chatRequest('req-backoff'))).then(() => 'answered');
    await asked.until((all) => all.length === 1);
    expect(await Promise.race([answered, Promise.resolve('inside the step')])).toBe('inside the step');

    // A second into the backoff, so the wake's own lap (a pass's next, its 2 s after now) lands after the backoff's end.
    setSystemTime(new Date(at + 1000));
    const answering = answeringGateway('Done.');
    const second = await nextActivation(first, answering);
    await second.started;
    await second.agent.terminalRetryPass();

    // Owed, and not asked yet: the wake is armed for the instant the backoff ends.
    await driveUntil(second, 'the backoff was never armed', () => armedWakes(second.db).some((wake) => wake.time === at + FIRST_WORK_CUT_BACKOFF_MS));
    expect(answering.runs.length).toBe(0);
    expect(claimOf(second, 'req-backoff')?.epoch).toBe(1);

    // The wake fires as the backoff ends, and the process that holds the turn asks it.
    setSystemTime(new Date(at + FIRST_WORK_CUT_BACKOFF_MS));
    await driveUntil(second, 'the turn never ran after its backoff', () => claimOf(second, 'req-backoff')?.outcome != null);
    expect(answering.runs.length).toBe(1);
    expect(claimOf(second, 'req-backoff')).toEqual({ outcome: 'completed', epoch: 2 });
  } finally {
    setSystemTime();
  }
});

test("a person's tab opened during the re-drive draws the steps before the restart, then the rest, while it streams", async () => {
  const first = firstActivation();
  await first.started;
  const sent = new AwaitedList<Frame>();
  const sender = socketOn(first.agent, 'first-socket', (raw) => { sent.push(v.parse(FrameSchema, JSON.parse(raw))); });
  await first.agent.onConnect(sender, CONNECT);
  // A request is answered when its turn ends, which this activation never reaches: it ends inside the third step.
  const answered = Promise.resolve(first.agent.onMessage(sender, chatRequest('req-count'))).then(() => 'answered');
  const streamed = sent.until((frames) => counted(frames, 'finish-step') === 2).then(() => 'two steps streamed');

  expect(await Promise.race([answered, streamed])).toBe('two steps streamed');
  await first.waiting;

  const next = await nextActivation(first, countsUntil(3));
  const tab = new TabSocket();
  const view = await pane(tab);
  await tab.open(next.agent, 'tab-fresh');
  await act(async () => {
    await next.agent.terminalRetryPass();
    await stepDrawn(tab, 2);
  });
  await tab.answered();

  expect(drawnSteps(view.shown())).toEqual(['echo 1: output-available', 'echo 2: output-available', 'echo 3: output-available']);
  await view.close();
});

test("a person's tab that reloads inside a turn draws its finished steps restated from the ledger, once each", async () => {
  const sender = new TabSocket();
  const view = await pane(sender);
  const only = firstActivation();
  await only.started;
  const { asked } = await askedAndTwoSteps(sender, view, only.agent);

  // A reload is a new page: the old one's socket closes, ending its send, and the new pane holds nothing.
  await sender.drop();
  await act(async () => { await asked; });
  await view.close();
  const reloaded = new TabSocket();
  const again = await pane(reloaded);
  await reloaded.open(only.agent, 'tab-reloaded');
  await act(async () => { await reloaded.heard.until((frames) => frames.some((frame) => frame.replayComplete === true)); });
  await reloaded.answered();

  // Restated from the ledger and not relayed again: each call is heard once.
  expect({ drawn: drawnSteps(again.shown()), heard: calls(reloaded.heard.items) })
    .toEqual({ drawn: ['echo 1: output-available', 'echo 2: output-available'], heard: ['call_0', 'call_1'] });
  await again.close();
});
