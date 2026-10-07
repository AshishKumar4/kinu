/**
 * A turn the workspace object's activation ended inside (a deploy, a reset, an eviction) is re-driven by the next
 * activation's wake under a request id that activation mints: the request the client sent lived only in the dead
 * activation's memory. The stream therefore names the turn by its opening message, and the client whose message that
 * is follows the turn there to its end. Defends the F2 probe on staging a4e564ce1 (2026-09-30): a 12-step turn, the
 * activation ended after step 2, all 12 files written, and the eval client failed at the run's end with "the turn's
 * run ended before its stream could be resumed, so its answer was never observed".
 *
 * A client joining an open turn, a tab's reload or a redial into the activation that re-drives it, is told the steps
 * the ledger records first, restated from it, then the relay's chunks of the steps after them: one path for both.
 * Measured here (2026-09-30): an open turn's transcript frame holds its user row alone, since the answer row is
 * written at the commit, and the next activation's relay holds only what it streamed itself, so before the restated
 * steps a tab that joined the re-drive drew the rest of the answer without the steps before the restart.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import type { Connection } from 'agents';
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { AwaitedList } from '@kinu.run/test-utils';
import {
  alarmDue, GATEWAY_CATALOG, gatewayWorkspace, reactivateOrchestratorHarness, type HarnessOrchestratorAgent, type StartedHarness,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { answeringGateway, requestOf, stubAiBinding, toolCallCompletion, type StubbedAiBinding } from './helpers/platform-gateway';
import { socketConnection } from './helpers/bindings';

const FrameSchema = v.looseObject({
  type: v.string(), id: v.optional(v.string()), turnId: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()),
  replayComplete: v.optional(v.boolean()), restated: v.optional(v.boolean()),
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
 *  ends inside it or is still inside it. */
function countsUntil(held: number): StubbedAiBinding {
  return stubAiBinding((run) => {
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

    if (step >= held) return new Promise<Response>(() => {});

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

/** The first activation, inside the turn's third model call when it ends; the second steps never stream. */
function firstActivation(): StartedHarness {
  return gatewayWorkspace(countsUntil(2));
}

/** The next activation over the rows the first left, its model `model`. */
function nextActivation(first: StartedHarness, model: StubbedAiBinding): Promise<StartedHarness> {
  return reactivateOrchestratorHarness(first.db, undefined, {
    world: { aiGateway: model },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });
}

test('the client whose request opened a turn follows it into the activation that re-opens it, to its end', async () => {
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

  const next = await nextActivation(first, answeringGateway(rest));
  // The client redials before the wake re-drives the turn: the redial is what activates the object.
  const heard = new AwaitedList<Frame>();
  const acks: Promise<void>[] = [];

  const socket: Connection = socketOn(next.agent, 'redialled-socket', (raw) => {
    const frame = v.parse(FrameSchema, JSON.parse(raw));
    heard.push(frame);

    // The client acks a stream named for its own turn, whatever request id the activation gave it.
    if (frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING && (frame.id === request || frame.turnId === request)) {
      acks.push(Promise.resolve(next.agent.onMessage(socket, JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: frame.id }))));
    }
  });

  await next.agent.onConnect(socket, CONNECT);
  await next.agent.terminalRetryPass();
  await heard.until((frames) => frames.some((frame) => frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.done === true));
  await Promise.all(acks);

  const resumed = heard.items.find((frame) => frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING);
  const followed = heard.items.filter((frame) => resumed !== undefined && frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.id === resumed.id);
  const restated = followed.filter((frame) => frame.restated === true);

  // The two steps before the restart are restated from the ledger, ahead of every chunk the relay holds, and marked
  // so a client that streamed them before can skip them; the relay adds the answer's own step.
  expect({
    toldPending: heard.items.some((frame) => frame.type === CHAT_MESSAGE_TYPES.STREAM_PENDING),
    resumedTurn: resumed?.turnId,
    restated: calls(restated),
    restatedFirst: followed.slice(0, restated.length + 1).every((frame) => frame.restated === true || chunkOf(frame)?.type === 'start'),
    calls: calls(followed),
    cuts: counted(followed, 'data-kinu-step-cut'),
    steps: counted(followed, 'finish-step'),
    rest: followed.flatMap((frame) => chunkOf(frame)?.delta ?? []).join(''),
    ended: followed.at(-1)?.done === true,
  }).toEqual({
    toldPending: true, resumedTurn: request, restated: ['call_0', 'call_1'], restatedFirst: true, calls: ['call_0', 'call_1'],
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

  // Each activation ends inside the call after the step it runs, so the turn still streams when the tab is read.
  const second = await nextActivation(first, countsUntil(3));
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

  const third = await nextActivation(second, countsUntil(4));
  await tab.drop();
  await tab.open(third.agent, 'tab-third');
  await act(async () => {
    await third.agent.terminalRetryPass();
    await stepDrawn(tab, 3);
  });
  await tab.answered();

  expect({ afterOne, afterTwo: drawnSteps(view.shown()) }).toEqual({
    afterOne: ['echo 1: output-available', 'echo 2: output-available', 'echo 3: output-available'],
    afterTwo: ['echo 1: output-available', 'echo 2: output-available', 'echo 3: output-available', 'echo 4: output-available'],
  });
  await view.close();
});

test('a turn cut at the same step in two activations is settled, not run a third time', async () => {
  const first = firstActivation();
  await first.started;
  const sent = new AwaitedList<Frame>();
  const sender = socketOn(first.agent, 'first-socket', (raw) => { sent.push(v.parse(FrameSchema, JSON.parse(raw))); });

  await first.agent.onConnect(sender, CONNECT);
  // Its request is answered only when the turn ends, which no activation here reaches.
  const answered = Promise.resolve(first.agent.onMessage(sender, chatRequest('req-stall'))).then(() => 'answered');
  const streamed = sent.until((frames) => counted(frames, 'finish-step') === 2).then(() => 'two steps streamed');

  expect(await Promise.race([answered, streamed])).toBe('two steps streamed');

  // The re-drive reaches the very call the first activation ended inside, and ends inside it again.
  const reached = Promise.withResolvers<void>();

  const again = stubAiBinding((run) => {
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

    if (step < 2) return toolCallCompletion(run, { tool: 'shell', args: { command: `echo ${String(step + 1)}` } }, `call_${String(step)}`);
    reached.resolve();

    return new Promise<Response>(() => {});
  });

  const second = await nextActivation(first, again);
  await second.agent.terminalRetryPass();
  await reached.promise;

  const third = answeringGateway('Three, and done.');
  const last = await nextActivation(second, third);
  await last.agent.terminalRetryPass();

  if (alarmDue(last.db)) await last.agent.alarm();
  await joinHarnessFibers();

  // Two runs ended at one step: the turn is closed rather than handed the same cut a third time.
  expect(third.runs.length).toBe(0);
  expect(last.db.query<{ outcome: string | null; epoch: number }, []>(`SELECT outcome, epoch FROM actor_turn_claims WHERE turn_id = 'req-stall'`).all())
    .toEqual([{ outcome: 'error', epoch: 2 }]);
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

  expect({
    drawn: drawnSteps(again.shown()),
    restated: calls(reloaded.heard.items.filter((frame) => frame.restated === true)),
    relayed: calls(reloaded.heard.items.filter((frame) => frame.restated !== true)),
  }).toEqual({ drawn: ['echo 1: output-available', 'echo 2: output-available'], restated: ['call_0', 'call_1'], relayed: [] });
  await again.close();
});
