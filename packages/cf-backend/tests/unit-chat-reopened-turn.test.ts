/**
 * A turn the workspace object's activation ended inside (a deploy, a reset, an eviction) is re-driven by the next
 * activation's wake under a request id that activation mints: the request the client sent lived only in the dead
 * activation's memory. The stream therefore names the turn by its opening message, and the client whose message that
 * is follows the turn there to its end. Defends the F2 probe on staging a4e564ce1 (2026-09-30): a 12-step turn, the
 * activation ended after step 2, all 12 files written, and the eval client failed at the run's end with "the turn's
 * run ended before its stream could be resumed, so its answer was never observed".
 *
 * Measured here (2026-09-30): an open turn's transcript frame holds its user row alone, since the answer row is
 * written at the commit, so after the reset neither a redialled client nor a person's tab holds the steps the dead
 * activation streamed; what the next activation streams is the rest of the answer.
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
  GATEWAY_CATALOG, gatewayWorkspace, reactivateOrchestratorHarness, type HarnessOrchestratorAgent, type StartedHarness,
} from './helpers/actor-harness';
import { answeringGateway, requestOf, stubAiBinding, toolCallCompletion, type StubbedAiBinding } from './helpers/platform-gateway';
import { socketConnection } from './helpers/bindings';

const FrameSchema = v.looseObject({
  type: v.string(), id: v.optional(v.string()), turnId: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()),
});

type Frame = v.InferOutput<typeof FrameSchema>;

const ChunkSchema = v.looseObject({ type: v.string(), delta: v.optional(v.string()) });

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
  const followed = heard.items.filter((frame) => resumed !== undefined && frame.id === resumed.id);

  expect({
    toldPending: heard.items.some((frame) => frame.type === CHAT_MESSAGE_TYPES.STREAM_PENDING),
    resumedTurn: resumed?.turnId,
    rest: followed.flatMap((frame) => chunkOf(frame)?.delta ?? []).join(''),
    ended: followed.at(-1)?.done === true,
  }).toEqual({ toldPending: true, resumedTurn: request, rest, ended: true });
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

test("a person's tab draws the rest of the answer the next activation streams, while it streams", async () => {
  const tab = new TabSocket();
  let shown: readonly UIMessage[] = [];
  let say: (text: string) => Promise<void> = () => Promise.reject(new Error('the pane has not rendered'));

  function Pane(): null {
    // SAFETY: of the socket it is handed, the SDK's hook reads `agent`, `name`, `path`, `_pk`, `getHttpUrl`,
    // `connectionError`, `send` and its message, open and close events (agents/dist/chat/react.js); TabSocket provides each.
    const chat = useAgentChat({ agent: tab as never, getInitialMessages: null, throttle: 0 });
    shown = chat.messages;
    say = (text) => chat.sendMessage({ text });

    return null;
  }

  const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({
    nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: { addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {},
  }));

  const root = createRoot(container);
  await act(async () => { root.render(createElement(Pane)); });

  const first = firstActivation();
  await first.started;
  await tab.open(first.agent, 'tab-first');
  let asked: Promise<void> = Promise.resolve();

  await act(async () => {
    asked = say(ASK);
    await tab.heard.until((frames) => counted(frames, 'finish-step') === 2);
  });

  // Inside the turn's fourth call, so the turn still streams when the tab is read.
  const next = await nextActivation(first, countsUntil(3));
  await tab.drop();
  // The send ends with its socket: the activation that took it ended inside its turn.
  await act(async () => { await asked; });
  await tab.open(next.agent, 'tab-redialled');
  await act(async () => {
    await next.agent.terminalRetryPass();
    await tab.heard.until((frames) => counted(frames, 'tool-output-available') === 1);
  });
  await tab.answered();

  const answer = shown.filter((message) => message.role === 'assistant').at(-1);

  expect(answer?.parts.filter((part) => part.type.startsWith('tool-'))).toMatchObject([
    { type: 'tool-shell', state: 'output-available', input: { command: 'echo 3' } },
  ]);
  await act(async () => { root.unmount(); });
});
