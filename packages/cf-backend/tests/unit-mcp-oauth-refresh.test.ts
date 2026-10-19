/**
 * An account's OAuth MCP connection through expiry, on the SDK client and token provider the product connects with,
 * against the tiers' own OAuth-protected server (scripts/scripted-mcp-oauth.ts), whose refresh tokens rotate and are
 * revoked when presented twice, as many providers' are.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { KinuMcpOAuthProvider } from '../src/user/mcp-oauth-provider';
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

/** The network as the product's Worker reaches the tiers' server; every token request counted. */
function network() {
  const refreshes: string[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);

    if (new URL(request.url).pathname === '/oauth/token') {
      const body = await request.clone().text();

      const form = new URLSearchParams(body);

      if (form.get('grant_type') === 'refresh_token') refreshes.push(form.get('refresh_token') ?? '');
    }

    return worker.fetch(request, ENV);
  };

  return { fetch, refreshes };
}

/** A connection signed in once, as the product's callback completes it, and ready to call. */
async function signedIn(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const provider = new KinuMcpOAuthProvider(storage(), 'kinu-user-mcp', 'https://staging.kinu.run/api/user/mcp/callback');

  provider.serverId = 'srv';
  const url = new URL(`${ORIGIN}${SCRIPTED_MCP_OAUTH_PATH}/${String(TTL)}`);
  const first = new StreamableHTTPClientTransport(url, { authProvider: provider, fetch });

  await expect(new Client({ name: 'kinu', version: '1' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  const authorized = await fetch(provider.authUrl ?? '', { headers: { authorization: `Bearer ${KEY}` }, redirect: 'manual' });
  const callback = new URL(authorized.headers.get('location') ?? '');

  expect(callback.pathname).toBe('/api/user/mcp/callback');
  await provider.runWithCodeVerifierState(callback.searchParams.get('state') ?? '', async () => { await first.finishAuth(callback.searchParams.get('code') ?? ''); });

  const client = new Client({ name: 'kinu', version: '1' });

  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider, fetch }));

  return { client, provider };
}

describe('an OAuth MCP connection whose access token expired', () => {
  test('one call refreshes its token once and answers', async () => {
    const net = network();
    const { client } = await signedIn(net.fetch);

    setSystemTime(new Date(Date.now() + TTL * 1000));

    try {
      expect(await client.callTool({ name: SCRIPTED_MCP_TOOL, arguments: {} })).toMatchObject({ content: [{ type: 'text' }] });
      expect(net.refreshes).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });

  // Calls arriving together after expiry each met a 401 and each refreshed the same refresh token: the server revoked
  // the grant on the second, two of three calls failed, and the connection needed signing in again.
  test('calls made together never present one refresh token twice, all answer, and the grant stays signed in', async () => {
    const net = network();
    const { client, provider } = await signedIn(net.fetch);

    setSystemTime(new Date(Date.now() + TTL * 1000));

    try {
      const answers = await Promise.allSettled([1, 2, 3].map(async () => client.callTool({ name: SCRIPTED_MCP_TOOL, arguments: {} })));

      expect(answers.map((answer) => answer.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      expect(new Set(net.refreshes).size).toBe(net.refreshes.length);
      expect(await provider.tokens()).toMatchObject({ refresh_token: expect.any(String) });
    } finally {
      setSystemTime();
    }
  });
});
