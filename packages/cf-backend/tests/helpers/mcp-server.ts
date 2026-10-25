/**
 * An MCP server over real HTTP on loopback, speaking Streamable HTTP in the legacy protocol, for an account's MCP client
 * to reach as it reaches a real one. Its tools, answers and refusals are the test's; every request is recorded. A
 * session it ended is answered 404, having run nothing (MCP 2025-11-25, basic/transports).
 */
import * as v from 'valibot';
import { JsonObjectSchema, mcpPresetById, type JsonObject, type JsonValue, type SqlExec } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import worker, { inMemoryGrants } from '../../../../scripts/scripted-model-worker';
import { SCRIPTED_MCP_OAUTH_PATH } from '../../../../scripts/scripted-mcp-oauth';

/** The process's own network, which a suite's stand-in for another service never answers for a test server. */
const network = globalThis.fetch;

const RpcSchema = v.object({
  id: v.optional(v.union([v.string(), v.number()])),
  method: v.string(),
  params: v.optional(v.looseObject({ protocolVersion: v.optional(v.string()), name: v.optional(v.string()), arguments: v.optional(JsonObjectSchema) })),
});

export interface McpTestCall {
  readonly name: string;
  readonly args: JsonObject;
  readonly session: string | null;
  readonly authorization: string | null;
}

export interface McpTestServer {
  readonly url: string;
  /** Each request as `<JSON-RPC method, or HTTP method> <session, or ->`, in order. */
  readonly seen: string[];
  /** Each `tools/call` as it arrived. */
  readonly calls: McpTestCall[];
  /** The sessions it issued, in order. */
  readonly sessions: string[];
  /** What `tools/list` answers: any JSON, so a list that breaks the spec can be served. */
  tools: JsonValue[];
  /** What a call answers: a `CallToolResult`, or an HTTP answer of its own (a 500, say). */
  answer: (call: McpTestCall) => JsonObject | Response | Promise<JsonObject | Response>;
  /** The HTTP status `tools/list` is refused with, and the body; null serves it. */
  refuseList: { readonly status: number; readonly body: string } | null;
  /** The bearer every request must carry; null asks for none. */
  bearer: string | null;
  /** Whether each call is answered 404, having run nothing, and ends the session it came on. */
  endsEachCall: boolean;
  /** Ends a session: every later request that names it is answered 404. */
  end(session: string): void;
  stop(): Promise<void>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function result(id: string | number | undefined, value: JsonObject, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: value }), { headers: { ...JSON_HEADERS, ...headers } });
}

function rpcError(status: number, id: string | number | undefined, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), { status, headers: JSON_HEADERS });
}

type RpcMessage = v.InferOutput<typeof RpcSchema>;

/** A server issuing one session per `initialize`, or none with `sessions: false`. */
export function mcpTestServer(options: { readonly sessions?: boolean; readonly tools?: JsonValue[] } = {}): McpTestServer {
  const ended = new Set<string>();
  const issuing = options.sessions !== false;

  const state: McpTestServer = {
    url: '',
    seen: [],
    calls: [],
    sessions: [],
    tools: options.tools ?? [],
    answer: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    refuseList: null,
    bearer: null,
    endsEachCall: false,
    end: (session) => { ended.add(session); },
    stop: async () => http.stop(true),
  };

  const initialized = (message: RpcMessage): Response => {
    const issued = `s${String(state.sessions.length + 1)}`;

    if (issuing) state.sessions.push(issued);

    return result(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'kinu-test-mcp', version: '1' },
    }, issuing ? { 'mcp-session-id': issued } : {});
  };

  /** A request on a session: its own answer, once the session is one this server issued and has not ended. */
  const answered = async (message: RpcMessage, session: string | null, authorization: string | null): Promise<Response> => {
    if (message.id === undefined) return new Response(null, { status: 202 });

    if (message.method === 'tools/list') {
      const refused = state.refuseList;

      return refused === null ? result(message.id, { tools: state.tools }) : new Response(refused.body, { status: refused.status });
    }

    if (message.method === 'tools/call' && state.endsEachCall) {
      if (session !== null) ended.add(session);

      return new Response(null, { status: 404 });
    }

    if (message.method === 'tools/call') {
      const call = { name: message.params?.name ?? '', args: message.params?.arguments ?? {}, session, authorization };

      state.calls.push(call);
      const answer = await state.answer(call);

      return answer instanceof Response ? answer : result(message.id, answer);
    }

    return message.method === 'ping' ? result(message.id, {}) : rpcError(200, message.id, -32_601, `no method ${message.method}`);
  };

  const posted = async (request: Request, session: string | null): Promise<Response> => {
    const message = v.parse(RpcSchema, await request.json());

    state.seen.push(`${message.method} ${session ?? '-'}`);

    // The era probe of a client that speaks the modern protocol too: this server speaks only the legacy one.
    if (message.method === 'server/discover') return rpcError(200, message.id, -32_601, 'no method server/discover');

    if (message.method === 'initialize') return initialized(message);

    if (issuing && session === null) return rpcError(400, message.id, -32_600, 'this request names no session');

    if (issuing && session !== null && (ended.has(session) || !state.sessions.includes(session))) return new Response(null, { status: 404 });

    return answered(message, session, request.headers.get('authorization'));
  };

  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const session = request.headers.get('mcp-session-id');

      if (state.bearer !== null && request.headers.get('authorization') !== `Bearer ${state.bearer}`) {
        state.seen.push(`${request.method} unauthorized`);

        return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      }

      if (request.method === 'DELETE' && session !== null) {
        state.seen.push(`DELETE ${session}`);
        ended.add(session);

        return new Response(null, { status: 200 });
      }

      // No server-initiated stream: the spec lets a server refuse the GET with 405.
      return request.method === 'POST' ? posted(request, session) : new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
    },
  });

  return Object.assign(state, { url: `http://127.0.0.1:${String(http.port)}/mcp` });
}

/** A server row as an add that connected and listed it leaves it, pointing at `url` and keeping `tools`. */
export function storedMcpServer(sql: SqlExec, server: {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly tools: readonly JsonValue[];
  readonly presetId?: string;
  readonly allowedTools?: string;
}): void {
  sql.exec(
    `INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, preset_id, callback_url, oauth_client_id, session, status, status_error, tools)
      VALUES (?, ?, ?, 'streamable-http', NULL, ?, ?, 'https://kinu.example/api/user/mcp/callback', NULL, NULL, 'connected', NULL, ?)`,
    server.id, server.name, server.url, server.allowedTools ?? null, server.presetId ?? null, JSON.stringify({ tools: server.tools, refused: [] }),
  );
}

/** Where the tiers' OAuth-protected MCP server answers (scripts/scripted-mcp-oauth.ts), in this process. */
export const SCRIPTED_ORIGIN = 'https://scripted-model.kinu.run';

/** What authorizing a grant there takes as its bearer, as a person's consent stands in for it. */
export const SCRIPTED_KEY = 'fixture-scripted-key';

/** Its server whose access tokens live `ttl` seconds. */
export function scriptedOAuthServer(ttl: number): string {
  return `${SCRIPTED_ORIGIN}${SCRIPTED_MCP_OAUTH_PATH}/${String(ttl)}`;
}

/** How the issuer's token endpoint answers a renewal: as it is, unreachable, or refusing the grant. */
export type TokenEndpoint = 'serving' | 'unreachable' | 'refusing';

export interface ScriptedOAuthNetwork {
  /** Every refresh token presented, in order. */
  readonly refreshes: string[];
  /** The HTTP method of every request to its MCP endpoint, in order. */
  readonly served: string[];
  renewals: TokenEndpoint;
  /** An authorization server its protected-resource metadata names in place of its own, from now on; null names its own. */
  issuerMovedTo: string | null;
  /** Whether its protected-resource metadata answers 503, as a server down for a moment does. */
  resourceMetadataDown: boolean;
  /** Every request that reached the moved authorization server, as `<method> <path> <body>`. */
  readonly moved: string[];
  /** Gives the process its own fetch back. */
  readonly restore: () => void;
}

/**
 * The network as the account reaches the tiers' OAuth server, which answers in this process; with `issuer`, its
 * authorization server answers at that origin, apart from the MCP server's, as GitHub's does.
 */
export function scriptedOAuthNetwork(options: { readonly issuer?: string } = {}): ScriptedOAuthNetwork {
  const real = globalThis.fetch;
  const env = { SCRIPTED_MODEL_KEY: SCRIPTED_KEY, OAUTH_GRANTS: inMemoryGrants() };
  const issuer = new URL(options.issuer ?? SCRIPTED_ORIGIN).origin;

  const net: ScriptedOAuthNetwork = {
    refreshes: [], served: [], renewals: 'serving', issuerMovedTo: null, resourceMetadataDown: false, moved: [], restore: () => { globalThis.fetch = real; },
  };

  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const moved = net.issuerMovedTo;

    if (moved !== null && url.origin === new URL(moved).origin) return movedIssuer(moved, request, net.moved);

    if (url.origin !== SCRIPTED_ORIGIN && url.origin !== issuer) return real(input, init);

    if (url.origin === SCRIPTED_ORIGIN && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (net.resourceMetadataDown) return new Response('down for a moment', { status: 503 });
      const named = v.parse(v.looseObject({}), await (await worker.fetch(request, env)).json());

      return Response.json({ ...named, authorization_servers: [moved ?? issuer] });
    }

    const form = new URLSearchParams(url.pathname === '/oauth/token' ? await request.clone().text() : '');

    if (form.get('grant_type') === 'refresh_token') {
      if (net.renewals === 'unreachable') throw new TypeError('fetch failed');

      if (net.renewals === 'refusing') return Response.json({ error: 'invalid_grant', error_description: 'the grant was revoked' }, { status: 400 });
      net.refreshes.push(form.get('refresh_token') ?? '');
    }

    if (url.pathname.startsWith(SCRIPTED_MCP_OAUTH_PATH)) net.served.push(request.method);

    return worker.fetch(request, env);
  }, { preconnect: real.preconnect });

  return net;
}

/** An authorization server a resource moved its login to: it publishes its metadata, records every request, and answers
 *  any token request with a login, as one that takes credentials would. */
async function movedIssuer(issuer: string, request: Request, seen: string[]): Promise<Response> {
  const { pathname } = new URL(request.url);

  seen.push(`${request.method} ${pathname} ${await request.text()}`);

  if (pathname.startsWith('/.well-known/oauth-authorization-server')) {
    return Response.json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    });
  }

  return Response.json({ access_token: 'taken', token_type: 'bearer', refresh_token: 'taken', expires_in: 3600 });
}

/** The person's consent at the issuer to the sign-in `authUrl` begins: where it sends their tab, the product's callback. */
export async function consented(authUrl: string): Promise<string> {
  const authorized = await fetch(authUrl, { headers: { authorization: `Bearer ${SCRIPTED_KEY}` }, redirect: 'manual' });

  return authorized.headers.get('location') ?? '';
}

/** Where the GitHub preset's MCP server answers. */
export const GITHUB_MCP_URL = present(mcpPresetById('github'), 'the GitHub preset').serverUrl;

/**
 * `body`, while a test MCP server answers at each of `urls` as an add that connects needs, and the network as it was
 * after: for a suite whose subject is what a connection is for, not the connection.
 */
export async function servedMcp<T>(urls: readonly string[], body: () => Promise<T>): Promise<T> {
  const server = mcpTestServer();
  const real = globalThis.fetch;

  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();

    return urls.includes(url) ? network(server.url, init) : real(input, init);
  }, { preconnect: real.preconnect });

  try {
    return await body();
  } finally {
    globalThis.fetch = real;
    await server.stop();
  }
}
