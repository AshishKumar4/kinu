import { afterEach, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import type { UIMessageChunk } from 'ai';
import { ChatWireTransport, type ChatSocket } from '../../cf-backend/src/chat-transport';
import {
  JsonArraySchema, JsonObjectSchema, parseJsonObject, hostedActorSocketPath, hostedWindowMay,
  ChatHistoryEntrySchema, restoredRows,
  type JsonObject, type JsonValue, type ReasoningEffort,
} from '@kinu.run/core';
import { CloudAgentClient } from '../src/cloud-agent-client';
import { renderAccountSpendLines } from '../src/display';
import { watchDeviceConsents } from '../src/consent-watch';
import type { AgentClientEvent } from '../src/agent-client';
import * as v from 'valibot';

interface MockAgentServer {
  server: Server<unknown>;
  origin: string;
  frames: JsonObject[];
  ticketRequests: Array<{ name: string; auth: string | null }>;
  connectUrls: URL[];
  rpcRequests: Array<{ method: string; args: JsonValue[] }>;
  /** What `getExecutors` answers, as the workspace's router lists them. */
  executors: JsonObject[];
  /** The DO chat projection rows. */
  chatMessages: Array<{ id: string; role: string; content: string; createdAt: number; metadata?: JsonObject }>;
  socket(): ServerWebSocket<unknown>;
  reply(frame: JsonObject): void;
  close(): Promise<void>;
}

const servers: MockAgentServer[] = [];

const pendingReads = new Map<() => void, () => void>();

function observedState(): void {
  for (const read of pendingReads.keys()) read();
}

const MENU_EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

/** A model declaring its own reasoning levels, as the hub's menu lists it. */
const MENU_MODEL = { spec: 'openai/gpt-5.5', label: 'GPT-5.5', provider: 'openai', reasoningEfforts: MENU_EFFORTS };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((mock) => mock.close()));

  for (const fail of pendingReads.values()) fail();
  pendingReads.clear();
});

/** `getActivitySnapshot`'s spend as a deployment before 6de08b071 answers it: no `accounts`. */
const SPEND_BEFORE_ACCOUNTS = {
  producers: [],
  total: { calls: 3, callsWithoutUsage: 0, usage: { input: 1200, output: 300 }, usd: 0.01, unpricedCalls: 0 },
  coverage: { calls: 3, measured: 3, reported: null, silent: [], partial: [] },
  offTurnShare: null,
  missions: [],
};

/** `serve` answers a socket frame as it lands, as the workspace object would; null leaves it to the test. */
function startMockAgentServer(options: ({
  holdTicketAt: number;
  ticketGate: Promise<void>;
  onTicketReleased(): void;
} | Record<never, never>) & { serve?: (frame: JsonObject) => JsonObject | null } = {}): MockAgentServer {
  const frames: JsonObject[] = [];
  const ticketRequests: Array<{ name: string; auth: string | null }> = [];
  const connectUrls: URL[] = [];
  const rpcRequests: MockAgentServer['rpcRequests'] = [];
  const chatMessages: MockAgentServer['chatMessages'] = [];
  let executors: JsonObject[] = [];
  let ws: ServerWebSocket<unknown> | null = null;

  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const ticketMatch = url.pathname.match(/^\/api\/cli\/workspaces\/([^/]+)\/connect-ticket$/);

      if (ticketMatch && req.method === 'POST') {
        ticketRequests.push({
          name: decodeURIComponent(ticketMatch[1]),
          auth: req.headers.get('authorization'),
        });
        observedState();

        if ('holdTicketAt' in options && ticketRequests.length === options.holdTicketAt) {
          await options.ticketGate;
          options.onTicketReleased();
        }

        return Response.json({ ticket: 'pat_test', expiresAt: Date.now() + 60_000 });
      }

      if (url.pathname === '/api/cli/models' && req.method === 'GET') {
        return Response.json({ models: [MENU_MODEL], failures: [] });
      }

      if (/^\/api\/cli\/workspaces\/[^/]+\/rpc$/.test(url.pathname) && req.method === 'POST') {
        const request = v.parse(JsonObjectSchema, await req.json());
        const method = v.parse(v.string(), request.method);
        const parsedArgs = v.safeParse(JsonArraySchema, request.args);
        const args = parsedArgs.success ? parsedArgs.output : [];
        rpcRequests.push({ method, args });
        observedState();

        // Pages of two, so a client that reads only the first page fails.
        if (method === 'getChatHistoryPage') {
          const cursor = v.parse(v.optional(v.object({ cursor: v.optional(v.object({ before: v.number() })) })), args[0]);
          const end = cursor?.cursor?.before ?? chatMessages.length;
          const start = Math.max(0, end - 2);
          const items = chatMessages.slice(start, end).map((message, offset) => ({ ...message, position: start + offset }));

          return Response.json({
            result: start === 0 ? { status: 'end', items } : { status: 'more', items, next: { before: start } },
          });
        }

        if (method === 'getReasoningEffort') return Response.json({ result: { effort: 'medium' } });

        if (method === 'getExecutors') return Response.json({ result: executors });

        if (method === 'getActivitySnapshot') return Response.json({ result: { spend: SPEND_BEFORE_ACCOUNTS } });

        if (method === 'setReasoningEffort') return Response.json({ result: { ok: true, effort: args[0] ?? null } });

        if (method === 'renameSubordinateAgent') {
          const [name, displayName] = v.parse(v.tuple([v.string(), v.string()]), args);

          return Response.json({
            result: {
              ok: true,
              name,
              displayName,
              subordinate: {
                name,
                displayName,
                nameOrigin: 'user',
                role: 'task',
                origin: 'user',
                status: 'idle',
                currentTask: null,
                createdAt: 1,
                dismissedAt: null,
              },
            },
          });
        }

        return Response.json({ error: `No such agent RPC method: ${method}` }, { status: 404 });
      }

      if (url.pathname.startsWith('/agents/orchestrator-agent/')) {
        connectUrls.push(url);
        observedState();

        if (srv.upgrade(req)) return;

        return new Response('upgrade failed', { status: 400 });
      }

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(socket) { ws = socket; },
      message(socket, message) {
        const frame = parseJsonObject(String(message));
        const answer = options.serve?.(frame) ?? null;

        frames.push(frame);
        observedState();

        if (answer !== null) socket.send(JSON.stringify(answer));
      },
    },
  });

  const mock: MockAgentServer = {
    server,
    origin: `http://localhost:${server.port}`,
    frames,
    ticketRequests,
    connectUrls,
    rpcRequests,
    get executors() { return executors; },
    set executors(next) { executors = next; },
    chatMessages,
    socket() {
      if (!ws) throw new Error('no websocket connection yet');

      return ws;
    },
    reply(frame) {
      this.socket().send(JSON.stringify(frame));
    },
    async close() {
      await server.stop(true);
    },
  };

  servers.push(mock);

  return mock;
}

async function waitFor<T>(probe: () => T | undefined, label: string): Promise<T> {
  const present = probe();

  if (present !== undefined) return present;

  return new Promise<T>((resolve, reject) => {
    const changed = (): void => {
      let value: T | undefined;

      try { value = probe(); }
      catch (cause) {
        pendingReads.delete(changed);
        reject(cause);

        return;
      }

      if (value === undefined) return;
      pendingReads.delete(changed);
      resolve(value);
    };

    pendingReads.set(changed, () => { reject(new Error(label + ': the fixtures closed before the observation')); });
    changed();
  });
}

function newClient(mock: MockAgentServer): CloudAgentClient {
  const client = new CloudAgentClient({
    origin: mock.origin,
    token: 'ptc_token',
    agentName: 'helios',
    cloudName: 'helios',
    transcript: { noTranscript: true },
  });

  client.subscribe(() => { queueMicrotask(observedState); });

  return client;
}

interface ChatRequestFrame {
  id: string;
  body: JsonObject;
}

const ChatRequestEnvelopeSchema = v.object({
  id: v.string(),
  init: v.object({ body: v.string() }),
});

const ChatMessagesSchema = v.array(v.object({ role: v.string(), parts: v.array(JsonObjectSchema) }));

function chatRequestFrame(mock: MockAgentServer): ChatRequestFrame {
  const frame = mock.frames.find((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST);

  if (!frame) throw new Error('no chat request frame received');
  const envelope = v.parse(ChatRequestEnvelopeSchema, frame);

  return { id: envelope.id, body: parseJsonObject(envelope.init.body) };
}

async function firstChatRequest(mock: MockAgentServer): Promise<ChatRequestFrame> {
  return waitFor(
    () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
    'chat request frame',
  );
}

function responseChunk(id: string, chunk: JsonObject, done = false) {
  return { type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id, body: JSON.stringify(chunk), done };
}

function emittedTextAndCuts(events: readonly AgentClientEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'text-delta') return [event.delta];

    return event.type === 'step-cut' ? [`cut ${event.stepIndex}`] : [];
  });
}

/** Step 1 (`one, `) as the DO restates it from the ledger in a replay. */
const RESTATED_STEP_ONE: readonly JsonObject[] = [
  { type: 'start-step' }, { type: 'text-start', id: 'r' }, { type: 'text-delta', id: 'r', delta: 'one, ' }, { type: 'text-end', id: 'r' }, { type: 'finish-step' },
];

describe('CloudAgentClient protocol', () => {
  test('paged history retains the same event metadata as the browser transcript', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const metadata = { kinuEvent: 'background_job', jobId: 'job-1', audit: { source: 'runtime' } };
    const row = { id: 'event-1', role: 'system', content: 'The job completed.', createdAt: 1, metadata };
    mock.chatMessages.push(row,
      { id: 'user-2', role: 'user', content: 'continue', createdAt: 2 },
      { id: 'assistant-3', role: 'assistant', content: 'done', createdAt: 3 });

    try {
      const history = await client.history();
      expect(history.map((message) => message.id)).toEqual(['event-1', 'user-2', 'assistant-3']);
      expect(history[0]?.metadata).toEqual(metadata);
      expect(restoredRows([v.parse(ChatHistoryEntrySchema, { ...row, position: 0 })])[0]?.metadata).toEqual(history[0]?.metadata);
    } finally {
      await client.close();
    }
  });

  test('history rejects an empty row identity, matching the browser admission rule', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    mock.chatMessages.push({ id: '', role: 'user', content: 'unaddressable', createdAt: 1 });

    try {
      await expect(client.history()).rejects.toThrow('Invalid length: Expected !0 but received 0');
    } finally {
      await client.close();
    }
  });

  test('the model menu keeps the reasoning levels each model declares', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    try {
      const { models } = await client.listModels();
      expect(models.map((model) => [model.spec, model.reasoningEfforts])).toEqual([[MENU_MODEL.spec, MENU_MODEL.reasoningEfforts]]);
    } finally {
      await client.close();
    }
  });

  test('spend from a server before per-account spend keeps its totals and says accounts are not reported', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    try {
      const spend = await client.workspaceSpend();

      expect([spend.total.calls, spend.total.usage]).toEqual([3, { input: 1200, output: 300 }]);
      expect(renderAccountSpendLines(spend.accounts, Date.now())).toEqual(['Spend per account: this deployment does not report it.']);
    } finally {
      await client.close();
    }
  });

  test('reasoning effort reads and writes through the agent RPC seam', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    await expect(client.getReasoningEffort()).resolves.toBe('medium');
    await expect(client.setReasoningEffort('high')).resolves.toEqual({ effort: 'high' });
    await client.close();
  });

  test('opens a created cloud additional agent and renames it through its parent workspace', async () => {
    const mock = startMockAgentServer();
    const parent = newClient(mock);

    const creating = parent.createAdditionalAgent();

    const createRpc = await waitFor(
      () => mock.frames.find((frame) => frame.type === 'rpc' && frame.method === 'createSubordinateAgent'),
      'create additional-agent rpc',
    );

    mock.reply({
      type: 'rpc',
      id: createRpc.id,
      success: true,
      done: true,
      result: {
        name: 'researcher-a1b2c3',
        displayName: '',
        subordinate: {
          name: 'researcher-a1b2c3',
          displayName: '',
          nameOrigin: 'auto',
          role: 'task',
          origin: 'user',
          status: 'idle',
          currentTask: null,
          createdAt: 1,
          dismissedAt: null,
        },
      },
    });
    const created = await creating;
    const child = parent.openAdditionalAgent(created.name);

    if (!child.rename) throw new Error('cloud additional agent has no rename capability');
    await expect(child.rename('Research partner')).resolves.toEqual({
      name: 'researcher-a1b2c3',
      displayName: 'Research partner',
    });
    expect(mock.rpcRequests).toContainEqual({
      method: 'renameSubordinateAgent',
      args: ['researcher-a1b2c3', 'Research partner'],
    });

    const turn = child.send('Review the release');

    const request = await waitFor(
      () => mock.frames.filter((frame) => frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST).length > 0
        ? chatRequestFrame(mock)
        : undefined,
      'additional-agent chat request',
    );

    expect(mock.connectUrls.at(-1)?.pathname).toBe(
      `/agents/orchestrator-agent/helios/${hostedActorSocketPath('researcher-a1b2c3')}`,
    );
    expect(mock.ticketRequests.at(-1)).toEqual({ name: 'helios', auth: 'Bearer ptc_token' });
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'Reviewed' }, true));
    await expect(turn).resolves.toMatchObject({ text: 'Reviewed' });

    await child.close();
    await parent.close();
  });

  test('an additional agent reads and sets its own status, model and effort, never the workspace\'s', async () => {
    const mock = startMockAgentServer();
    const parent = newClient(mock);
    const child = parent.openAdditionalAgent('researcher-a1b2c3');
    const answered = new Set<JsonValue | undefined>();

    /** Answers the next socket rpc named `method` with `result`, and returns its arguments. */
    const answer = async (method: string, result: JsonValue): Promise<JsonValue> => {
      const frame = await waitFor(() => mock.frames.find((each) => each.type === 'rpc' && each.method === method && !answered.has(each.id)), `${method} rpc`);

      answered.add(frame.id);
      mock.reply({ type: 'rpc', id: frame.id, success: true, done: true, result });

      return frame.args ?? null;
    };

    const snapshot = {
      name: 'researcher-a1b2c3', actorId: 'actor-1', displayName: 'Researcher', role: 'task', mission: 'Review the release',
      model: { model: 'openai/gpt-own', source: 'actor' }, reasoningEffort: 'high', activePlan: null, pendingSteers: [],
    };

    const status = child.status();

    expect(await answer('getActorSnapshot', snapshot)).toEqual(['researcher-a1b2c3']);
    await expect(status).resolves.toEqual({
      name: 'Researcher', purpose: 'Review the release', model: 'openai/gpt-own', reasoningEffort: 'high', roleId: 'task',
    });

    const model = child.setModel('openai/gpt-next');

    expect(await answer('setActorModel', { ok: true, spec: 'openai/gpt-next' })).toEqual(['researcher-a1b2c3', 'openai/gpt-next']);
    await expect(model).resolves.toEqual({ spec: 'openai/gpt-next' });

    const effort = child.setReasoningEffort('low');

    expect(await answer('setReasoningEffort', { ok: true, effort: 'low' })).toEqual(['low', 'researcher-a1b2c3']);
    await expect(effort).resolves.toEqual({ effort: 'low' });
    await child.close();
    await parent.close();
  });

  test('an additional agent\'s session sends only what its window may call, and answers its own device consent', async () => {
    const window = { name: 'researcher-a1b2c3', id: 'actor-1' };
    const tools = { builtIn: [{ name: 'file', description: 'Read and write files' }], crafted: [] };
    const consent = { consentId: 'consent-1', deviceLabel: 'laptop', method: 'exec', command: 'npm test' };

    const answers = new Map<string, JsonValue>([
      ['listPendingConsents', [consent]], ['resolveDeviceConsent', { ok: true }], ['getToolDescriptions', { ...tools, executors: [] }], ['listBackgroundJobs', []],
    ]);

    const refused: string[] = [];

    // The workspace object's side of the actor socket: its window gate, then its answer.
    const mock = startMockAgentServer({
      serve: (frame): JsonObject | null => {
        if (frame.type !== 'rpc') return null;
        const method = v.parse(v.string(), frame.method);
        const id = frame.id ?? null;

        if (hostedWindowMay(method, v.parse(JsonArraySchema, frame.args), window)) return { type: 'rpc', id, success: true, done: true, result: answers.get(method) ?? null };
        refused.push(method);

        return { type: 'rpc', id, success: false, error: `${method} from ${window.name}'s window may act only on ${window.name}.` };
      },
    });

    const parent = newClient(mock);
    const child = parent.openAdditionalAgent(window.name);
    const turn = child.send('Review the release');
    const request = await firstChatRequest(mock);
    const notes: string[] = [];
    const noted = Promise.withResolvers<void>();

    // What the TUI runs while a turn is live: the workspace's device consents, polled, and this one denied.
    const watcher = watchDeviceConsents(child.consents, {
      present: async () => 'deny',
      note: (kind, message) => { notes.push(`${kind}: ${message}`); noted.resolve(); },
    });

    await noted.promise;
    watcher.stop();
    await watcher.done;
    // A mid-turn branch goes out as a steer; takes, checkpoints and plan reviews are the workspace agent's.
    expect(child.branch('Try the other route')).toBe(false);
    await expect(child.latestTakes()).resolves.toBeNull();
    expect(child.checkpoints).toBeNull();
    expect(child.plans).toBeNull();
    await expect(child.describeTools()).resolves.toEqual(tools);
    await expect(child.listJobs(5)).resolves.toEqual([]);
    // Asking for the workspace agent's memory fails here, without a frame.
    await expect(child.readMemory()).rejects.toThrow('getMemoryContent is not available in an additional agent\'s session.');
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'Reviewed' }, true));
    await turn;

    expect(notes).toEqual(['resolved: Denied.']);
    expect(refused).toEqual([]);
    expect(mock.frames.filter((frame) => frame.type === 'rpc').map((frame) => [frame.method, frame.args])).toEqual([
      ['listPendingConsents', []], ['resolveDeviceConsent', ['consent-1', 'deny']], ['getToolDescriptions', []], ['listBackgroundJobs', [5, window.name]],
    ]);
    await child.close();
    await parent.close();
  });

  test('send transmits only the new user message and streams the reply', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('hello agent', { cwd: '/work/dir' });

    const request = await firstChatRequest(mock);

    expect(request.body.trigger).toBe('submit-message');
    expect(request.body.cwd).toBe('/work/dir');
    const messages = v.parse(ChatMessagesSchema, request.body.messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].parts).toEqual([{ type: 'text', text: 'hello agent' }]);

    // Auth: bearer token mints a ticket; the ticket (not the token) rides the ws URL.
    expect(mock.ticketRequests).toEqual([{ name: 'helios', auth: 'Bearer ptc_token' }]);
    expect(mock.connectUrls[0].searchParams.get('ticket')).toBe('pat_test');

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'Hi ' }));
    mock.reply(responseChunk(request.id, { type: 'tool-input-available', toolCallId: 't1', toolName: 'memory', input: { q: 'x' } }));
    mock.reply(responseChunk(request.id, { type: 'tool-output-available', toolCallId: 't1', output: 'found it' }));
    mock.reply(responseChunk(request.id, { type: 'finish-step' }));
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'there' }));
    mock.reply(responseChunk(request.id, {}, true));

    const result = await turn;

    if (result.landed !== 'turn') throw new Error('an idle workspace runs the message as its own turn');
    expect(result.landed === 'turn' ? result.text : undefined).toBe('Hi there');
    expect(result.landed === 'turn' ? result.steps : undefined).toBe(1);
    expect(result.landed === 'turn' ? result.toolCalls : undefined).toEqual([{ name: 'memory', args: { q: 'x' }, result: 'found it', outcome: { success: true } }]);
    expect(events.map((event) => event.type)).toEqual([
      'turn-start', 'text-delta', 'tool-call', 'tool-result', 'step-finish', 'text-delta', 'turn-end',
    ]);
    await client.close();
  });

  test('send with files transmits [file…, text] parts on the user message', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const files = [
      { filename: 'shot.png', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' },
      { filename: 'spec.pdf', mediaType: 'application/pdf', url: 'data:application/pdf;base64,JVBERg==' },
    ];

    const turn = client.send({ text: 'describe these', files });

    const request = await firstChatRequest(mock);

    const messages = v.parse(ChatMessagesSchema, request.body.messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].parts).toEqual([
      { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,iVBORw0KGgo=' },
      { type: 'file', mediaType: 'application/pdf', filename: 'spec.pdf', url: 'data:application/pdf;base64,JVBERg==' },
      { type: 'text', text: 'describe these' },
    ]);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'two files' }, true));
    await expect(turn).resolves.toMatchObject({ text: 'two files' });
    await client.close();
  });

  test('error frame settles the turn with hadError, pairing turn-start with one turn-end', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('boom');

    const request = await firstChatRequest(mock);

    mock.reply({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id: request.id, body: 'model exploded', done: true, error: true });

    const result = await turn;
    expect(result.landed === 'turn' ? result.hadError : undefined).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['turn-start', 'error', 'turn-end']);
    expect(events.find((event) => event.type === 'error')).toMatchObject({ message: 'model exploded' });
    await client.close();
  });

  test('tool-output-error records the error text as the tool result', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const turn = client.send('run a tool');

    const request = await firstChatRequest(mock);

    mock.reply(responseChunk(request.id, { type: 'tool-input-available', toolCallId: 't1', toolName: 'shell', input: {} }));
    mock.reply(responseChunk(request.id, { type: 'tool-output-error', toolCallId: 't1', errorText: 'command not found' }));
    mock.reply(responseChunk(request.id, {}, true));

    const result = await turn;
    expect(result.landed === 'turn' ? result.toolCalls : undefined).toEqual([{ name: 'shell', args: {}, result: 'command not found', outcome: { success: false, reason: null } }]);
    await client.close();
  });

  test('a tool error with no text reads as a tool error, not as a pair of quotes', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const turn = client.send('run a tool');

    const request = await firstChatRequest(mock);

    mock.reply(responseChunk(request.id, { type: 'tool-input-available', toolCallId: 't1', toolName: 'shell', input: {} }));
    mock.reply(responseChunk(request.id, { type: 'tool-output-error', toolCallId: 't1', errorText: '' }));
    mock.reply(responseChunk(request.id, {}, true));

    const result = await turn;
    expect(result.landed === 'turn' ? result.toolCalls[0]?.result : undefined).toBe('tool error');
    await client.close();
  });

  test('stop cancels the chat stream and waits for durable device cancellation', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    const turn = client.send('long task');

    const request = await firstChatRequest(mock);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'partial ' }));
    await waitFor(
      () => events.find((event) => event.type === 'text-delta'),
      'partial response',
    );

    client.stop();

    const cancel = await waitFor(
      () => mock.frames.find((f) => f.type === CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL),
      'cancel frame',
    );

    expect(cancel.id).toBe(request.id);

    const durableCancel = await waitFor(
      () => mock.frames.find((f) => f.type === 'rpc' && f.method === 'cancelCurrentWork'),
      'durable cancellation rpc',
    );

    expect(durableCancel.args).toEqual([]);
    let turnSettled = false;
    turn.then(() => { turnSettled = true; }, () => { turnSettled = true; });
    await Promise.resolve();
    expect(turnSettled).toBe(false);

    mock.reply({
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      id: request.id,
      body: 'cancelled',
      done: true,
      error: true,
    });
    mock.reply({ type: 'rpc', id: durableCancel.id, success: true, result: {
      ok: true, abortedTools: 1, deviceCommands: [{ outcome: 'terminated' }], returnedSteers: [],
    } });
    const result = await turn;
    expect(result.landed === 'turn' ? result.text : undefined).toBe('partial ');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    await client.close();
  });

  test('stream-resume frames for other clients are ignored, own turns are acked', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const turn = client.send('hello');

    const request = await firstChatRequest(mock);

    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING, id: 'someone-elses-turn' });
    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING, id: request.id });

    const ack = await waitFor(
      () => mock.frames.find((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK),
      'resume ack',
    );

    expect(ack.id).toBe(request.id);
    expect(mock.frames.filter((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK)).toHaveLength(1);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'ok' }, true));
    await expect(turn).resolves.toMatchObject({ text: 'ok' });
    await client.close();
  });

  test('a send mid-turn submits a second chat request immediately; the server answers where it landed', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('start the deploy');

    const first = await firstChatRequest(mock);

    const steered = client.send('use the staging cluster instead');

    const second = await waitFor(() => {
      const requests = mock.frames.filter((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST);

      if (requests.length < 2) return undefined;
      const envelope = v.parse(ChatRequestEnvelopeSchema, requests[1]);

      return { id: envelope.id, body: parseJsonObject(envelope.init.body) };
    }, 'steered chat request');

    // A mid-turn message joins the running turn; the reply says where it landed, with no stream of its own.
    const messages = v.parse(ChatMessagesSchema, second.body.messages);
    expect(messages[0].parts).toEqual([{ type: 'text', text: 'use the staging cluster instead' }]);
    expect(second.id).not.toBe(first.id);
    mock.reply({ ...responseChunk(second.id, {}, true), landed: 'mid-turn' });
    await expect(steered).resolves.toEqual({ landed: 'mid-turn' });

    mock.reply(responseChunk(first.id, { type: 'text-delta', delta: 'deploying' }, true));
    await expect(turn).resolves.toMatchObject({ landed: 'turn', text: 'deploying' });
    expect(events.filter((event) => event.type === 'turn-start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn-end')).toHaveLength(1);
    await client.close();
  });

  test('a send with no active turn is an ordinary chat request, announced as a turn', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('nothing running');

    const request = await firstChatRequest(mock);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'ran' }, true));
    await expect(turn).resolves.toMatchObject({ landed: 'turn', text: 'ran' });
    expect(events.filter((event) => event.type === 'turn-start')).toHaveLength(1);
    await client.close();
  });

  test('fork walks back to the message before the picked user message via the forkAgent RPC', async () => {
    const mock = startMockAgentServer();
    mock.chatMessages.push(
      { id: 'm1', role: 'user', content: 'plan the migration', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'plan drafted', createdAt: 2 },
      { id: 'm3', role: 'user', content: 'now run step two', createdAt: 3 },
      { id: 'm4', role: 'assistant', content: 'step two failed', createdAt: 4 },
    );
    const client = newClient(mock);

    const warmup = client.send('hello');

    const request = await firstChatRequest(mock);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'hi' }, true));
    await warmup;

    const forkPromise = client.fork({ text: 'now run step two', occurrenceFromEnd: 1 });

    const rpc = await waitFor(
      () => mock.frames.find((f) => f.type === 'rpc'),
      'revertConversation rpc frame',
    );

    expect(rpc.method).toBe('revertConversation');
    expect(rpc.args).toEqual(['m3']);
    mock.reply({ type: 'rpc', id: rpc.id, success: true, done: true, result: null });

    const result = await forkPromise;
    expect(result.label).toBe('before m3');
    expect(result.client).toBe(client);
    await client.close();
  });

  test('fork refuses a message that is not in the history', async () => {
    const mock = startMockAgentServer();
    mock.chatMessages.push({ id: 'm1', role: 'user', content: 'first words', createdAt: 1 });
    const client = newClient(mock);
    await expect(client.fork({ text: 'never said this', occurrenceFromEnd: 1 }))
      .rejects.toThrow('Could not locate that message');
    await client.close();
  });

  test('latestTakes and pickTake ride the rpc frames (Alternate Takes capability)', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const warmup = client.send('hello');

    const request = await firstChatRequest(mock);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'hi' }, true));
    await warmup;

    const set = {
      id: 'take-1', turnId: 'm2', sessionId: 'default', task: 'choose a plan',
      winnerNodeId: 'win', chosenNodeId: null, createdAt: 1,
      candidates: [
        { nodeId: 'win', text: 'plan A', origin: 'live' },
        { nodeId: 'alt', text: 'plan B', origin: 'branch' },
      ],
    };

    const latest = client.latestTakes();
    const latestRpc = await waitFor(() => mock.frames.find((f) => f.type === 'rpc' && f.method === 'latestAlternateTakes'), 'latest rpc');
    expect(latestRpc.args).toEqual([]);
    mock.reply({ type: 'rpc', id: latestRpc.id, success: true, done: true, result: set });
    await expect(latest).resolves.toMatchObject({ id: 'take-1', turnId: 'm2' });

    const pick = client.pickTake('take-1', 'alt');
    const pickRpc = await waitFor(() => mock.frames.find((f) => f.type === 'rpc' && f.method === 'pickAlternateTake'), 'pick rpc');
    expect(pickRpc.args).toEqual(['take-1', 'alt']);
    mock.reply({
      type: 'rpc', id: pickRpc.id, success: true, done: true,
      result: {
        outcome: 'corrected', changedAnswer: true, continuationQueued: true,
        chosen: set.candidates[1], set: { ...set, chosenNodeId: 'alt', winnerNodeId: 'alt' },
      },
    });
    await expect(pick).resolves.toMatchObject({ outcome: 'corrected', changedAnswer: true, continuationQueued: true });
    await client.close();
  });

  // A dropped socket is not a failed turn (the DO owns it; the client rebinds). A vanished
  // workspace leaves nothing to rebind to and must reach the caller rather than hang.
  test('an unreachable workspace settles the in-flight send with hadError', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('hello');
    await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? true : undefined,
      'chat request frame',
    );
    await mock.close();

    const result = await turn;
    expect(result.landed === 'turn' ? result.hadError : undefined).toBe(true);
    expect(events.find((event) => event.type === 'error')?.message)
      .toContain('Could not reconnect to resume this cloud turn');
    expect(events.filter((event) => event.type === 'turn-end')).toHaveLength(1);
    await client.close();
  });
});

describe('CloudAgentClient — Steer-as-Branch RPC contract', () => {
  test('branch mid-turn fires the branchTurn rpc; branch_status broadcasts surface as broadcast events', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('start the deploy');

    const request = await firstChatRequest(mock);

    expect(client.branch('what if we used blue-green instead?')).toBe(true);

    const rpc = await waitFor(
      () => mock.frames.find((f) => f.type === 'rpc' && f.method === 'branchTurn'),
      'branchTurn rpc frame',
    );

    expect(rpc.args).toEqual(['what if we used blue-green instead?']);
    mock.reply({ type: 'rpc', id: rpc.id, success: true, done: true, result: { accepted: true, branchId: 'branch-ab12cd34' } });

    mock.reply({ type: 'branch_status', status: 'running', branchId: 'branch-ab12cd34', task: 'what if we used blue-green instead?' });
    mock.reply({ type: 'branch_status', status: 'settled', branchId: 'branch-ab12cd34', task: 'what if we used blue-green instead?', takeSetId: 'take-1', turnId: 'm2' });
    await waitFor(() => {
      const broadcasts = events.filter((e) => e.type === 'broadcast');

      return broadcasts.length >= 2 ? broadcasts : undefined;
    }, 'branch broadcasts');

    const statuses = events
      .filter((e): e is Extract<AgentClientEvent, { type: 'broadcast' }> => e.type === 'broadcast')
      .map((e) => e.event);

    expect(statuses[0]).toMatchObject({ type: 'branch_status', status: 'running', branchId: 'branch-ab12cd34' });
    expect(statuses[1]).toMatchObject({ type: 'branch_status', status: 'settled', takeSetId: 'take-1', turnId: 'm2' });

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'deploying' }, true));
    await expect(turn).resolves.toMatchObject({ text: 'deploying', hadError: false });
    await client.close();
  });

  // 2026-10-01: a cloud workspace's reads_changed frames were dropped here, so the TUI's agents hub went stale on cloud too.
  test('a frame naming the reads a write moved reaches the client as a broadcast', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('hire a scout');
    const request = await firstChatRequest(mock);

    mock.reply({ type: 'reads_changed', reads: ['listWorkspaceAgents', 'listSubordinates'] });

    const moved = await waitFor(() => events
      .filter((e): e is Extract<AgentClientEvent, { type: 'broadcast' }> => e.type === 'broadcast')
      .map((e) => e.event)
      .find((e) => e.type === 'reads_changed'), 'the reads frame');

    expect(moved).toEqual({ type: 'reads_changed', reads: ['listWorkspaceAgents', 'listSubordinates'] });

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'hired' }, true));
    await turn;
    await client.close();
  });

  // 2026-10-04: the TUI linked a cloud workspace's vfs://pc/<machine>/x but not <machine>://x, because the client never
  // read which machines are live. It reads them on connect, and again before it reports that the executors moved.
  test('a live machine\'s own name links in chat, from connect and again when the executors move', async () => {
    const mock = startMockAgentServer();
    mock.executors = [
      { name: 'workspace', kind: 'workspace' },
      { name: 'device', kind: 'device', mounts: ['studio'] },
    ];
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    expect(client.fileLinks.roots).not.toContain('studio');
    await client.connect();
    expect(client.fileLinks.roots).toEqual(['vfs', 'local', 'sandbox', 'studio']);
    expect(client.fileLinks.href('studio://home/dev/a.md')).toBe(`${mock.origin}/workspace/helios?file=studio%3A%2F%2Fhome%2Fdev%2Fa.md`);

    const turn = client.send('connect the rig');
    const request = await firstChatRequest(mock);

    mock.executors = [{ name: 'device', kind: 'device', mounts: ['rig'] }];
    mock.reply({ type: 'reads_changed', reads: ['getExecutors', 'getToolDescriptions'] });

    await waitFor(() => events.find((e) => e.type === 'broadcast' && e.event.type === 'reads_changed'), 'the executors moved');
    expect(client.fileLinks.roots).toEqual(['vfs', 'local', 'sandbox', 'rig']);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'connected' }, true));
    await turn;
    await client.close();
  });

  test('a rejected branch surfaces an honest error status, never a takes set', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('work');

    const request = await firstChatRequest(mock);

    expect(client.branch('redirect')).toBe(true);

    const rpc = await waitFor(
      () => mock.frames.find((f) => f.type === 'rpc' && f.method === 'branchTurn'),
      'branchTurn rpc frame',
    );

    mock.reply({ type: 'rpc', id: rpc.id, success: true, done: true, result: { accepted: false, reason: 'Branching needs an agent owner.' } });

    const errorStatus = await waitFor(() => events
      .filter((e): e is Extract<AgentClientEvent, { type: 'broadcast' }> => e.type === 'broadcast')
      .map((e) => e.event)
      .find((e) => e.type === 'branch_status' && e.status === 'error'), 'error status');

    expect(errorStatus).toMatchObject({ status: 'error', message: 'Branching needs an agent owner.' });

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'done' }, true));
    await turn;
    await client.close();
  });

  test('branch with no active turn returns false and sends nothing', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    expect(client.branch('nothing running')).toBe(false);
    expect(client.branch('   ')).toBe(false);
    expect(mock.frames).toHaveLength(0);
    await client.close();
  });
});

// A dead socket is a lost binding, never a lost turn (the DO persisted it): rebind, never re-submit.
describe('CloudAgentClient — a dropped socket rebinds its turn, never drops or duplicates it', () => {
  /** Chat request frames sent so far; a re-submitting rebind would show a second one. */
  function chatRequests(mock: MockAgentServer): JsonObject[] {
    return mock.frames.filter((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST);
  }

  function resumeAcks(mock: MockAgentServer): JsonObject[] {
    return mock.frames.filter((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK);
  }

  async function dropAndProbe(mock: MockAgentServer): Promise<void> {
    const connects = mock.connectUrls.length;
    mock.socket().close();
    await waitFor(
      () => mock.connectUrls.length > connects || undefined,
      'reconnect after the socket dropped',
    );
    await waitFor(
      () => mock.frames.find((f) => f.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST),
      'stream-resume probe',
    );
  }

  test('closing during a rebind ticket request never opens a replacement socket', async () => {
    const ticketGate = Promise.withResolvers<void>();
    const ticketReturned = Promise.withResolvers<void>();

    const mock = startMockAgentServer({
      holdTicketAt: 2,
      ticketGate: ticketGate.promise,
      onTicketReleased: ticketReturned.resolve,
    });

    const client = newClient(mock);
    const turn = client.send('keep this turn durable');
    await waitFor(
      () => mock.frames.some((frame) => frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST)
        ? true
        : undefined,
      'initial chat request',
    );

    mock.socket().close();
    await waitFor(
      () => mock.ticketRequests.length === 2 ? true : undefined,
      'rebind ticket request',
    );
    await client.close();
    ticketGate.resolve();
    await ticketReturned.promise;

    await expect(turn).resolves.toMatchObject({ hadError: true });
    expect(mock.connectUrls).toHaveLength(1);
  });

  test('mid-stream drop: the turn survives, the replay is not applied twice, one request total', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('summarize the incident');

    const request = await firstChatRequest(mock);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'the cause was ' }));
    await waitFor(() => events.find((e) => e.type === 'text-delta'), 'first live delta');

    await dropAndProbe(mock);
    // Still pending: the DO owns the turn; a `turn-end` here would invent a failure.
    expect(events.some((e) => e.type === 'turn-end')).toBe(false);

    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING, id: request.id });
    await waitFor(() => resumeAcks(mock).find((f) => f.id === request.id), 'resume ack');
    mock.reply({ ...responseChunk(request.id, { type: 'text-delta', delta: 'the cause was ' }), replay: true });
    mock.reply({ ...responseChunk(request.id, { type: 'text-delta', delta: 'a stale lease.' }), replay: true });
    mock.reply({ ...responseChunk(request.id, { type: 'text-delta', delta: '' }, true), replay: true });

    await expect(turn).resolves.toMatchObject({
      text: 'the cause was a stale lease.',
      hadError: false,
    });
    // Exactly one submission: the rebind replays the stream, never resends the prompt.
    expect(chatRequests(mock)).toHaveLength(1);
    expect(resumeAcks(mock)).toHaveLength(1);
    await client.close();
  });

  test('resume-none: the client claims the turn by ack and reports it rather than faking an answer', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('deploy the hotfix');

    const request = await firstChatRequest(mock);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'starting' }));
    await waitFor(() => events.find((e) => e.type === 'text-delta'), 'first live delta');

    await dropAndProbe(mock);
    // No stream held: the client acks its own request id, which the DO always answers with a terminal.
    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE, reason: 'idle' });
    await waitFor(() => resumeAcks(mock).find((f) => f.id === request.id), 'resume ack after resume-none');
    mock.reply({ ...responseChunk(request.id, { type: 'text-delta', delta: '' }, true), replay: true });

    const result = await turn;
    expect(result.landed === 'turn' ? result.hadError : undefined).toBe(true);
    expect(events.some((e) => e.type === 'error' && e.message.includes('no stream to resume'))).toBe(true);
    expect(result.landed === 'turn' ? result.text : undefined).toBe('starting');
    expect(chatRequests(mock)).toHaveLength(1);
    await client.close();
  });

  test('a second drop before anything rebinds reports the turn instead of chasing it forever', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('long migration');

    const request = await firstChatRequest(mock);

    await dropAndProbe(mock);
    mock.socket().close();

    const result = await turn;
    expect(result.landed === 'turn' ? result.hadError : undefined).toBe(true);
    expect(events.some((e) => e.type === 'error' && e.message.includes('dropped again'))).toBe(true);
    expect(chatRequests(mock)).toHaveLength(1);
    expect(request.id).toBeTruthy();
    await client.close();
  });

  test('a turn the next activation re-opened is followed onto its stream, by the turn the request opened', async () => {
    // F2 (staging a4e564ce1, 2026-09-30): the object's activation ended mid-turn and its wake re-drove the turn under
    // a request id the new activation minted. Unfixed, the client never acked it and the rest of the answer was lost.
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('count to two');

    const request = await firstChatRequest(mock);

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'one, ' }));
    mock.reply(responseChunk(request.id, { type: 'finish-step' }));
    // Step 2 is cut by the activation's end: the next activation runs it again.
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'tw' }));
    await waitFor(() => events.filter((e) => e.type === 'text-delta').length === 2 ? true : undefined, 'the cut step');

    await dropAndProbe(mock);
    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_PENDING });
    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING, id: 'reopened', turnId: request.id });

    // The socket is FIFO both ways: a reply after the resuming frame means the client read it, and a call it sends
    // after that reply reaches the server behind any ack it sent.
    for (let call = 0; call < 2; call++) {
      const barrier = client.latestTakes();
      const rpc = await waitFor(() => mock.frames.filter((frame) => frame.type === 'rpc' && frame.method === 'latestAlternateTakes')[call], 'resuming barrier');
      mock.reply({ type: 'rpc', id: rpc.id, success: true, done: true, result: null });
      await barrier;
    }

    expect(resumeAcks(mock).map((frame) => frame.id)).toEqual(['reopened']);

    // Step 1 restated from the ledger (held, so skipped), then the re-run of step 2, which replaces the cut one.
    for (const chunk of RESTATED_STEP_ONE) {
      mock.reply({ ...responseChunk('reopened', chunk), replay: true, restated: true });
    }

    mock.reply({ ...responseChunk('reopened', { type: 'data-kinu-step-cut', data: { stepIndex: 2 }, transient: true }), replay: true });
    mock.reply({ ...responseChunk('reopened', { type: 'text-delta', delta: 'two' }), replay: true });
    mock.reply({ ...responseChunk('reopened', { type: 'finish-step' }), replay: true });
    mock.reply({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id: 'reopened', body: '', done: false, replay: true, replayComplete: true });
    mock.reply(responseChunk('reopened', { type: 'text-delta', delta: '' }, true));

    await expect(turn).resolves.toMatchObject({ text: 'one, two', steps: 2, hadError: false });
    expect(emittedTextAndCuts(events)).toEqual(['one, ', 'tw', 'cut 2', 'two']);
    expect(chatRequests(mock)).toHaveLength(1);
    await client.close();
  });

  test('a follower joining after its cut step finished receives the cut before that recorded step', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    const turn = client.send('count to three');
    const request = await firstChatRequest(mock);
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'one, ' }));
    mock.reply(responseChunk(request.id, { type: 'finish-step' }));
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'tw' }));
    await waitFor(() => events.filter((event) => event.type === 'text-delta').length === 2 ? true : undefined, 'step 2 drawn');
    await dropAndProbe(mock);
    const connection: ChatSocket = { id: 'rejoined', readyState: WebSocket.OPEN, send: (raw) => mock.reply(parseJsonObject(v.parse(v.string(), raw))) };
    let joined = false;

    const transport = new ChatWireTransport({
      turnOwed: () => true,
      steps: () => [[{ type: 'text', text: 'one, ', state: 'done' }], [{ type: 'text', text: 'two, ', state: 'done' }]],
      broadcast: (raw, exclude) => { if (joined && !(exclude ?? []).includes(connection.id)) connection.send(raw); },
      getConnection: (id) => joined && id === connection.id ? connection : undefined,
      history: async () => [], admitted: async () => false,
      send: async () => { throw new Error('the re-drive accepts no second submission'); },
      retry: async () => { throw new Error('the re-drive is not retried'); },
      interrupt: () => { throw new Error('the re-drive is not interrupted'); },
      clear: async () => { throw new Error('the re-drive is not cleared'); },
    });

    await transport.openTurn({ turnId: request.id, messageId: 'answer', userTurn: true, carried: [], finishedSteps: 1 });
    await transport.deliver({ type: 'step-cut', stepIndex: 2 });
    await transport.observe(new ReadableStream<UIMessageChunk>({ start(controller) {
      const chunks: UIMessageChunk[] = [
        { type: 'start-step' }, { type: 'text-start', id: 'second' }, { type: 'text-delta', id: 'second', delta: 'two, ' },
        { type: 'text-end', id: 'second' }, { type: 'finish-step' },
        { type: 'start-step' }, { type: 'text-start', id: 'third' }, { type: 'text-delta', id: 'third', delta: 'thr' },
      ];

      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    } }), { index: 0 });
    joined = true;
    await transport.onConnect(connection);
    const ack = await waitFor(() => resumeAcks(mock)[0], 'the re-drive ack');
    await transport.onMessage(connection, JSON.stringify(ack));
    const id = v.parse(v.string(), ack.id);
    mock.reply(responseChunk(id, { type: 'text-delta', delta: 'ee' }));
    mock.reply(responseChunk(id, { type: 'finish-step' }));
    mock.reply({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id, body: '', done: true });

    await expect(turn).resolves.toMatchObject({ text: 'one, two, three', steps: 3 });
    expect(emittedTextAndCuts(events)).toEqual(['one, ', 'tw', 'cut 2', 'two, ', 'thr', 'ee']);
    await client.close();
  });

  test('a turn re-opened twice is followed by the same open client to its end, each step once', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('count to three');
    const request = await firstChatRequest(mock);
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'one, ' }));
    mock.reply(responseChunk(request.id, { type: 'finish-step' }));
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'tw' }));
    await waitFor(() => events.filter((e) => e.type === 'text-delta').length === 2 ? true : undefined, 'step 2 begun');

    // The second activation restates step 1, runs step 2 again whole and ends inside step 3.
    await dropAndProbe(mock);
    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING, id: 'second', turnId: request.id });
    await waitFor(() => resumeAcks(mock).find((frame) => frame.id === 'second'), 'the ack of the second activation');

    for (const chunk of RESTATED_STEP_ONE) mock.reply({ ...responseChunk('second', chunk), replay: true, restated: true });

    const relayed: JsonObject[] = [
      { type: 'data-kinu-step-cut', data: { stepIndex: 2 }, transient: true },
      { type: 'text-delta', delta: 'two, ' }, { type: 'finish-step' }, { type: 'text-delta', delta: 'thr' },
    ];

    for (const chunk of relayed) mock.reply({ ...responseChunk('second', chunk), replay: true });

    mock.reply({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id: 'second', body: '', done: false, replay: true, replayComplete: true });
    await waitFor(() => events.filter((e) => e.type === 'step-finish').length === 2 ? true : undefined, 'step 2 held');

    // The third restates steps 1 and 2 and runs step 3 again.
    await dropAndProbe(mock);
    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING, id: 'third', turnId: request.id });
    await waitFor(() => resumeAcks(mock).find((frame) => frame.id === 'third'), 'the ack of the third activation');

    const restatedTwo: JsonObject[] = [
      { type: 'start-step' }, { type: 'text-start', id: 's' }, { type: 'text-delta', id: 's', delta: 'two, ' }, { type: 'text-end', id: 's' }, { type: 'finish-step' },
    ];

    for (const chunk of [...RESTATED_STEP_ONE, ...restatedTwo]) mock.reply({ ...responseChunk('third', chunk), replay: true, restated: true });

    mock.reply({ ...responseChunk('third', { type: 'data-kinu-step-cut', data: { stepIndex: 3 }, transient: true }), replay: true });
    mock.reply({ ...responseChunk('third', { type: 'text-delta', delta: 'three' }), replay: true });
    mock.reply({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id: 'third', body: '', done: false, replay: true, replayComplete: true });
    mock.reply(responseChunk('third', { type: 'finish-step' }));
    mock.reply(responseChunk('third', { type: 'text-delta', delta: '' }, true));

    await expect(turn).resolves.toMatchObject({ text: 'one, two, three', steps: 3, hadError: false });
    expect(emittedTextAndCuts(events)).toEqual(['one, ', 'tw', 'cut 2', 'two, ', 'thr', 'cut 3', 'three']);
    expect(chatRequests(mock)).toHaveLength(1);
    await client.close();
  });

  test('a reconnect whose replay restates a held step skips it, and its own partial step resumes where it was', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('count to two');
    const request = await firstChatRequest(mock);
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'one, ' }));
    mock.reply(responseChunk(request.id, { type: 'finish-step' }));
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'tw' }));
    await waitFor(() => events.filter((e) => e.type === 'text-delta').length === 2 ? true : undefined, 'step 2 begun');

    await dropAndProbe(mock);
    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING, id: request.id, turnId: request.id });
    await waitFor(() => resumeAcks(mock).find((frame) => frame.id === request.id), 'the ack');

    for (const chunk of RESTATED_STEP_ONE) {
      mock.reply({ ...responseChunk(request.id, chunk), replay: true, restated: true });
    }

    mock.reply({ ...responseChunk(request.id, { type: 'text-delta', delta: 'tw' }), replay: true });
    mock.reply({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id: request.id, body: '', done: false, replay: true, replayComplete: true });
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'o' }));
    mock.reply(responseChunk(request.id, { type: 'finish-step' }));
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: '' }, true));

    await expect(turn).resolves.toMatchObject({ text: 'one, two', steps: 2, hadError: false });
    // Nothing the terminal printed is printed again.
    expect(events.flatMap((e) => (e.type === 'text-delta' ? [e.delta] : [])).join('')).toBe('one, two');
    await client.close();
  });

  test('stream-pending is a wait, not a settle: the client holds the turn until the DO names its outcome', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('queued work');

    const request = await firstChatRequest(mock);

    await dropAndProbe(mock);

    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_PENDING, id: request.id });
    // A later RPC reply on this socket is a FIFO barrier: STREAM_PENDING was consumed before it.
    const barrier = client.latestTakes();
    const rpc = await waitFor(() => mock.frames.find((frame) => frame.type === 'rpc' && frame.method === 'latestAlternateTakes'), 'pending-stream barrier');
    mock.reply({ type: 'rpc', id: rpc.id, success: true, done: true, result: null });
    await barrier;
    expect(events.some((e) => e.type === 'turn-end')).toBe(false);
    expect(resumeAcks(mock)).toHaveLength(0);

    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_RESUMING, id: request.id });
    await waitFor(() => resumeAcks(mock).find((f) => f.id === request.id), 'resume ack after pending');
    mock.reply({ ...responseChunk(request.id, { type: 'text-delta', delta: 'ran late' }), replay: true });
    mock.reply({ ...responseChunk(request.id, { type: 'text-delta', delta: '' }, true), replay: true });

    await expect(turn).resolves.toMatchObject({ text: 'ran late', hadError: false });
    expect(chatRequests(mock)).toHaveLength(1);
    await client.close();
  });
});
