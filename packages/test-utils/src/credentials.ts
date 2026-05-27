// Credential fixtures — auth-resolver shims for tests.
//
// The new provider seam exposes `getAuth(key)` returning ready-to-attach
// HTTP headers rather than raw Credential values. UserDO is the production
// implementation; this file gives tests the equivalent shape without
// spinning up a DO.
import type { AuthResolution, AuthResolver } from '@proteus/core';

export interface TestAuth {
  getAuth: AuthResolver;
  hasCredential: (key: string) => Promise<boolean>;
  set: (key: string, value: AuthResolution) => void;
  remove: (key: string) => void;
}

/** Build a test auth resolver pre-loaded with the given header bundles. */
export function createTestAuth(entries: Record<string, AuthResolution> = {}): TestAuth {
  const store = new Map<string, AuthResolution>(Object.entries(entries));
  return {
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
    set(key, value) { store.set(key, value); },
    remove(key) { store.delete(key); },
  };
}

/** Codex headers for a fresh OAuth credential — `exp` far in the future. */
export function codexAuthHeaders(opts: { accountId?: string; accessToken?: string } = {}): AuthResolution {
  const claims: Record<string, unknown> = { exp: Math.floor(Date.now() / 1000) + 3600 };
  if (opts.accountId) {
    claims['https://api.openai.com/auth'] = { chatgpt_account_id: opts.accountId };
  }
  const b64 = (s: string) => Buffer.from(s).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = opts.accessToken ?? `header.${b64(JSON.stringify(claims))}.sig`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'codex_cli_rs/0.0.0 (Proteus Agent)',
    originator: 'codex_cli_rs',
  };
  if (opts.accountId) headers['ChatGPT-Account-ID'] = opts.accountId;
  return { headers };
}

/** Bearer-token-flavored auth resolution. */
export function bearerAuth(token: string, extra: Record<string, string> = {}): AuthResolution {
  return { headers: { Authorization: `Bearer ${token}`, ...extra } };
}

/** Anthropic-flavored (x-api-key) auth resolution. */
export function anthropicAuth(key: string): AuthResolution {
  return { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
}
