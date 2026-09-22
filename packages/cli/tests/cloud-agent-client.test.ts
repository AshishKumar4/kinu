import { afterEach, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  JsonArraySchema, JsonObjectSchema, parseJsonObject, hostedActorSocketPath,
  ChatHistoryEntrySchema, restoredRows,
  type JsonObject, type JsonValue,
} from '@kinu.run/core';
import { CloudAgentClient } from '../src/cloud-agent-client';
import type { AgentClientEvent } from '../src/agent-client';
import * as v from 'valibot';

interface MockAgentServer {
  server: Server<unknown>;
  origin: string;
  frames: JsonObject[];
  ticketRequests: Array<{ name: string; auth: string | null }>;
  connectUrls: URL[];
  rpcRequests: Array<{ method: string; args: JsonValue[] }>;
  /** The DO chat projection rows. */
  chatMessages: Array<{ id: string; role: string; content: string; createdAt: number; metadata?: JsonObject }>;
  socket(): ServerWebSocket<unknown>;
  reply(frame: JsonObject): void;
  close(): Promise<void>;
}

const servers: MockAgentServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((mock) => mock.close()));
});

function startMockAgentServer(options: {
  holdTicketAt: number;
  ticketGate: Promise<void>;
  onTicketReleased(): void;
} | Record<never, never> = {}): MockAgentServer {
  const frames: JsonObject[] = [];
  const ticketRequests: Array<{ name: string; auth: string | null }> = [];
  const connectUrls: URL[] = [];
  const rpcRequests: MockAgentServer['rpcRequests'] = [];
  const chatMessages: MockAgentServer['chatMessages'] = [];
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

        if ('holdTicketAt' in options && ticketRequests.length === options.holdTicketAt) {
          await options.ticketGate;
          options.onTicketReleased();
        }

        return Response.json({ ticket: 'pat_test', expiresAt: Date.now() + 60_000 });
      }

      if (/^\/api\/cli\/workspaces\/[^/]+\/rpc$/.test(url.pathname) && req.method === 'POST') {
        const request = v.parse(JsonObjectSchema, await req.json());
        const method = v.parse(v.string(), request.method);
        const parsedArgs = v.safeParse(JsonArraySchema, request.args);
        const args = parsedArgs.success ? parsedArgs.output : [];
        rpcRequests.push({ method, args });

        // Pages of two, so a client that reads only the first page fails.
        if (method === 'getChatHistoryPage') {
          const cursor = v.parse(v.optional(v.object({ cursor: v.optional(v.object({ after: v.string() })) })), args[0]);
          const after = cursor?.cursor?.after;

          const end = after === undefined
            ? chatMessages.length
            : chatMessages.findIndex((m) => m.id === after);

          if (end < 0) return Response.json({ error: `Stale cursor: ${after}` }, { status: 409 });
          const start = Math.max(0, end - 2);

          return Response.json({
            result: start === 0
              ? { status: 'end', items: chatMessages.slice(start, end) }
              : { status: 'more', items: chatMessages.slice(start, end), next: { after: chatMessages[start].id } },
          });
        }

        if (method === 'getReasoningEffort') return Response.json({ result: { effort: 'medium' } });

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
                createdBy: 'user',
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

        if (srv.upgrade(req)) return;

        return new Response('upgrade failed', { status: 400 });
      }

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(socket) { ws = socket; },
      message(_socket, message) {
        frames.push(parseJsonObject(String(message)));
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

async function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = probe();

    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`timed out waiting for ${label}`);
}

function newClient(mock: MockAgentServer): CloudAgentClient {
  return new CloudAgentClient({
    origin: mock.origin,
    token: 'ptc_token',
    agentName: 'helios',
    cloudName: 'helios',
    transcript: { noTranscript: true },
  });
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
      expect(restoredRows([v.parse(ChatHistoryEntrySchema, row)])[0]?.metadata).toEqual(history[0]?.metadata);
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
          createdBy: 'user',
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
      source: 'mcts',
      winnerNodeId: 'win', chosenNodeId: null, createdAt: 1, pickedAt: null,
      candidates: [
        { nodeId: 'win', text: 'plan A', score: 0.9, visits: 3, depth: 1 },
        { nodeId: 'alt', text: 'plan B', score: 0.85, visits: 2, depth: 1 },
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
        chosen: set.candidates[1], set: { ...set, chosenNodeId: 'alt', winnerNodeId: 'alt', pickedAt: 2 },
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

  test('stream-pending is a wait, not a settle: the client holds the turn until the DO names its outcome', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('queued work');

    const request = await firstChatRequest(mock);

    await dropAndProbe(mock);

    mock.reply({ type: CHAT_MESSAGE_TYPES.STREAM_PENDING, id: request.id });
    await Bun.sleep(50);
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
