/**
 * The tiers' OAuth-protected MCP server, through the deployed Worker's own fetch: a grant is authorized with the
 * Worker's key, its access token expires on its path's lifetime, a refresh answers a new pair, and a refresh token
 * presented twice revokes its grant. The down window makes the unprotected server unreachable for exactly its span.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import worker, { inMemoryGrants } from '../../scripts/scripted-model-worker';
import { SCRIPTED_MCP_PATH } from '../../scripts/scripted-mcp';
import { OAUTH_AUTHORIZE_PATH, SCRIPTED_MCP_OAUTH_PATH } from '../../scripts/scripted-mcp-oauth';

const ORIGIN = 'https://scripted-model.kinu.run';

const KEY = 'fixture-scripted-key';

const REDIRECT = 'https://staging.kinu.run/api/user/mcp/callback';

const ENV = { SCRIPTED_MODEL_KEY: KEY, OAUTH_GRANTS: inMemoryGrants() };

const TokensSchema = v.object({ access_token: v.string(), refresh_token: v.string(), expires_in: v.number(), token_type: v.literal('Bearer') });

const ErrorSchema = v.object({ error: v.string() });

async function verifierAndChallenge(): Promise<{ verifier: string; challenge: string }> {
  const verifier = 'v'.repeat(43);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

  return { verifier, challenge: btoa(String.fromCharCode(...digest)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '') };
}

/** Register, authorize with the key, exchange the code: a grant's first pair for the server of `ttl` seconds. */
async function granted(ttl: number): Promise<v.InferOutput<typeof TokensSchema>> {
  const registered = await worker.fetch(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT] }) }), ENV);
  const { client_id: client } = v.parse(v.object({ client_id: v.string() }), await registered.json());
  const { verifier, challenge } = await verifierAndChallenge();
  const resource = `${ORIGIN}${SCRIPTED_MCP_OAUTH_PATH}/${String(ttl)}`;
  const query = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st', resource });
  const authorized = await worker.fetch(new Request(`${ORIGIN}${OAUTH_AUTHORIZE_PATH}?${query.toString()}`, { headers: { authorization: `Bearer ${KEY}` } }), ENV);
  const location = new URL(authorized.headers.get('location') ?? '');

  expect(location.searchParams.get('state')).toBe('st');
  const exchanged = await token({ grant_type: 'authorization_code', code: location.searchParams.get('code') ?? '', code_verifier: verifier, redirect_uri: REDIRECT, client_id: client });

  return v.parse(TokensSchema, await exchanged.json());
}

async function token(form: Readonly<Record<string, string>>): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }), ENV);
}

/** `initialize` on the protected server with `access`: its status, and the challenge a refusal names. */
async function initialized(ttl: number, access: string): Promise<{ status: number; challenge: string | null }> {
  const answer = await worker.fetch(new Request(`${ORIGIN}${SCRIPTED_MCP_OAUTH_PATH}/${String(ttl)}`, {
    method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  }), ENV);

  return { status: answer.status, challenge: answer.headers.get('www-authenticate') };
}

describe('the tiers\' OAuth-protected MCP server', () => {
  test('a grant authorized with the key answers MCP until its access token expires, and names its metadata when it has', async () => {
    const pair = await granted(1);

    expect(pair.expires_in).toBe(1);
    expect((await initialized(1, pair.access_token)).status).toBe(200);
    setSystemTime(new Date(Date.now() + 1_000));

    try {
      expect(await initialized(1, pair.access_token)).toEqual({
        status: 401, challenge: `Bearer error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${SCRIPTED_MCP_OAUTH_PATH}/1"`,
      });
    } finally {
      setSystemTime();
    }
  });

  test('authorizing without the key is refused, so only the tiers mint a grant', async () => {
    const refused = await worker.fetch(new Request(`${ORIGIN}${OAUTH_AUTHORIZE_PATH}?response_type=code`), ENV);

    expect(refused.status).toBe(401);
  });

  test('a refresh answers a new pair, and the used refresh token presented again revokes the grant', async () => {
    const first = await granted(60);
    const second = v.parse(TokensSchema, await (await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).json());

    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await initialized(60, second.access_token)).status).toBe(200);

    const reused = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token });

    expect(reused.status).toBe(400);
    expect(v.parse(ErrorSchema, await reused.json()).error).toBe('invalid_grant');
    // Revoked: the newest refresh token is refused too.
    expect((await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token })).status).toBe(400);
  });

  test('two refreshes of one grant at once: one answers a pair, the other revokes the grant', async () => {
    const pair = await granted(60);
    const answers = await Promise.all([1, 2].map(async () => (await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token })).status));

    expect([...answers].sort((a, b) => a - b)).toEqual([200, 400]);
  });

  test('the discovery documents a client reads first are public', async () => {
    const resource = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource${SCRIPTED_MCP_OAUTH_PATH}/60`), ENV);
    const server = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), ENV);

    expect(await resource.json()).toMatchObject({ resource: `${ORIGIN}${SCRIPTED_MCP_OAUTH_PATH}/60`, authorization_servers: [ORIGIN] });
    expect(await server.json()).toMatchObject({ token_endpoint: `${ORIGIN}/oauth/token`, code_challenge_methods_supported: ['S256'] });
  });
});

test('the unprotected server answers 503 inside the down window its URL names, and serves outside it', async () => {
  const now = Date.now();

  const initialize = (down: string) => worker.fetch(new Request(`${ORIGIN}${SCRIPTED_MCP_PATH}?down=${down}`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  }), ENV);

  expect((await initialize(`${String(now - 1_000)}-${String(now + 60_000)}`)).status).toBe(503);
  expect((await initialize(`${String(now - 60_000)}-${String(now - 1_000)}`)).status).toBe(200);
});
