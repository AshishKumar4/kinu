// CloudAgentClient — protocol behavior against a mock OrchestratorAgent
// websocket server speaking the agents/chat cf_agent_* envelopes.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { CloudAgentClient } from '../src/cloud-agent-client.js';
import type { AgentClientEvent } from '../src/agent-client.js';

interface MockAgentServer {
  server: Server<unknown>;
  origin: string;
  /** Frames received over the websocket, parsed. */
  frames: Array<Record<string, unknown>>;
  ticketRequests: Array<{ name: string; auth: string | null }>;
  connectUrls: URL[];
  /** Rows served from /api/cli/workspaces/:name/messages (the DO chat projection). */
  chatMessages: Array<{ id: string; role: string; content: string; createdAt: number }>;
  socket(): ServerWebSocket<unknown>;
  reply(frame: Record<string, unknown>): void;
  close(): void;
}

const servers: MockAgentServer[] = [];

afterEach(() => {
  for (const mock of servers.splice(0)) mock.close();
});

function startMockAgentServer(): MockAgentServer {
  const frames: Array<Record<string, unknown>> = [];
  const ticketRequests: Array<{ name: string; auth: string | null }> = [];
  const connectUrls: URL[] = [];
  const chatMessages: MockAgentServer['chatMessages'] = [];
  let ws: ServerWebSocket<unknown> | null = null;

  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const ticketMatch = url.pathname.match(/^\/api\/cli\/workspaces\/([^/]+)\/connect-ticket$/);
      if (ticketMatch && req.method === 'POST') {
        ticketRequests.push({
          name: decodeURIComponent(ticketMatch[1]!),
          auth: req.headers.get('authorization'),
        });
        return Response.json({ ticket: 'pat_test', expiresAt: Date.now() + 60_000 });
      }
      if (/^\/api\/cli\/workspaces\/[^/]+\/rpc$/.test(url.pathname) && req.method === 'POST') {
        const { method } = await req.json() as { method: string };
        if (method === 'getChatHistory') return Response.json({ result: chatMessages });
        return Response.json({ error: `No such agent RPC method: ${method}` }, { status: 404 });
      }
      if (url.pathname.startsWith('/agents/orchestrator-agent/')) {
        connectUrls.push(url);
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return new Response('upgrade failed', { status: 400 });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(socket) { ws = socket; },
      message(_socket, message) {
        frames.push(JSON.parse(String(message)) as Record<string, unknown>);
      },
    },
  });

  const mock: MockAgentServer = {
    server,
    origin: `http://localhost:${server.port}`,
    frames,
    ticketRequests,
    connectUrls,
    chatMessages,
    socket() {
      if (!ws) throw new Error('no websocket connection yet');
      return ws;
    },
    reply(frame) {
      this.socket().send(JSON.stringify(frame));
    },
    close() {
      server.stop(true);
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
    session: { noSession: true },
  });
}

function chatRequestFrame(mock: MockAgentServer): { id: string; body: Record<string, unknown> } {
  const frame = mock.frames.find((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST);
  if (!frame) throw new Error('no chat request frame received');
  const init = frame.init as { body: string };
  return { id: frame.id as string, body: JSON.parse(init.body) as Record<string, unknown> };
}

function responseChunk(id: string, chunk: Record<string, unknown>, done = false): Record<string, unknown> {
  return { type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id, body: JSON.stringify(chunk), done };
}

describe('CloudAgentClient protocol', () => {
  test('send transmits only the new user message and streams the reply', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('hello agent', { cwd: '/work/dir' });
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'chat request frame',
    );

    // Outgoing contract: a single fresh user message, never a mirrored history.
    expect(request.body.trigger).toBe('submit-message');
    expect(request.body.cwd).toBe('/work/dir');
    const messages = request.body.messages as Array<{ role: string; parts: Array<{ type: string; text: string }> }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.parts).toEqual([{ type: 'text', text: 'hello agent' }]);

    // Auth: bearer token mints a ticket; the ticket (not the token) rides the ws URL.
    expect(mock.ticketRequests).toEqual([{ name: 'helios', auth: 'Bearer ptc_token' }]);
    expect(mock.connectUrls[0]!.searchParams.get('ticket')).toBe('pat_test');

    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'Hi ' }));
    mock.reply(responseChunk(request.id, { type: 'tool-input-available', toolCallId: 't1', toolName: 'memory', input: { q: 'x' } }));
    mock.reply(responseChunk(request.id, { type: 'tool-output-available', toolCallId: 't1', output: 'found it' }));
    mock.reply(responseChunk(request.id, { type: 'finish-step' }));
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'there' }));
    mock.reply(responseChunk(request.id, {}, true));

    const result = await turn;
    expect(result.text).toBe('Hi there');
    expect(result.steps).toBe(1);
    expect(result.toolCalls).toEqual([{ name: 'memory', args: { q: 'x' }, result: 'found it' }]);
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
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'chat request frame',
    );

    const messages = request.body.messages as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.parts).toEqual([
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
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'chat request frame',
    );
    mock.reply({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id: request.id, body: 'model exploded', done: true, error: true });

    const result = await turn;
    expect(result.hadError).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['turn-start', 'error', 'turn-end']);
    expect(events.find((event) => event.type === 'error')).toMatchObject({ message: 'model exploded' });
    await client.close();
  });

  test('tool-output-error records the error text as the tool result', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const turn = client.send('run a tool');
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'chat request frame',
    );
    mock.reply(responseChunk(request.id, { type: 'tool-input-available', toolCallId: 't1', toolName: 'shell', input: {} }));
    mock.reply(responseChunk(request.id, { type: 'tool-output-error', toolCallId: 't1', errorText: 'command not found' }));
    mock.reply(responseChunk(request.id, {}, true));

    const result = await turn;
    expect(result.toolCalls).toEqual([{ name: 'shell', args: {}, result: 'command not found' }]);
    await client.close();
  });

  test('stop sends cf_agent_chat_request_cancel and resolves with the partial output', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const turn = client.send('long task');
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'chat request frame',
    );
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'partial ' }));
    await waitFor(() => undefined as never, 'delta delivery', 50).catch(() => {});

    client.stop();
    const result = await turn;
    expect(result.text).toBe('partial ');

    const cancel = await waitFor(
      () => mock.frames.find((f) => f.type === CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL),
      'cancel frame',
    );
    expect(cancel.id).toBe(request.id);
    await client.close();
  });

  test('stream-resume frames for other clients are ignored, own turns are acked', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const turn = client.send('hello');
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'chat request frame',
    );

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

  test('steer mid-turn submits a second chat request immediately; both turns settle in order', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('start the deploy');
    const first = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'first chat request',
    );

    expect(client.steer('use the staging cluster instead')).toBe(true);
    const second = await waitFor(() => {
      const requests = mock.frames.filter((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST);
      if (requests.length < 2) return undefined;
      const frame = requests[1]!;
      const init = frame.init as { body: string };
      return { id: frame.id as string, body: JSON.parse(init.body) as Record<string, unknown> };
    }, 'steered chat request');

    // The steer rides the same protocol as send: one fresh user message,
    // delivered while the first turn is still streaming (the DO persists it
    // immediately and serializes it on its TurnQueue).
    const messages = second.body.messages as Array<{ role: string; parts: Array<{ type: string; text: string }> }>;
    expect(messages[0]!.parts).toEqual([{ type: 'text', text: 'use the staging cluster instead' }]);
    expect(second.id).not.toBe(first.id);

    // DO finishes turn 1, then streams the steered turn.
    mock.reply(responseChunk(first.id, { type: 'text-delta', delta: 'deploying' }, true));
    mock.reply(responseChunk(second.id, { type: 'text-delta', delta: 'switched to staging' }, true));

    await expect(turn).resolves.toMatchObject({ text: 'deploying' });
    await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 2 ? true : undefined, 'both turn-ends');
    expect(events.filter((event) => event.type === 'turn-start')).toHaveLength(2);
    await client.close();
  });

  test('steer with no active turn returns false and sends nothing', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    expect(client.steer('nothing running')).toBe(false);
    expect(mock.frames).toHaveLength(0);
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

    // Open the socket via a quick completed turn, then fork while idle.
    const warmup = client.send('hello');
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'warmup request',
    );
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'hi' }, true));
    await warmup;

    const forkPromise = client.fork({ text: 'now run step two', occurrenceFromEnd: 1 });
    const rpc = await waitFor(
      () => mock.frames.find((f) => f.type === 'rpc'),
      'forkAgent rpc frame',
    );
    // The fork point is the message BEFORE the picked user message.
    expect(rpc.method).toBe('forkAgent');
    expect(rpc.args).toEqual(['m2']);
    mock.reply({ type: 'rpc', id: rpc.id, success: true, done: true, result: { id: 'do-2', name: 'helios-fork-ab12', url: '/agent/helios-fork-ab12', forkPointMs: 2 } });

    const result = await forkPromise;
    expect(result.label).toBe('agent helios-fork-ab12');
    expect(result.client).not.toBe(client);
    expect(result.client.agentName).toBe('helios-fork-ab12');
    await client.close();
    await result.client.close();
  });

  test('fork refuses to walk back before the first message', async () => {
    const mock = startMockAgentServer();
    mock.chatMessages.push({ id: 'm1', role: 'user', content: 'first words', createdAt: 1 });
    const client = newClient(mock);
    await expect(client.fork({ text: 'first words', occurrenceFromEnd: 1 }))
      .rejects.toThrow('Cannot walk back before the first message');
    await expect(client.fork({ text: 'never said this', occurrenceFromEnd: 1 }))
      .rejects.toThrow('Could not locate that message');
    await client.close();
  });

  test('latestTakes and pickTake ride the rpc frames (Alternate Takes capability)', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    // Open the socket via a quick completed turn (rpc rides the same ws).
    const warmup = client.send('hello');
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'warmup request',
    );
    mock.reply(responseChunk(request.id, { type: 'text-delta', delta: 'hi' }, true));
    await warmup;

    const set = {
      id: 'take-1', turnId: 'm2', sessionId: 'default', task: 'choose a plan',
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

  test('connection close mid-turn settles the in-flight send with hadError', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);
    const events: AgentClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    const turn = client.send('hello');
    await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? true : undefined,
      'chat request frame',
    );
    mock.socket().close();

    const result = await turn;
    expect(result.hadError).toBe(true);
    expect(events.find((event) => event.type === 'error')).toMatchObject({ message: 'Cloud workspace connection closed.' });
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
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'chat request frame',
    );

    expect(client.branch('what if we used blue-green instead?')).toBe(true);
    const rpc = await waitFor(
      () => mock.frames.find((f) => f.type === 'rpc' && f.method === 'branchTurn'),
      'branchTurn rpc frame',
    );
    expect(rpc.args).toEqual(['what if we used blue-green instead?']);
    mock.reply({ type: 'rpc', id: rpc.id, success: true, done: true, result: { accepted: true, branchId: 'branch-ab12cd34' } });

    // The DO fans branch progress to every ws client — forwarded as broadcasts.
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

    // The live turn streams to completion untouched.
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
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'chat request frame',
    );
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
