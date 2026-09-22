// Runtime validator for credential payloads sent over HTTP. Mirrors the
// `Credential` union from ./store but rejects unknown shapes so a bad request
// can't write garbage into the credential store.
import * as v from 'valibot';
import { KinuError } from '../obs/index';
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
  // Not `v.parse`: its message quotes the value it received, a credential's
  // values are its secret, and a stored one that fails reaches logs as a cause.
  const part = <const TSchema extends v.GenericSchema>(schema: TSchema): v.InferOutput<TSchema> => {
    const parsed = v.safeParse(schema, input.value);

    if (parsed.success) return parsed.output;

    throw new KinuError('bad_input', `not a credential: ${parsed.issues
      .map((issue) => `${v.getDotPath(issue) ?? 'the value'} must be ${issue.expected ?? 'valid'}`)
      .join('; ')}`);
  };

  const kind = part(CredentialKindSchema).kind;

  if (kind === 'bearer') return part(BearerCredentialSchema);

  if (kind === 'oauth') {
    const parsed = part(OAuthCredentialSchema);
    const credential: Credential = { kind: 'oauth', accessToken: parsed.accessToken };

    if (parsed.refreshToken) credential.refreshToken = parsed.refreshToken;

    if (parsed.expiresAt !== undefined) credential.expiresAt = parsed.expiresAt;

    if (parsed.metadata !== undefined) credential.metadata = parsed.metadata;

    return credential;
  }

  const parsed = part(OpenAICompatCredentialSchema);

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
