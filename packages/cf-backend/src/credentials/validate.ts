// Runtime validator for credential payloads sent over HTTP. Mirrors the
// `Credential` union from @proteus/core but rejects unknown shapes outright
// so a bad request can't write garbage into the store.
import type { Credential } from '@proteus/core';

export function validateCredential(input: unknown): Credential {
  if (!input || typeof input !== 'object') throw new Error('credential must be an object');
  const obj = input as Record<string, unknown>;
  const kind = obj.kind;

  if (kind === 'bearer') {
    if (typeof obj.token !== 'string' || !obj.token) throw new Error('bearer.token (string) required');
    return { kind: 'bearer', token: obj.token };
  }

  if (kind === 'oauth') {
    if (typeof obj.accessToken !== 'string' || !obj.accessToken) throw new Error('oauth.accessToken (string) required');
    if (typeof obj.refreshToken !== 'string' || !obj.refreshToken) throw new Error('oauth.refreshToken (string) required');
    return {
      kind: 'oauth',
      accessToken: obj.accessToken,
      refreshToken: obj.refreshToken,
      expiresAt: typeof obj.expiresAt === 'number' ? obj.expiresAt : undefined,
      metadata: typeof obj.metadata === 'object' && obj.metadata !== null
        ? obj.metadata as Record<string, unknown>
        : undefined,
    };
  }

  if (kind === 'openai-compat') {
    if (typeof obj.baseURL !== 'string' || !obj.baseURL) throw new Error('openai-compat.baseURL required');
    if (typeof obj.apiKey !== 'string' || !obj.apiKey) throw new Error('openai-compat.apiKey required');
    const extraHeaders: Record<string, string> | undefined =
      obj.extraHeaders && typeof obj.extraHeaders === 'object'
        ? Object.fromEntries(
            Object.entries(obj.extraHeaders as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string'),
          ) as Record<string, string>
        : undefined;
    return { kind: 'openai-compat', baseURL: obj.baseURL, apiKey: obj.apiKey, extraHeaders };
  }

  throw new Error(`unknown credential kind: ${String(kind)}`);
}
