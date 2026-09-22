// Runtime validator for credential payloads sent over HTTP. Mirrors the
// `Credential` union from ./store but rejects unknown shapes so a bad request
// can't write garbage into the credential store.
import * as v from 'valibot';
import { JsonObjectSchema, JsonValueSchema } from '../utils/json';
import type { Credential } from './store';

const CredentialKindSchema = v.object({
  kind: v.picklist(['bearer', 'oauth', 'openai-compat']),
});

const BearerCredentialSchema = v.object({
  kind: v.literal('bearer'),
  token: v.pipe(v.string(), v.minLength(1)),
});

const OAuthCredentialSchema = v.object({
  kind: v.literal('oauth'),
  accessToken: v.pipe(v.string(), v.minLength(1)),
  refreshToken: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  metadata: v.optional(JsonObjectSchema),
});

const OpenAICompatCredentialSchema = v.object({
  kind: v.literal('openai-compat'),
  baseURL: v.pipe(v.string(), v.minLength(1)),
  apiKey: v.pipe(v.string(), v.minLength(1)),
  extraHeaders: v.optional(v.record(v.string(), JsonValueSchema)),
});

export function validateCredential(input: { value: unknown }): Credential {
  const kind = v.parse(CredentialKindSchema, input.value).kind;

  if (kind === 'bearer') return v.parse(BearerCredentialSchema, input.value);

  if (kind === 'oauth') {
    const parsed = v.parse(OAuthCredentialSchema, input.value);
    const credential: Credential = { kind: 'oauth', accessToken: parsed.accessToken };

    if (parsed.refreshToken) credential.refreshToken = parsed.refreshToken;

    if (parsed.expiresAt !== undefined) credential.expiresAt = parsed.expiresAt;

    if (parsed.metadata !== undefined) credential.metadata = parsed.metadata;

    return credential;
  }

  const parsed = v.parse(OpenAICompatCredentialSchema, input.value);

  const extraHeaders = parsed.extraHeaders === undefined
    ? undefined
    : Object.fromEntries(Object.entries(parsed.extraHeaders).filter((entry): entry is [string, string] =>
      v.is(v.string(), entry[1])));

  return {
    kind: 'openai-compat',
    baseURL: parsed.baseURL,
    apiKey: parsed.apiKey,
    extraHeaders,
  };
}

/** Credential keys must be `[a-zA-Z0-9._-]{1,128}` — alphanumerics, dot,
 *  underscore, dash. No path traversal characters, no slashes. */
export function validateCredentialKey(key: string): void {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(key)) {
    throw new Error('Invalid credential key. Use alphanumerics, dot, underscore and dash only (max 128 chars).');
  }
}
