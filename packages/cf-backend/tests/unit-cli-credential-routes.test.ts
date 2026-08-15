// Route-level behavior for the CLI's provider-credential surface — what lets
// `proteus provider connect` put a key in the owner's account instead of on
// that machine's disk.
//
// Contract under test:
//   - interactive session tokens only: a CI token cannot write a provider key
//   - set and delete reach the store; the store's own validation surfaces
//   - the listing carries key/kind/timestamps and never a secret
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do.js';
import { describe, expect, test } from 'bun:test';
import { handleCliRequest } from '../src/cli/routes.js';
import type { JsonValue } from '@proteus/core';
import type { UserCaller } from '../src/user/workspace-capability.js';
import * as v from 'valibot';

const USER_ID = '0123456789abcdef0123456789abcdef';
const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;
const CI_TOKEN = `pta_${USER_ID}_${'c'.repeat(44)}`;
const CredentialListSchema = v.array(v.object({ key: v.string(), kind: v.string() }));

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(): Stub;
}

interface CredentialRouteTestBindings<Stub> {
  UserDO: TestNamespace<Stub>;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

function testEnv<Stub>(bindings: CredentialRouteTestBindings<Stub>): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: CLI credential handlers read exactly the constructed UserDO
  // namespace and credential key; every reachable binding is present.
  return env as Env;
}

function handled(response: Response | null): Response {
  if (!response) throw new Error('credential route did not handle the request');
  return response;
}

function setupEnv() {
  const stored = new Map<string, { kind: string; value: { kind?: string } }>();
  const userDO = {
    async verifyCliToken(_caller: UserCaller, token: string) {
      return {
        ok: token === SESSION_TOKEN,
        tokenHash: 'session-hash',
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async verifyAccessToken(_caller: UserCaller, token: string) {
      if (token !== CI_TOKEN) return { ok: false, error: 'invalid token' };
      return {
        ok: true,
        tokenHash: 'ci-hash',
        scopes: ['workspace.read', 'workspace.exec', 'ai.proxy'],
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async listCredentials(_caller: UserCaller) {
      return [...stored.entries()].map(([key, v]) => ({ key, kind: v.kind, createdAt: 1, updatedAt: 2 }));
    },
    async setCredential(_caller: UserCaller, key: string, credential: { kind?: string }) {
      if (key === 'cloudflare.ai-gateway') throw new Error('cloudflare.ai-gateway is derived from your Cloudflare login and cannot be stored directly.');
      stored.set(key, { kind: credential.kind ?? 'bearer', value: credential });
    },
    async deleteCredential(_caller: UserCaller, key: string) { stored.delete(key); },
  };
  const env = testEnv({
    UserDO: { idFromName: (n: string) => n, get: () => userDO },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  return { env, stored };
}

function credentialRequest(opts: { token?: string; key?: string; method?: string; body?: JsonValue }) {
  const path = opts.key ? `/api/cli/credentials/${encodeURIComponent(opts.key)}` : '/api/cli/credentials';
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      authorization: `Bearer ${opts.token ?? SESSION_TOKEN}`,
      'content-type': 'application/json',
    },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return new Request(`https://proteus.example.com${path}`, init);
}

describe('CLI provider credentials', () => {
  test('a session token can store a key in the account', async () => {
    const { env, stored } = setupEnv();
    const res = await handleCliRequest(credentialRequest({
      key: 'openrouter.bearer', method: 'POST', body: { kind: 'bearer', token: 'sk-or-real' },
    }), env);

    expect(res?.status).toBe(201);
    expect(stored.get('openrouter.bearer')).toMatchObject({ kind: 'bearer' });
  });

  test('a CI access token cannot — writing a provider key is interactive-only', async () => {
    const { env, stored } = setupEnv();
    const res = await handleCliRequest(credentialRequest({
      token: CI_TOKEN, key: 'openrouter.bearer', method: 'POST', body: { kind: 'bearer', token: 'sk-or-real' },
    }), env);

    expect(res?.status).toBe(403);
    expect(await handled(res).text()).toContain('interactive CLI session token');
    expect(stored.size).toBe(0);
  });

  test('the listing names what is connected and never a secret', async () => {
    const { env } = setupEnv();
    await handleCliRequest(credentialRequest({
      key: 'anthropic.bearer', method: 'POST', body: { kind: 'bearer', token: 'sk-ant-real' },
    }), env);

    const res = await handleCliRequest(credentialRequest({}), env);
    const body = v.parse(CredentialListSchema, await handled(res).json());
    expect(body).toMatchObject([{ key: 'anthropic.bearer', kind: 'bearer' }]);
    expect(JSON.stringify(body)).not.toContain('sk-ant-real');
  });

  test('delete removes it', async () => {
    const { env, stored } = setupEnv();
    await handleCliRequest(credentialRequest({
      key: 'openai.bearer', method: 'POST', body: { kind: 'bearer', token: 'sk-real' },
    }), env);
    const res = await handleCliRequest(credentialRequest({ key: 'openai.bearer', method: 'DELETE' }), env);

    expect(res?.status).toBe(200);
    expect(stored.size).toBe(0);
  });

  test("a key the store refuses reports the store's own reason", async () => {
    const { env } = setupEnv();
    const res = await handleCliRequest(credentialRequest({
      key: 'cloudflare.ai-gateway', method: 'POST', body: { kind: 'bearer', token: 'x' },
    }), env);

    expect(res?.status).toBe(400);
    expect(await handled(res).text()).toContain('derived from your Cloudflare login');
  });
});
