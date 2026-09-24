/**
 * MCP 2025-11-25, basic/transports, "Session Management" items 3-4: a server that ended a session answers
 * HTTP 404 to any request carrying that `MCP-Session-Id`, having run nothing, and a client that receives it
 * MUST start a new session with an `InitializeRequest` that carries no session id. Driven over real HTTP with
 * the MCP SDK client the Agents SDK wraps.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as v from 'valibot';
import type { JsonObject } from '@kinu.run/core';
import { callRenewingExpiredSession, type McpSessionHost } from '../src/user/mcp';

const RpcSchema = v.object({
  id: v.optional(v.number(), 0),
  method: v.string(),
  params: v.optional(v.object({ protocolVersion: v.optional(v.string(), '2025-11-25') }), {}),
});

interface ExpiringServerOptions {
  /** Whether initialize assigns a session id at all. */
  readonly sessions: boolean;
  /** The status a tools/call gets once `calls` have been served on session 1, or on every later session too. */
  readonly afterCalls: number;
  readonly status: number;
  readonly everySession?: boolean;
}

const open: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.stop()));
});

/** A Streamable-HTTP MCP server with one tool, whose sessions end on cue; it records every request it saw. */
function expiringServer(options: ExpiringServerOptions) {
  const seen: string[] = [];
  let sessions = 0;
  let served = 0;

  const json = (body: JsonObject, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const message = v.parse(RpcSchema, await request.json());
      const session = request.headers.get('mcp-session-id');
      seen.push(`${message.method} ${session ?? '-'}`);

      if (message.method === 'initialize') {
        sessions++;
        const result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'expiring', version: '0' } };

        return json({ jsonrpc: '2.0', id: message.id, result }, options.sessions ? { 'mcp-session-id': `s${String(sessions)}` } : {});
      }

      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const ended = served >= options.afterCalls && (session === 's1' || !options.sessions || options.everySession === true);

      if (message.method === 'tools/call' && ended) return new Response('session ended', { status: options.status });

      if (message.method === 'tools/call') {
        served++;

        return json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `42 on ${session ?? 'no session'}` }] } });
      }

      return json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'answer', inputSchema: { type: 'object' } }] } });
    },
  });

  open.push({ stop: () => server.stop(true) });

  return { url: new URL(`http://127.0.0.1:${String(server.port)}/mcp`), seen };
}

/** The Agents SDK manager surface over one SDK client: a new session is a new client on a fresh transport. */
async function connectedHost(url: URL) {
  let transport = new StreamableHTTPClientTransport(url);
  let client = new Client({ name: 'kinu-test', version: '0' });
  await client.connect(transport);

  let cleared = 0;

  const connection = {
    get sessionId() { return transport.sessionId; },
    clearResumedSession() { cleared++; },
  };

  const host: McpSessionHost = {
    mcpConnections: { srv: connection },
    async connectToServer() {
      await client.close();
      transport = new StreamableHTTPClientTransport(url);
      client = new Client({ name: 'kinu-test', version: '0' });
      await client.connect(transport);

      return { state: 'connected' };
    },
    async discoverIfConnected() {
      await client.listTools();

      return { success: true };
    },
  };

  open.push({ stop: () => client.close() });

  const call = () => callRenewingExpiredSession(host, 'srv', () => client.callTool({ name: 'answer', arguments: {} }));

  return { call, cleared: () => cleared };
}

async function failureOf<T>(action: () => Promise<T>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error rejection, received ${String(error)}`, { cause: error });
  }

  throw new Error('expected the call to fail');
}

describe('an MCP server that ends its session', () => {
  test('the client starts one new session without the old id and the call is sent once more', async () => {
    const server = expiringServer({ sessions: true, afterCalls: 2, status: 404 });
    const { call, cleared } = await connectedHost(server.url);

    const answers = [await call(), await call(), await call()].map((result) => JSON.stringify(result.content));

    expect(answers).toEqual([1, 1, 2].map((session) => JSON.stringify([{ type: 'text', text: `42 on s${String(session)}` }])));
    expect(server.seen.filter((line) => line.startsWith('initialize '))).toEqual(['initialize -', 'initialize -']);
    expect(server.seen.filter((line) => line.startsWith('tools/call '))).toEqual(['tools/call s1', 'tools/call s1', 'tools/call s1', 'tools/call s2']);
    // A restored session id kept on the connection options would resume the ended session.
    expect(cleared()).toBe(1);
  });

  test('two calls that meet the same ended session share one new session', async () => {
    const server = expiringServer({ sessions: true, afterCalls: 0, status: 404 });
    const { call } = await connectedHost(server.url);

    await Promise.all([call(), call()]);

    expect(server.seen.filter((line) => line.startsWith('initialize '))).toHaveLength(2);
  });

  test('a new session that also answers 404 fails the call; nothing is sent a third time', async () => {
    const server = expiringServer({ sessions: true, afterCalls: 0, status: 404, everySession: true });
    const { call } = await connectedHost(server.url);

    expect((await failureOf(call)).message).toContain('session ended');
    expect(server.seen.filter((line) => line.startsWith('tools/call '))).toEqual(['tools/call s1', 'tools/call s2']);
  });

  test('any other failure, and a 404 on a connection that never held a session id, stays as it is', async () => {
    for (const ending of [{ sessions: true, status: 500 }, { sessions: false, status: 404 }]) {
      const server = expiringServer({ ...ending, afterCalls: 0 });
      const { call } = await connectedHost(server.url);

      await failureOf(call);

      expect({ ending, initializes: server.seen.filter((line) => line.startsWith('initialize ')).length })
        .toEqual({ ending, initializes: 1 });
      expect({ ending, sent: server.seen.filter((line) => line.startsWith('tools/call ')).length }).toEqual({ ending, sent: 1 });
    }
  });
});
