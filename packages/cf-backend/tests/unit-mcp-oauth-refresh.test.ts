/**
 * An account's OAuth MCP connection through expiry, on the SDK client and token provider the product connects with,
 * against the tiers' own OAuth-protected server (scripts/scripted-mcp-oauth.ts), whose refresh tokens rotate and are
 * revoked when presented twice, as many providers' are.
 */
import { afterEach, describe, expect, jest, setSystemTime, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import { asFetchFunction, mcpCredentialTransport, type JsonObject } from '@kinu.run/core';
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
