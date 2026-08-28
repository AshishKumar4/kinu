// Runtime validator for credential payloads sent over HTTP. Mirrors the
// `Credential` union from @kinu.run/core but rejects unknown shapes so a bad
// request can't write garbage into UserDO storage.
import {
  JsonObjectSchema,
  JsonValueSchema,
  type Credential,
} from '@kinu.run/core';
import * as v from 'valibot';

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

export function validateCredential<Input>(input: Input): Credential {
  const kind = v.parse(CredentialKindSchema, input).kind;
  if (kind === 'bearer') return v.parse(BearerCredentialSchema, input);
  if (kind === 'oauth') {
    const parsed = v.parse(OAuthCredentialSchema, input);
    const credential: Credential = { kind: 'oauth', accessToken: parsed.accessToken };
    if (parsed.refreshToken) credential.refreshToken = parsed.refreshToken;
    if (parsed.expiresAt !== undefined) credential.expiresAt = parsed.expiresAt;
    if (parsed.metadata !== undefined) credential.metadata = parsed.metadata;
    return credential;
  }

  const parsed = v.parse(OpenAICompatCredentialSchema, input);
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

/** The one workspace-name grammar. Named so the throwing gate and the
 *  predicate below cannot drift into two different ideas of a valid name. */
const WORKSPACE_NAME = /^[a-zA-Z0-9._-]{1,64}$/;

/** Whether a name COULD be a workspace's. For a caller that is asking a
 *  question rather than admitting a value — feedback attribution asks the
 *  registry only about names the registry could hold, so a malformed one is
 *  refused here instead of arriving as a thrown error from a Durable Object
 *  that no caller can tell apart from an outage. */
export function isWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME.test(name);
}

/** Agent names follow the same rule. The DO id system already restricts to
 *  printable ascii; this is just an extra-strict guard at our API boundary. */
export function validateWorkspaceName(name: string): void {
  if (!isWorkspaceName(name)) {
    throw new Error('Invalid workspace name. Use alphanumerics, dot, underscore and dash only (max 64 chars).');
  }
}
