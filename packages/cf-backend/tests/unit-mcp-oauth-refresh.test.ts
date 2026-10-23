/**
 * An account's OAuth MCP connection through expiry, on the SDK client and token provider the product connects with,
 * against the tiers' own OAuth-protected server (scripts/scripted-mcp-oauth.ts), whose refresh tokens rotate and are
 * revoked when presented twice, as many providers' are.
 */
import { afterEach, describe, expect, jest, setSystemTime, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import { asFetchFunction, mcpCredentialTransport, type JsonObject } from '@kinu.run/core';
import * as v from 'valibot';
import { RegisteredAppOAuthClientProvider } from '../src/user/mcp-registered-app';
import { durableObjectStorage } from './helpers/programmatic-host';
import type { JsonValue } from '@kinu.run/core';
import worker, { inMemoryGrants } from '../../../scripts/scripted-model-worker';
import { SCRIPTED_MCP_OAUTH_PATH } from '../../../scripts/scripted-mcp-oauth';
import { SCRIPTED_MCP_TOOL } from '../../../scripts/scripted-mcp';

const ORIGIN = 'https://scripted-model.kinu.run';

const KEY = 'fixture-scripted-key';

const TTL = 60;

/** Durable Object storage as the provider reads it: a map, its list by prefix. */
function storage(): DurableObjectStorage {
  const stored = new Map<string, JsonValue>();

  return durableObjectStorage({
    get: async (key: string) => stored.get(key),
    put: async (key: string, value: JsonValue) => { stored.set(key, value); },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) stored.delete(key);

      return true;
    },
    list: async (options?: { prefix?: string }) => new Map([...stored].filter(([key]) => key.startsWith(options?.prefix ?? ''))),
  });
}

const ENV = { SCRIPTED_MODEL_KEY: KEY, OAUTH_GRANTS: inMemoryGrants() };

/** The network as the product's Worker reaches the tiers' server; every refresh token presented, in order. `hold`
 *  keeps the next refresh's answer back, once the server has answered it, until `release`. */
function network() {
  const refreshes: string[] = [];
  let held: { readonly started: ReturnType<typeof Promise.withResolvers<void>>; readonly release: ReturnType<typeof Promise.withResolvers<void>> } | null = null;

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const form = new URLSearchParams(new URL(request.url).pathname === '/oauth/token' ? await request.clone().text() : '');
    const answer = await worker.fetch(request, ENV);

    if (form.get('grant_type') !== 'refresh_token') return answer;
    refreshes.push(form.get('refresh_token') ?? '');
    const holding = held;

    held = null;

    if (holding !== null) {
      holding.started.resolve();
      await holding.release.promise;
    }

    return answer;
  };

  const hold = () => {
    const holding = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };

    held = holding;

    return { started: holding.started.promise, release: () => { holding.release.resolve(); } };
  };

  return { fetch, refreshes, hold };
}

/** A connection signed in once, as the product's callback completes it, and ready to call: on the transport fetch the
 *  product gives every account server (`mcpCredentialTransport`; this one holds no credential), over `network`. */
async function signedIn(net: ReturnType<typeof network>, ttl: number) {
  globalThis.fetch = asFetchFunction(net.fetch);
  const provider = new DurableObjectOAuthClientProvider(storage(), 'kinu-user-mcp', 'https://staging.kinu.run/api/user/mcp/callback');

  provider.serverId = 'srv';
  const url = new URL(`${ORIGIN}${SCRIPTED_MCP_OAUTH_PATH}/${String(ttl)}`);
  const transport = () => new StreamableHTTPClientTransport(url, { ...mcpCredentialTransport(url.toString(), async () => null), authProvider: provider });
  const first = transport();

  await expect(new Client({ name: 'kinu', version: '1' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  const authorized = await net.fetch(provider.authUrl ?? '', { headers: { authorization: `Bearer ${KEY}` }, redirect: 'manual' });
  const callback = new URL(authorized.headers.get('location') ?? '');

  expect(callback.pathname).toBe('/api/user/mcp/callback');
  await provider.runWithCodeVerifierState(callback.searchParams.get('state') ?? '', async () => { await first.finishAuth(callback.searchParams.get('code') ?? ''); });

  const client = new Client({ name: 'kinu', version: '1' });

  await client.connect(transport());

  return { client, provider };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

describe('an OAuth MCP connection whose access token expired', () => {
  test('one call refreshes its token once and answers', async () => {
    const net = network();
    const { client } = await signedIn(net, TTL);

    setSystemTime(new Date(Date.now() + TTL * 1000));

    try {
      expect(await client.callTool({ name: SCRIPTED_MCP_TOOL, arguments: {} })).toMatchObject({ content: [{ type: 'text' }] });
      expect(net.refreshes).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });

  // Calls arriving together after expiry each met a 401 and each refreshed the same refresh token: the server revoked
  // the grant on the second. A token endpoint slower than any clock the waiting flows keep is the same race.
  test('calls made together, whose refresh is answered after a minute, present the refresh token once and keep the grant', async () => {
    const net = network();
    const { client } = await signedIn(net, 3600);
    const call = (args: JsonObject) => client.callTool({ name: SCRIPTED_MCP_TOOL, arguments: args });

    await call({ expire: true });
    const slow = net.hold();

    jest.useFakeTimers();
    const together = Promise.allSettled([1, 2, 3].map(async () => call({})));

    await slow.started;
    jest.advanceTimersByTime(61_000);
    slow.release();
    await together;
    jest.useRealTimers();

    // The grant answers its next refresh: it was never revoked.
    await call({ expire: true });
    expect(await call({})).toMatchObject({ content: [{ type: 'text' }] });
    expect(new Set(net.refreshes).size).toBe(net.refreshes.length);
  });
});

/**
 * Gmail's MCP as measured on 2026-10-19: `initialize` and `tools/list` answer without a token, and only `tools/call`
 * answers 401, naming a per-tool protected-resource document. Google issues a refresh token only to an authorization
 * asked with `access_type=offline`. Tokens are the fake's own, expired on demand.
 */
function gmail() {
  const endpoint = 'https://gmailmcp.googleapis.com/mcp/v1';
  const live = new Set<string>();
  const refreshes: string[] = [];
  let issued = 0;

  const json = (value: JsonValue, init: ResponseInit = {}) => Response.json(value, init);

  const tokens = (offline: boolean) => {
    issued += 1;
    const access = `ya29.${String(issued)}`;

    live.add(access);
    const answer: JsonObject = { access_token: access, token_type: 'Bearer', expires_in: 3599, scope: 'https://www.googleapis.com/auth/gmail.readonly' };

    if (offline) answer['refresh_token'] = `1//refresh.${String(issued)}`;

    return json(answer);
  };

  const documents: JsonObject = {
    'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1': {
      authorization_servers: ['https://accounts.google.com/'], bearer_methods_supported: ['header'], resource: endpoint,
      scopes_supported: ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    },
    'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/search_threads': {
      authorization_servers: ['https://accounts.google.com/'], bearer_methods_supported: ['header'], resource: 'https://gmailmcp.googleapis.com/mcp',
      scopes_supported: ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.readonly'],
    },
    'https://accounts.google.com/.well-known/oauth-authorization-server': {
      issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token', token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['plain', 'S256'], response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    },
  };

  const mcp = async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = v.parse(v.looseObject({ id: v.optional(v.unknown()), method: v.string() }), await request.json());
    const bearer = /^Bearer (.+)$/u.exec(request.headers.get('authorization') ?? '')?.[1];

    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const id = v.parse(v.number(), rpc.id);

    if (rpc.method === 'initialize') {
      return json({ jsonrpc: '2.0', id, result: { capabilities: { tools: { listChanged: false } }, protocolVersion: '2025-06-18', serverInfo: { name: 'StatelessServer', version: 'ESF' } } });
    }

    if (rpc.method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools: [{ name: 'search_threads', inputSchema: { type: 'object' } }] } });

    if (bearer === undefined || !live.has(bearer)) {
      return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Request is missing required authentication credential.' }], isError: true } }, {
        status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/search_threads"' },
      });
    }

    return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '1 thread' }] } });
  };

  const token = async (request: Request): Promise<Response> => {
    const form = new URLSearchParams(await request.text());

    if (form.get('grant_type') === 'refresh_token') {
      refreshes.push(form.get('refresh_token') ?? '');

      return tokens(false);
    }

    return tokens(form.get('code') === 'offline-code');
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const at = request.url.split('?')[0] ?? '';
    const document = documents[at];

    if (document !== undefined) return json(document);

    if (at === endpoint) return mcp(request);

    if (at === 'https://oauth2.googleapis.com/token') return token(request);

    return new Response('not found', { status: 404 });
  };

  return { fetch, refreshes, endpoint, expire: () => { live.clear(); } };
}

describe('Gmail, which lists its tools to anyone and refuses only a call', () => {
  test('is signed in when added, asked to stay signed in, and a call after its token expires refreshes and answers', async () => {
    const google = gmail();

    globalThis.fetch = asFetchFunction(google.fetch);
    // As the retired Gmail preset asked (ledger 1023-n): the registered-app provider is any `oauth-app` server's.
    const preset = { scope: 'https://www.googleapis.com/auth/gmail.readonly', authorize: { access_type: 'offline', prompt: 'consent' } };
    const callback = 'https://staging.kinu.run/api/user/mcp/callback';

    const provider = new RegisteredAppOAuthClientProvider({
      storage: storage(), clientName: 'kinu-user-mcp', baseRedirectUrl: callback, clientId: 'kinu.apps.googleusercontent.com',
      clientSecret: 'google-secret', scope: preset.scope, authorize: preset.authorize,
    });

    provider.serverId = 'gmail';
    const transport = () => new StreamableHTTPClientTransport(new URL(google.endpoint), { ...mcpCredentialTransport(google.endpoint, async () => null, 'first'), authProvider: provider });
    const first = transport();

    // Added: the sign-in starts here, not at the first call of some turn.
    await expect(new Client({ name: 'kinu', version: '1' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    const asked = new URL(provider.authUrl ?? '');

    expect({
      scope: asked.searchParams.get('scope')?.split(' ').filter((scope) => scope !== 'offline_access'),
      access_type: asked.searchParams.get('access_type'),
      prompt: asked.searchParams.get('prompt'),
    }).toEqual({ scope: preset.scope?.split(' '), access_type: 'offline', prompt: 'consent' });

    // Google gives a refresh token only to an offline authorization.
    const code = asked.searchParams.get('access_type') === 'offline' ? 'offline-code' : 'online-code';

    await provider.runWithCodeVerifierState(asked.searchParams.get('state') ?? '', async () => { await first.finishAuth(code); });
    const client = new Client({ name: 'kinu', version: '1' });

    await client.connect(transport());
    expect(await client.callTool({ name: 'search_threads', arguments: {} })).toMatchObject({ content: [{ text: '1 thread' }] });
    google.expire();
    expect(await client.callTool({ name: 'search_threads', arguments: {} })).toMatchObject({ content: [{ text: '1 thread' }] });
    expect(google.refreshes).toHaveLength(1);
    // An hour on, the refreshed token expires too. Google keeps the refresh token, so the next refresh presents the same
    // one; it must reach Google, not be answered with the first refresh's token, long expired (the rc27 review).
    google.expire();
    expect(await client.callTool({ name: 'search_threads', arguments: {} })).toMatchObject({ content: [{ text: '1 thread' }] });
    expect(google.refreshes).toEqual(['1//refresh.1', '1//refresh.1']);
  });
});
