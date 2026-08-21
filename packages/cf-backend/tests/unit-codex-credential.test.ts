// The Codex credential's revocation path on the hosted backend.
//
// A revoked ChatGPT login used to sit in the store forever: the refresh
// failed, the failure was logged, and the provider kept advertising itself
// while every model call 401'd. The Cloudflare OAuth credential already has
// the honest shape (invalid_grant strips the dead token, the connect CTA
// resurfaces) — these tests pin the same behavior for `codex.oauth`.
import { describe, test, expect } from 'bun:test';
import { createTestUserDO, testOwner } from './helpers/user-do';
import { asFetchFunction } from '@kinu.run/core';

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

describe('UserDO Codex credential revocation', () => {
  test('a revoked refresh token drops the credential and refuses the call', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async (input, init) => {
      expect(String(input)).toBe(CODEX_TOKEN_URL);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('rt-revoked');
      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'The provided authorization grant is invalid',
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    try {
      const harness = createTestUserDO();
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, 'codex.oauth', {
        kind: 'oauth', accessToken: 'dead-access', refreshToken: 'rt-revoked',
      });
      expect(await harness.userDO.listCredentials(owner)).toHaveLength(1);

      // The forced refresh hits the revoked grant: no headers, and the row is
      // gone so the provider stops advertising itself.
      await expect(harness.userDO.getAuthHeaders(owner, 'codex.oauth', { forceRefresh: true }))
        .resolves.toBeNull();
      expect(await harness.userDO.listCredentials(owner)).toHaveLength(0);
      harness.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a transient refresh failure keeps the credential in place', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('upstream exploded', { status: 503 }));
    try {
      const harness = createTestUserDO();
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, 'codex.oauth', {
        kind: 'oauth', accessToken: 'maybe-stale', refreshToken: 'rt-alive',
      });

      const headers = await harness.userDO.getAuthHeaders(owner, 'codex.oauth', { forceRefresh: true });
      expect(headers?.Authorization).toBe('Bearer maybe-stale');
      expect(await harness.userDO.listCredentials(owner)).toHaveLength(1);
      harness.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
