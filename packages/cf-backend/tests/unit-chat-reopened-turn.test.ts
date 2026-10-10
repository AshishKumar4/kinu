/**
 * A turn the root agent's isolate was inside when it ended (a deploy, a reset, an eviction) is re-driven by the isolate
 * that next opens its chat, under a request id the workspace's room mints: the request the client sent lived only in
 * what ended. A tab that redials acks the stream it is told of and draws the turn there to its end; where its own send
 * ended a client asks the workspace (`awaitSend`). Defends the F2 probe on staging a4e564ce1 (2026-09-30): a 12-step
 * turn, the activation ended after step 2, all 12 files written, and the eval client failed at the run's end with "the
 * turn's run ended before its stream could be resumed, so its answer was never observed".
 *
 * The root's turns run in its own isolate (D9), so two boundaries re-open one: the isolate's reset, which the workspace
 * and its sockets outlive (`resetRootIsolate`), and the workspace's reactivation, which closes its sockets and starts
 * its agents' isolates afresh. A client joining an open turn, a tab's reload or a redial into the re-drive, is told the
 * steps finished before the room opened the turn, restated from the isolate's ledger, then the relay's chunks: one path
 * for both. Measured here (2026-10-10): the room asked no ledger once the root's turns left the workspace, so a tab that
 * joined a re-drive drew the rest of the answer without the steps before the restart; and an open turn's transcript
 * frame holds its user row alone, since the answer row is written at the commit.
 *
 * Restored from the in-object suite (c1867c232^) on these boundaries, with two contracts changed:
 * - "An activation ending between a step's seal and its ledger rows" held that window open with a turn extension's
 *   `onToolResult`, a world option of the retired in-object pipeline. A facet turn's extensions are its own
 *   (`facetTurnSources`), so no harness reaches a step's commit, and a step's seal and its rows publish in one fenced
 *   commit (core `sealStep`, 66ef61efc). What it defended on the re-drive, every step's rows once and in order, is held
 *   here across the isolate's reset.
 * - "A turn cut at the same step in two activations is settled, not run a third time" is no longer the rule: D12
 *   (a0cbe05b2) settles a turn only on evidence a cut is its own, six cuts in its step's own work or twenty waiting on
 *   the provider, since two outside resets in one long step ended a turn that should have lived. Its successors are
 *   held here as integration held them before this suite went: six outside resets go on to the one answer, a step that
 *   ends its own process is settled at the sixth, and a cut in its own work is asked again only after the backoff,
 *   which the root's wake now carries from its isolate.
 */
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import type { Connection } from 'agents';
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { AwaitedList } from '@kinu.run/test-utils';
import { createRecordingLogger } from '@kinu.run/core/obs';
import {
  driveUntil, GATEWAY_CATALOG, gatewayWorkspace, ownDatabase, reactivateOrchestratorHarness, tapDiagnostics, workspaceMainActor,
  type HarnessOrchestratorAgent, type StartedHarness,
} from './helpers/actor-harness';
import { answeringGateway, chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type StubbedAiBinding } from './helpers/platform-gateway';
import { abandonHarnessFibers } from './helpers/agents-sdk';
import { agentDatabase, copyNextOpening, copyNextTurnEnd, delayNextTurnEnd, loseNextOpeningAnswer } from './helpers/agent-facets';
import { socketConnection } from './helpers/bindings';

const FrameSchema = v.looseObject({
  type: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), done: v.optional(v.boolean()),
  error: v.optional(v.boolean()), replay: v.optional(v.boolean()), replayComplete: v.optional(v.boolean()),
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

/** What a model counting one shell step a number does at the step it reaches: `held`, the call it never answers, and
 *  `answer`, its words there instead once set. A workspace's isolates share one model across their resets, so a suite
 *  moves `held` only once the isolate it resets is inside the call it holds (`holding`, each step a call was held at). */
interface Count {
  held: number;
  answer: string | null;
  readonly holding: AwaitedList<number>;
}

/** An isolate on it either ends inside the held call or is still inside it. */
function counting(count: Count): StubbedAiBinding {
  return stubAiBinding((run) => {
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

    if (step < count.held) return toolCallCompletion(run, { tool: 'shell', args: { command: `echo ${String(step + 1)}` } }, `call_${String(step)}`);

    if (count.answer !== null) return chatCompletion(run, count.answer);
    count.holding.push(step);

    return new Promise<Response>(() => {});
  });
}

function countsUntil(held: number): StubbedAiBinding {
  return counting({ held, answer: null, holding: new AwaitedList<number>() });
}

/** A chunk the frame carries; a refusal's words are no chunk. */
function chunkOf(frame: Frame): v.InferOutput<typeof ChunkSchema> | null {
  return frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.error !== true && frame.body !== undefined && frame.body !== ''
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

/** Step `index`'s tool output is among `frames`. */
function stepIn(frames: readonly Frame[], index: number): boolean {
  return frames.some((frame) => chunkOf(frame)?.type === 'tool-output-available' && chunkOf(frame)?.toolCallId === `call_${String(index)}`);
}

interface Socket {
  readonly socket: Connection;
  /** It closed: it hears nothing more, and a send to it fails as the platform's does. */
  readonly close: () => void;
}

/** A socket on `agent` that hears every frame sent it, its own and the broadcasts, while it is open. */
function socketOn(agent: HarnessOrchestratorAgent, id: string, hear: (raw: string) => void): Socket {
  const fanout = agent.broadcast.bind(agent);
  let open = true;

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (open && (exclude === undefined || !exclude.includes(id))) hear(message);
      fanout(message, exclude);
    },
  });

  const socket = socketConnection({
    id,
    send: (data: string) => {
      if (!open) throw new TypeError('WebSocket send() after close');
      hear(data);
    },
  });

  return { socket, close: () => { open = false; } };
}

/** Once `tab` holds the open turn's replay whole. */
async function replayedTo(tab: TabSocket): Promise<void> {
  await act(async () => { await tab.heard.until((frames) => frames.some((frame) => frame.replayComplete === true)); });
}

/** Its root agent's isolate resets under a workspace that stays up, whose recovery wakes the next one: that isolate
 *  re-opens the turn the last was inside. */
async function resetRootIsolate(workspace: StartedHarness): Promise<void> {
  const main = workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId);

  workspace.agent.harnessResetAgentIsolate(main.storageKey);
  await workspace.agent.recoverStrandedTurn();
}

/** The next activation over the rows the first left, its model `model`. */
function nextActivation(first: StartedHarness, model: StubbedAiBinding): Promise<StartedHarness> {
  return reactivateOrchestratorHarness(first.db, undefined, {
    world: { aiGateway: model },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });
}

/** A raw socket on `workspace` that sent the ask as request `id`, once the turn's first two steps streamed to it; the
 *  third call is held. The request is answered only when its turn ends. */
async function askedOnSocket(workspace: StartedHarness, id: string): Promise<{ readonly sent: AwaitedList<Frame>; readonly answered: Promise<string> }> {
  await workspace.started;
  const sent = new AwaitedList<Frame>();
  const { socket } = socketOn(workspace.agent, `${id}-socket`, (raw) => { sent.push(v.parse(FrameSchema, JSON.parse(raw))); });

  await workspace.agent.onConnect(socket, CONNECT);
  const answered = Promise.resolve(workspace.agent.onMessage(socket, chatRequest(id))).then(() => 'answered');
  const streamed = sent.until((frames) => counted(frames, 'finish-step') === 2).then(() => 'two steps streamed');

  expect(await Promise.race([answered, streamed])).toBe('two steps streamed');

  return { sent, answered };
}

test("an isolate reset inside a turn leaves the re-driven turn every step's rows once, in order", async () => {
  const models = { [GATEWAY_CATALOG.tiers.default.model]: { id: 'harness', contextWindow: 1_048_576, cost: { input: 1, output: 2 } } };
  const count: Count = { held: 2, answer: null, holding: new AwaitedList<number>() };
  const workspace = gatewayWorkspace(counting(count));

  workspace.agent.harnessCatalogModels(models);
  const { sent } = await askedOnSocket(workspace, 'req-ledger');

  // Its isolate ends inside the third call; the one that re-opens the turn is answered there.
  await count.holding.until((steps) => steps.includes(2));
  count.answer = 'Done.';
  await resetRootIsolate(workspace);
  await sent.until((frames) => frames.some((frame) => frame.done === true && frame.error !== true));
  await workspace.agent.harnessAgentsIdle();
  const [run] = (await workspace.agent.getRunSummaries()).items;

  if (run === undefined) throw new Error('the turn left no run');
  const events = await workspace.agent.getRunEvents(run.runId);

  const row = (type: string, toolCallId: string | undefined): string[] => {
    if (type === 'step_finish') return ['step'];

    return type === 'tool_call_end' ? [`tool ${toolCallId ?? ''}`] : [];
  };

  expect({
    ledger: events.flatMap((event) => row(event.type, event.type === 'tool_call_end' ? event.toolCallId : undefined)),
    timeline: (await workspace.agent.getRunTimeline({ runId: run.runId })).flatMap((span) => row(span.rawType ?? '', span.refId)),
    usage: { input: run.usage.input, output: run.usage.output },
    costs: events.flatMap((event) => event.type === 'step_finish' ? [event.usd] : []),
  }).toEqual({
    ledger: ['tool call_0', 'step', 'tool call_1', 'step', 'step'],
    timeline: ['tool call_0', 'step', 'tool call_1', 'step', 'step'],
    usage: { input: 3, output: 3 },
    costs: [0.000003, 0.000003, 0.000003],
  });
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

/** A tab's socket, the activation it is open on, and what the tab asked of it. */
interface ServedSocket extends Socket {
  readonly agent: HarnessOrchestratorAgent;
  readonly asks: Promise<void>[];
}

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
  private server: ServedSocket | null = null;
  private readonly held: string[] = [];

  getHttpUrl(): string { return 'https://agent/agents/orchestrator-agent/harness-parent'; }

  send(raw: string): void {
    if (this.server === null) this.held.push(raw);
    else this.server.asks.push(Promise.resolve(this.server.agent.onMessage(this.server.socket, raw)));
  }

  /** The socket opens on `agent`: the tab's open event, then the platform's accept. */
  async open(agent: HarnessOrchestratorAgent, id: string): Promise<void> {
    const heard = new AwaitedList<Frame>();

    const opened = socketOn(agent, id, (raw) => {
      heard.push(v.parse(FrameSchema, JSON.parse(raw)));
      this.dispatchEvent(new MessageEvent('message', { data: raw }));
    });

    this.heard = heard;
    await act(async () => {
      this.dispatchEvent(new Event('open'));
      await agent.onConnect(opened.socket, CONNECT);
      this.server = { ...opened, agent, asks: [] };

      for (const raw of this.held.splice(0)) this.send(raw);
    });
  }

  /** The activation ended: the platform closes every socket it held, and what the tab asked of it ends with it. */
  async drop(): Promise<void> {
    this.server?.close();
    this.server = null;
    await act(async () => { this.dispatchEvent(new CloseEvent('close', { code: 1006 })); });
  }

  /** The socket closed under a workspace that lives on, which is told, as the platform tells it. */
  async hangUp(): Promise<void> {
    const server = this.server;

    server?.close();
    this.server = null;
    await act(async () => {
      this.dispatchEvent(new CloseEvent('close', { code: 1006 }));
      await server?.agent.onClose(server.socket, 1006, 'gone', false);
    });
  }

  /** Everything the tab asked of the activation it is open on, answered. */
  async answered(): Promise<void> {
    await act(async () => { await Promise.all(this.server?.asks ?? []); });
  }
}

/** A person's pane: what it draws, its send and its resume, and its unmount. */
interface PaneView {
  readonly shown: () => readonly UIMessage[];
  readonly say: (text: string) => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** A person's pane on `tab`, over the shipped hook. */
async function pane(tab: TabSocket): Promise<PaneView> {
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
async function askedAndTwoSteps(tab: TabSocket, view: PaneView, agent: HarnessOrchestratorAgent): Promise<{ readonly asked: Promise<void> }> {
  await tab.open(agent, 'tab-first');
  let asked: Promise<void> = Promise.resolve();

  await act(async () => {
    asked = view.say(ASK);
    await tab.heard.until((frames) => counted(frames, 'finish-step') === 2);
  });

  return { asked };
}

/** The workspace's fence on a turn (design v3 B): an opening under an older claim than one the running turn was opened
 *  at again, delayed past that re-opening, is refused, and still is once the workspace has reset. */
test('an opening of a turn older than its re-opening is refused, before and after the workspace resets', async () => {
  const count: Count = { held: 2, answer: null, holding: new AwaitedList<number>() };
  const workspace = gatewayWorkspace(counting(count));
  const main = workspaceMainActor(workspace.db).actorId;
  const copied = copyNextOpening(workspace.agent.agentOf(main).storageKey);
  await askedOnSocket(workspace, 'req-fence');
  const opening = await copied;

  // Its isolate ends inside the third call; the one that re-opens the turn, at the next epoch, runs that step and is
  // inside the next.
  await count.holding.until((steps) => steps.includes(2));
  count.held = 3;
  await resetRootIsolate(workspace);
  await count.holding.until((steps) => steps.includes(3));

  // Through each activation's own entry for the agent, as the agent's relay reaches it.
  await expect((await workspace.agent.agentWorkspace(main)).prepareChat(opening)).rejects.toThrow('is older than the agent');
  const restarted = await reactivateOrchestratorHarness(workspace.db);
  await expect((await restarted.agent.agentWorkspace(main)).prepareChat(opening)).rejects.toThrow('is older than the agent');
});

/** The turns the workspace's evolution window recorded. */
function recordedTurns(workspace: StartedHarness): number {
  return v.parse(v.object({ n: v.number() }), workspace.db.query('SELECT COUNT(*) AS n FROM completed_turns').get()).n;
}

/** Asks `id` on a socket of its own and answers once its turn has ended. */
async function askedAndAnswered(workspace: StartedHarness, id: string): Promise<void> {
  await workspace.started;
  const { socket } = socketOn(workspace.agent, `${id}-socket`, () => {});

  await workspace.agent.onConnect(socket, CONNECT);
  await workspace.agent.onMessage(socket, chatRequest(id));
}

/** The fence keeps every turn the agent opened: one that ended is no opening's, before or after the workspace resets,
 *  and a refused opening leaves the later turn's fence as it was. */
test("an opening of a turn delivered after the agent's next turn opened is refused, before and after the workspace resets", async () => {
  const workspace = gatewayWorkspace(counting({ held: 0, answer: 'Done.', holding: new AwaitedList<number>() }));
  const main = workspaceMainActor(workspace.db).actorId;
  const copied = copyNextOpening(workspace.agent.agentOf(main).storageKey);

  await askedAndAnswered(workspace, 'req-first');
  const first = await copied;
  await askedAndAnswered(workspace, 'req-second');

  await expect((await workspace.agent.agentWorkspace(main)).prepareChat(first)).rejects.toThrow('is older than the agent');
  const restarted = await reactivateOrchestratorHarness(workspace.db);
  await expect((await restarted.agent.agentWorkspace(main)).prepareChat(first)).rejects.toThrow('is older than the agent');
});

/** The workspace keeps the facts it first offered a turn until the agent's copy is durable (design v2 §2): an isolate
 *  that died after the workspace prepared the turn and before freezing them, with learning turned off meanwhile, is
 *  offered the first facts again, and the turn is recorded as it opened. */
test('a turn whose isolate died between its preparation and freezing its facts keeps the facts first prepared', async () => {
  const workspace = gatewayWorkspace(counting({ held: 0, answer: 'Done.', holding: new AwaitedList<number>() }));
  const main = workspaceMainActor(workspace.db).actorId;
  const preparedThenLost = loseNextOpeningAnswer(workspace.agent.agentOf(main).storageKey);

  await workspace.started;
  const { socket } = socketOn(workspace.agent, 'req-facts-socket', () => {});

  await workspace.agent.onConnect(socket, CONNECT);
  const answered = Promise.resolve(workspace.agent.onMessage(socket, chatRequest('req-facts')));

  await preparedThenLost;
  workspaceMainActor(workspace.db).config.setLearning(false);
  await resetRootIsolate(workspace);
  await answered;

  await driveUntil(workspace, 'the turn was never recorded under the facts it opened with', () => recordedTurns(workspace) === 1);
});

/** The turn's end is its run's (design v3 B): an end delayed past the agent's next opening, delivered to the workspace
 *  after it reset, is that earlier run's, and ends nothing of the run now open; the next turn opens as ever. */
test("a turn's end delayed past the next turn's opening ends nothing, after the workspace resets", async () => {
  const workspace = gatewayWorkspace(counting({ held: 0, answer: 'Done.', holding: new AwaitedList<number>() }));
  const main = workspaceMainActor(workspace.db).actorId;
  const copied = copyNextTurnEnd(workspace.agent.agentOf(main).storageKey);

  await askedAndAnswered(workspace, 'req-first');
  const firstEnd = await copied;
  const restarted = await reactivateOrchestratorHarness(workspace.db);

  await askedAndAnswered(restarted, 'req-second');
  // Tapped after the reset: an activation installs its own sink.
  const log = createRecordingLogger();
  const untap = tapDiagnostics(log);

  try {
    await (await restarted.agent.agentWorkspace(main)).turnEnded(...firstEnd);

    expect(log.emitted.filter((line) => line.event === 'agent.stale_turn_end')).toHaveLength(1);
    await askedAndAnswered(restarted, 'req-third');
  } finally {
    untap();
  }
});

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
  const first = gatewayWorkspace(countsUntil(2));
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
    await tab.heard.until((frames) => stepIn(frames, 2));
  });
  await tab.answered();
  const afterOne = drawnSteps(view.shown());

  const third = await nextActivation(second, countsUntil(4));
  await tab.drop();
  await tab.open(third.agent, 'tab-third');
  await act(async () => {
    await third.agent.terminalRetryPass();
    await tab.heard.until((frames) => stepIn(frames, 3));
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

/** Longer than any backoff a cut earns, which the shared one caps at a minute: an activation this far on asks at once. */
const PAST_BACKOFF_MS = 120_000;

/** The shared backoff after a first cut in a step's own work (`recoveryBackoffMs(1)`). */
const FIRST_WORK_CUT_BACKOFF_MS = 2000;

/** The claim of the root's turn `id`, in its own isolate's database, as the next decision reads it. */
function claimOf(harness: StartedHarness, id: string): { outcome: string | null; epoch: number } | null {
  return ownDatabase(harness, workspaceMainActor(harness.db).actorId)
    .query<{ outcome: string | null; epoch: number }, [string]>('SELECT outcome, epoch FROM actor_turn_claims WHERE turn_id = ?').get(id);
}

/** When the workspace will next wake its root agent's isolate, as the platform's queue holds it; null for no wake. */
function rootWakeAt(harness: StartedHarness): number | null {
  return harness.db.query<{ time: number }, []>("SELECT time FROM cf_agents_jobs WHERE capability = 'kinu-agent-wakes' ORDER BY time LIMIT 1").get()?.time ?? null;
}

/** Each time a run's poisoned step began its work. */
const poisoned = new AwaitedList<true>();

Object.assign(globalThis, { [Symbol.for('kinu.test.poisoned')]: () => { poisoned.push(true); } });

/** A step's own work that never returns, as one that ends the process it runs in: a hold the harness can name. */
const POISON = "globalThis[Symbol.for('kinu.test.poisoned')](); await globalThis[Symbol.for('kinu.test.hold')]('the poisoned step');";

/** A model that answers with the poisoned call, and hears each time it is asked. Each call is a fresh one: a claimed
 *  call's id is never run twice, so the same id again would be answered at once, and the step would not end anything. */
function poisonedModel(asked: AwaitedList<true>): StubbedAiBinding {
  return stubAiBinding((run) => {
    asked.push(true);

    return toolCallCompletion(run, { tool: 'eval', args: { code: POISON } }, `call_${String(asked.items.length)}`);
  });
}

/** The next activation, `after` on, over a workspace whose last left a step's work parked: the reset drops it. */
async function nextActivationAt(last: StartedHarness, model: StubbedAiBinding, after: number): Promise<StartedHarness> {
  abandonHarnessFibers();
  setSystemTime(new Date(after));
  const next = await nextActivation(last, model);

  await next.started;
  await next.agent.terminalRetryPass();

  return next;
}

/** A raw socket on `workspace` that sent the ask as request `id`, once the turn's poisoned step began its work; the
 *  request is answered only when its turn ends, which no activation here reaches. */
async function poisonedOnSocket(workspace: StartedHarness, id: string): Promise<void> {
  const before = poisoned.items.length;

  await workspace.started;
  const { socket } = socketOn(workspace.agent, `${id}-socket`, () => {});

  await workspace.agent.onConnect(socket, CONNECT);
  const answered = Promise.resolve(workspace.agent.onMessage(socket, chatRequest(id))).then(() => 'answered');

  expect(await Promise.race([answered, poisoned.until((all) => all.length > before).then(() => 'inside the step')])).toBe('inside the step');
}

test('a turn its workspace is reset under six times in a row, at one step while it waits on the provider, goes on to its one answer', async () => {
  const holding = new AwaitedList<number>();
  const first = gatewayWorkspace(counting({ held: 2, answer: null, holding }));
  let last: StartedHarness = first;
  let at = Date.now();

  await askedOnSocket(first, 'req-outside');
  await holding.until((steps) => steps.includes(2));

  try {
    // Five more activations end inside the very call the first ended inside: an outside reset each time, never the
    // step's. Each comes past the backoff a repeated cut earns, so it asks again at once.
    for (let reset = 0; reset < 5; reset += 1) {
      const again = new AwaitedList<number>();

      at += PAST_BACKOFF_MS;
      last = await nextActivationAt(last, counting({ held: 2, answer: null, holding: again }), at);
      await again.until((steps) => steps.includes(2));
    }

    const answering = answeringGateway('Three, and done.');

    at += PAST_BACKOFF_MS;
    last = await nextActivationAt(last, answering, at);
    const final = last;
    await driveUntil(final, 'the turn never ended', () => claimOf(final, 'req-outside')?.outcome != null);

    expect(claimOf(final, 'req-outside')).toEqual({ outcome: 'completed', epoch: 7 });
    expect(answering.runs.filter((run) => openingOf(run) === ASK)).toHaveLength(1);
  } finally {
    setSystemTime();
  }
});

test('a step that ends its own process every time it runs is settled at the sixth, not run a seventh', async () => {
  const asked = new AwaitedList<true>();
  const first = gatewayWorkspace(poisonedModel(asked));
  const before = poisoned.items.length;
  let last: StartedHarness = first;
  let at = Date.now();

  await poisonedOnSocket(first, 'req-poison');

  try {
    // Each activation is inside the step's work, as the last was, before the next one starts.
    for (let run = 2; run <= POISON_WORK_CUTS; run += 1) {
      at += PAST_BACKOFF_MS;
      last = await nextActivationAt(last, poisonedModel(asked), at);
      await poisoned.until((all) => all.length - before === run);
    }

    // The seventh decides the turn as its isolate takes it up.
    at += PAST_BACKOFF_MS;
    last = await nextActivationAt(last, poisonedModel(asked), at);
    const final = last;
    await driveUntil(final, 'the seventh activation never decided the turn', () => claimOf(final, 'req-poison')?.outcome != null);
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
    const first = gatewayWorkspace(poisonedModel(asked));

    await poisonedOnSocket(first, 'req-backoff');

    // A second into the backoff, so the wake's own lap lands after the backoff's end.
    const answering = answeringGateway('Done.');
    const second = await nextActivationAt(first, answering, at + 1000);

    // Owed, and not asked yet: the root's wake is armed for the instant the backoff ends.
    await driveUntil(second, 'the backoff was never armed', () => rootWakeAt(second) === at + FIRST_WORK_CUT_BACKOFF_MS);
    expect(answering.runs.length).toBe(0);
    expect(claimOf(second, 'req-backoff')?.epoch).toBe(1);

    // The wake fires as the backoff ends, and the isolate that holds the turn asks it.
    setSystemTime(new Date(at + FIRST_WORK_CUT_BACKOFF_MS));
    await driveUntil(second, 'the turn never ran after its backoff', () => claimOf(second, 'req-backoff')?.outcome != null);
    expect(answering.runs.filter((run) => openingOf(run) === ASK)).toHaveLength(1);
    expect(claimOf(second, 'req-backoff')).toEqual({ outcome: 'completed', epoch: 2 });
  } finally {
    setSystemTime();
  }
});

test("a person's tab opened while its agent's isolate re-drives the turn draws the steps before the reset, then the rest, while it streams", async () => {
  const count: Count = { held: 2, answer: null, holding: new AwaitedList<number>() };
  const workspace = gatewayWorkspace(counting(count));
  const { sent } = await askedOnSocket(workspace, 'req-count');

  // Its isolate ends inside the third call; the one that re-opens the turn runs that step and is still inside the next.
  await count.holding.until((steps) => steps.includes(2));
  count.held = 3;
  await resetRootIsolate(workspace);
  await sent.until((frames) => stepIn(frames, 2));
  const tab = new TabSocket();
  const view = await pane(tab);

  await tab.open(workspace.agent, 'tab-fresh');
  await replayedTo(tab);
  await tab.answered();

  expect(drawnSteps(view.shown())).toEqual(['echo 1: output-available', 'echo 2: output-available', 'echo 3: output-available']);
  await view.close();
});

// The isolate's run closes with its commit, before its room hears the turn end: a tab joining in between is replayed the
// steps before the reset from that closed run, by its id, then the relay's. Its transcript frame already holds the
// committed answer, so the replay's own frames are what is judged.
test("a person's tab that joins a re-driven turn whose run closed before its room heard it end is replayed every step once", async () => {
  const count: Count = { held: 2, answer: null, holding: new AwaitedList<number>() };
  const workspace = gatewayWorkspace(counting(count));
  const main = workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId);
  await askedOnSocket(workspace, 'req-closed');

  await count.holding.until((steps) => steps.includes(2));
  count.held = 3;
  count.answer = 'Counted to three.';
  const ending = delayNextTurnEnd(main.storageKey);
  await resetRootIsolate(workspace);
  await ending.reached;
  const OpenSchema = v.object({ n: v.number() });
  const open = v.parse(OpenSchema, agentDatabase(workspace.db, main.storageKey).query('SELECT COUNT(*) AS n FROM open_turns').get()).n;
  const tab = new TabSocket();
  const view = await pane(tab);

  await tab.open(workspace.agent, 'tab-late');
  await replayedTo(tab);
  ending.release();
  await tab.answered();

  expect({ open, replayed: calls(tab.heard.items.filter((frame) => frame.replay === true)), drawn: drawnSteps(view.shown()) }).toEqual({
    open: 0, replayed: ['call_0', 'call_1', 'call_2'],
    drawn: ['echo 1: output-available', 'echo 2: output-available', 'echo 3: output-available'],
  });
  await view.close();
});

test("a person's tab opened during the re-drive after a restart draws the steps before the restart, then the rest, while it streams", async () => {
  const first = gatewayWorkspace(countsUntil(2));

  await askedOnSocket(first, 'req-restart');
  const next = await nextActivation(first, countsUntil(3));
  const tab = new TabSocket();
  const view = await pane(tab);

  await tab.open(next.agent, 'tab-fresh');
  await act(async () => {
    await next.agent.terminalRetryPass();
    await tab.heard.until((frames) => stepIn(frames, 2));
  });
  await tab.answered();

  expect(drawnSteps(view.shown())).toEqual(['echo 1: output-available', 'echo 2: output-available', 'echo 3: output-available']);
  await view.close();
});

// The room opened this turn at its first step, so its relay holds every step whole: the ledger is not asked.
test("a person's tab that reloads inside a turn draws its finished steps once each", async () => {
  const sender = new TabSocket();
  const view = await pane(sender);
  const only = gatewayWorkspace(countsUntil(2));
  await only.started;
  const { asked } = await askedAndTwoSteps(sender, view, only.agent);

  // A reload is a new page: the old one's socket closes, ending its send, and the new pane holds nothing.
  await sender.hangUp();
  await act(async () => { await asked; });
  await view.close();
  const reloaded = new TabSocket();
  const again = await pane(reloaded);
  await reloaded.open(only.agent, 'tab-reloaded');
  await replayedTo(reloaded);
  await reloaded.answered();

  // Replayed and not relayed again: each call is heard once.
  expect({ drawn: drawnSteps(again.shown()), heard: calls(reloaded.heard.items) })
    .toEqual({ drawn: ['echo 1: output-available', 'echo 2: output-available'], heard: ['call_0', 'call_1'] });
  await again.close();
});
