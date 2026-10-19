/**
 * The tiers' MCP server whose sessions end on cue: Streamable HTTP and one tool, which ends the session it names.
 * MCP 2025-11-25, basic/transports, "Session Management" items 3-4: a server that ended a session answers 404 to any
 * request carrying its `MCP-Session-Id`, having run nothing, and its client starts a new one. A deployed case drives a
 * product's MCP connection through that end as often as it likes (`mcp-reconnect.first-run.ts`).
 *
 * Pure and stateless, as the Worker serving it is: the session a call ends travels in that call, so a call that names
 * the session carrying it is answered 404, and the same call retried on the client's new session is served. The
 * scripted model's Worker serves it behind the same bearer as the model.
 */
import * as v from 'valibot';
import type { JsonObject } from '../packages/core/src/utils/json';

/** Where the Worker serves it. */
export const SCRIPTED_MCP_PATH = '/mcp/expiring';

/** The one tool: it names the session that served the call, after ending the session its `end` names. */
export const SCRIPTED_MCP_TOOL = 'session';

const SESSION_ID = /^s\d{13}-[0-9a-f]{8}$/u;

const RpcSchema = v.object({
  jsonrpc: v.literal('2.0'),
  id: v.optional(v.union([v.string(), v.number()])),
  method: v.string(),
  params: v.optional(v.looseObject({
    protocolVersion: v.optional(v.string()),
    name: v.optional(v.string()),
    arguments: v.optional(v.looseObject({ end: v.optional(v.string()) })),
  })),
});

/** What the tool answers, as JSON text. */
export const SessionAnswerSchema = v.object({ session: v.string() });

export interface McpAnswer {
  readonly status: number;
  readonly body: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function result(id: string | number | undefined, value: JsonObject, headers: Readonly<Record<string, string>> = {}): McpAnswer {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: value }), headers: { ...JSON_HEADERS, ...headers } };
}

function rpcError(status: number, id: string | number | undefined, code: number, message: string): McpAnswer {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), headers: JSON_HEADERS };
}

/** One HTTP exchange: the request's method, its `MCP-Session-Id`, its body; `now` and `nonce` mint a session id. */
export function scriptedMcp(request: { readonly method: string; readonly session: string | null; readonly body: string }, now: number, nonce: string): McpAnswer {
  // No server-initiated stream and no client-ended session: the spec lets a server refuse both with 405.
  if (request.method !== 'POST') return { status: 405, body: null, headers: { allow: 'POST' } };
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), RpcSchema), request.body);

  if (!parsed.success) return rpcError(400, undefined, -32_700, `not a JSON-RPC request: ${v.summarize(parsed.issues)}`);
  const message = parsed.output;

  if (message.method === 'initialize') {
    return result(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'kinu-scripted-expiring', version: '1' },
    }, { 'mcp-session-id': `s${String(now)}-${nonce}` });
  }

  const { session } = request;

  if (session === null || !SESSION_ID.test(session)) return rpcError(400, message.id, -32_600, 'this request names no session this server issued');

  if (message.id === undefined) return { status: 202, body: null, headers: {} };

  if (message.method === 'tools/list') {
    return result(message.id, {
      tools: [{
        name: SCRIPTED_MCP_TOOL,
        description: 'Ends the session `end` names, then names the MCP session that served this call.',
        inputSchema: {
          type: 'object',
          properties: {
            end: { type: 'string', description: 'A session to end.' },
            expire: { type: 'boolean', description: 'Behind OAuth: expire the access token this call carried, once answered.' },
          },
        },
      }],
    });
  }

  if (message.method === 'tools/call' && message.params?.name === SCRIPTED_MCP_TOOL) {
    // The session is over: nothing runs, and the client starts a new one, on which this call is served.
    if (message.params.arguments?.end === session) return { status: 404, body: null, headers: {} };

    return result(message.id, { content: [{ type: 'text', text: JSON.stringify({ session }) }] });
  }

  if (message.method === 'ping') return result(message.id, {});

  return rpcError(200, message.id, -32_601, `no method ${message.method}`);
}
