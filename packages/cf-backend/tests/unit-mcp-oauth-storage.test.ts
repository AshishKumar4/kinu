// An MCP server's OAuth login lands sealed in the account object's storage, in the reads and writes the Agents SDK's
// provider makes (agents 0.26.0 do-oauth-client-provider.js: single-key get and put, a prefix list whose values it
// reads, a raw copy between keys in `migrateServerId`), and one that does not open reads as no login. The provider class
// itself is not constructed here: `--parallel` workers share a process with suites that stand a double in for it.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createCredentialCipher, type JsonValue } from '@kinu.run/core';
import { mcpOAuthStorage } from '../src/user/mcp-oauth-storage';
import { makeCtx } from './helpers/platform-context';

const ENV = { CREDENTIAL_ENCRYPTION_KEY: 'a-test-credential-encryption-key-0123456789' };

const TOKEN = { access_token: ['gho_', 'access0123456789abcdefghijklmnopqrst'].join(''), refresh_token: ['ghr_', 'refresh0123456789abcdefghijklmnopqr'].join(''), token_type: 'bearer' };

const TOKEN_KEY = '/kinu-user-mcp/github/client-1/token';

function account() {
  const ctx = makeCtx(new Database(':memory:'), 'account-object');

  return { raw: ctx.storage, sealed: mcpOAuthStorage(ctx, ENV) };
}

describe("an MCP server's login is sealed at rest", () => {
  test('a token, a client registration and a PKCE verifier land as envelopes and read back whole, by key and by prefix', async () => {
    const { raw, sealed } = account();
    const verifier = { verifier: 'pkce-verifier-0123456789', createdAt: 1 };

    await sealed.put(TOKEN_KEY, TOKEN);
    await sealed.put('/kinu-user-mcp/github/client-1/client_info/', { client_id: 'client-1', client_secret: 'registered-secret-value' });
    await sealed.put('/kinu-user-mcp/github/client-1/code_verifier_challenge/abc', verifier);

    for (const value of (await raw.list({ prefix: '/kinu-user-mcp/' })).values()) {
      expect(typeof value === 'string' && value.startsWith('pce1.')).toBe(true);

      for (const plain of [TOKEN.access_token, TOKEN.refresh_token, 'registered-secret-value', verifier.verifier]) expect(JSON.stringify(value)).not.toContain(plain);
    }

    expect(await sealed.get<JsonValue>(TOKEN_KEY)).toEqual(TOKEN);
    expect([...(await sealed.list({ prefix: '/kinu-user-mcp/github/client-1/code_verifier_challenge/' })).values()]).toEqual([verifier]);
  });

  test('a login stored before logins were sealed, or sealed for another account, reads as none: the server asks for sign-in', async () => {
    const { raw, sealed } = account();

    await raw.put(TOKEN_KEY, TOKEN);
    expect(await sealed.get<JsonValue>(TOKEN_KEY)).toBeUndefined();

    await raw.put(TOKEN_KEY, await (await createCredentialCipher(ENV)).seal('another-account:mcp-oauth', JSON.stringify(TOKEN)));
    expect(await sealed.get<JsonValue>(TOKEN_KEY)).toBeUndefined();
    expect((await sealed.list({ prefix: '/kinu-user-mcp/' })).size).toBe(0);
  });

  test('a value the SDK copies to another key over the raw storage still opens there', async () => {
    const { raw, sealed } = account();

    await sealed.put(TOKEN_KEY, TOKEN);
    await raw.put(TOKEN_KEY.replace('/github/', '/github-2/'), await raw.get(TOKEN_KEY));

    expect(await sealed.get<JsonValue>(TOKEN_KEY.replace('/github/', '/github-2/'))).toEqual(TOKEN);
  });
});
