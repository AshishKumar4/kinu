// Credential fixtures — pre-loaded in-memory CredentialStore for tests.
import { createInMemoryCredentialStore, type CredentialStore, type Credential } from '@proteus/core';

/** Build a credential store pre-loaded with the given credentials. */
export function createTestCredentials(
  entries: Record<string, Credential> = {},
): CredentialStore {
  const store = createInMemoryCredentialStore();
  for (const [key, value] of Object.entries(entries)) {
    // fire-and-forget — in-memory store is synchronous under the hood.
    void store.set(key, value);
  }
  return store;
}

/** A fresh OAuth credential — JWT-shaped access token with `exp` far in
 *  the future, so accessTokenExpiring() returns false. */
export function freshOAuthCredential(opts: { accountId?: string } = {}): Credential {
  const claims: Record<string, unknown> = { exp: Math.floor(Date.now() / 1000) + 3600 };
  if (opts.accountId) {
    claims['https://api.openai.com/auth'] = { chatgpt_account_id: opts.accountId };
  }
  const b64 = (s: string) => Buffer.from(s).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const accessToken = `header.${b64(JSON.stringify(claims))}.sig`;
  return {
    kind: 'oauth',
    accessToken,
    refreshToken: 'rfsh-' + Math.random().toString(36).slice(2, 10),
    expiresAt: Date.now() + 3_600_000,
    metadata: opts.accountId ? { accountId: opts.accountId } : undefined,
  };
}

/** Expired-token variant — accessTokenExpiring() returns true. */
export function expiredOAuthCredential(): Credential {
  const claims = { exp: Math.floor(Date.now() / 1000) - 100 };
  const b64 = (s: string) => Buffer.from(s).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    kind: 'oauth',
    accessToken: `header.${b64(JSON.stringify(claims))}.sig`,
    refreshToken: 'rfsh-expired',
    expiresAt: Date.now() - 100_000,
  };
}
