/**
 * What the client the Agents SDK wraps (`@modelcontextprotocol/client`) throws when a server refuses, from its
 * real transport: until 2026-09-30 the 401 and 404 checks were tested with v1's classes, and matched nothing.
 */

import { Client, SSEClientTransport, StreamableHTTPClientTransport, type AuthProvider } from '@modelcontextprotocol/client';
import * as v from 'valibot';

const RpcSchema = v.object({
  id: v.optional(v.number(), 0),
  method: v.string(),
  params: v.optional(v.object({ protocolVersion: v.optional(v.string(), '2025-11-25') }), {}),
});

/** The rejection of a tools/call the server answers with `status` and `body`, after a session that opened. */
export async function refusedToolCall(input: { status: number; body: string; authProvider?: AuthProvider }): Promise<Error> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const message = v.parse(RpcSchema, await request.json());

      if (message.method === 'initialize') {
        const result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'refusing', version: '0' } };

        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      }

      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });

      return new Response(input.body, { status: input.status });
    },
  });

  const client = new Client({ name: 'kinu-test', version: '0' });

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(server.port)}/mcp`), { authProvider: input.authProvider }));
    await client.callTool({ name: 'do_thing', arguments: {} });
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`the transport rejected with a non-Error: ${String(error)}`, { cause: error });
  } finally {
    await client.close();
    await server.stop(true);
  }

  throw new Error(`the server answered ${String(input.status)} and the call still succeeded`);
}

/** The rejection of an SSE connection whose event stream the server answers with `status`. */
export async function refusedSseConnect(input: { status: number }): Promise<Error> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('nope', { status: input.status }) });
  const client = new Client({ name: 'kinu-test', version: '0' });

  try {
    await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${String(server.port)}/sse`)));
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`the transport rejected with a non-Error: ${String(error)}`, { cause: error });
  } finally {
    await client.close();
    await server.stop(true);
  }

  throw new Error(`the server answered ${String(input.status)} and the stream still opened`);
}
