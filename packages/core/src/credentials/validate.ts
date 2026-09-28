// Rejects unknown shapes so a bad request can't write garbage into the credential store.
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError, settleSync } from '../obs/index';
import { JsonObjectSchema, JsonValueSchema } from '../utils/json';
import { accountKey, MAIN_ACCOUNT, splitAccount } from './accounts';
import type { Credential } from './store';

const CredentialKindSchema = v.object({
  kind: v.picklist(['bearer', 'oauth', 'openai-compat']),
});

const BearerCredentialSchema = v.object({
  kind: v.literal('bearer'),
  token: v.pipe(v.string(), v.minLength(1)),
  baseURL: v.optional(v.pipe(v.string(), v.url())),
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
  return settleSync(credentialOf(input));
}

/** Not `v.parse`: its message quotes the received value, which is the secret. */
function part<const TSchema extends v.GenericSchema>(schema: TSchema, input: { value: unknown }): Effect.Effect<v.InferOutput<TSchema>, KinuError> {
  const parsed = v.safeParse(schema, input.value);

  if (parsed.success) return Effect.succeed(parsed.output);

  return Effect.fail(new KinuError('bad_input', `not a credential: ${parsed.issues
    .map((issue) => `${v.getDotPath(issue) ?? 'the value'} must be ${issue.expected ?? 'valid'}`)
    .join('; ')}`));
}

function credentialOf(input: { value: unknown }): Effect.Effect<Credential, KinuError> {
  return Effect.gen(function* () {
    const kind = (yield* part(CredentialKindSchema, input)).kind;

    if (kind === 'bearer') {
      const parsed = yield* part(BearerCredentialSchema, input);

      return parsed.baseURL === undefined ? { kind: 'bearer', token: parsed.token } : parsed;
    }

    if (kind === 'oauth') {
      const parsed = yield* part(OAuthCredentialSchema, input);
      const credential: Credential = { kind: 'oauth', accessToken: parsed.accessToken };

      if (parsed.refreshToken) credential.refreshToken = parsed.refreshToken;

      if (parsed.expiresAt !== undefined) credential.expiresAt = parsed.expiresAt;

      if (parsed.metadata !== undefined) credential.metadata = parsed.metadata;

      return credential;
    }

    const parsed = yield* part(OpenAICompatCredentialSchema, input);

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
  });
}

export function validateCredentialKey(key: string): void {
  return settleSync(validKey(key));
}

function validKey(key: string): Effect.Effect<void, KinuError> {
  const { base, account } = splitAccount(key);

  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(base)) {
    return Effect.fail(new KinuError('bad_input', 'Invalid credential key. Use alphanumerics, dot, underscore and dash only (max 128 chars).'));
  }

  if (account === null) return Effect.void;

  return Effect.flatMap(accountKey(base, account), (named) => (
    named === key
      ? Effect.void
      : Effect.fail(new KinuError('bad_input', `Invalid credential key: the account named ${MAIN_ACCOUNT} is the bare key ${base}.`))
  ));
}
