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
  let ws: ServerWebSocket<unknown> | null = null;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const ticketMatch = url.pathname.match(/^\/api\/cli\/agents\/([^/]+)\/connect-ticket$/);
      if (ticketMatch && req.method === 'POST') {
        ticketRequests.push({
          name: decodeURIComponent(ticketMatch[1]!),
          auth: req.headers.get('authorization'),
        });
        return Response.json({ ticket: 'pat_test', expiresAt: Date.now() + 60_000 });
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

  test('error frame rejects the turn with the server message', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const turn = client.send('boom');
    const request = await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? chatRequestFrame(mock) : undefined,
      'chat request frame',
    );
    mock.reply({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id: request.id, body: 'model exploded', done: true, error: true });

    await expect(turn).rejects.toThrow('model exploded');
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

  test('connection close mid-turn rejects the in-flight send', async () => {
    const mock = startMockAgentServer();
    const client = newClient(mock);

    const turn = client.send('hello');
    await waitFor(
      () => mock.frames.some((f) => f.type === CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST) ? true : undefined,
      'chat request frame',
    );
    mock.socket().close();

    await expect(turn).rejects.toThrow('Cloud agent connection closed.');
    await client.close();
  });
});
