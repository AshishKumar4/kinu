/**
 * `~/.kinu/config.json`: its one schema and its one locked read-modify-write. The CLI's settings and the subscription
 * logins it holds are read and written through here alone, so a field one writer does not know is never dropped and a
 * field the schema refuses stops every writer alike.
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as v from 'valibot';
import { JsonObjectSchema, ProfileCatalogEnvelopeSchema, type ProfileCatalogEnvelope } from '@kinu.run/core';
import { Effect } from 'effect';
import { KinuError, settleSync, tolerate } from '@kinu.run/core/obs';
import { withConfigLock } from './config-lock';
import { ensureSecretDir, writeSecretFile } from './secret-file';

const StringMapSchema = v.record(v.string(), v.string());

const AgentRefFields = {
  name: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
};

export const KinuAgentConfigSchema = v.variant('mode', [
  v.object({
    ...AgentRefFields, mode: v.literal('local'), localName: v.pipe(v.string(), v.nonEmpty()),
    cwd: v.pipe(v.string(), v.nonEmpty()), workspaceId: v.pipe(v.string(), v.nonEmpty()), identityId: v.pipe(v.string(), v.nonEmpty()),
    cloudName: v.optional(v.never()), displayName: v.optional(v.never()),
  }),
  v.object({
    ...AgentRefFields, mode: v.literal('cloud'), cloudName: v.pipe(v.string(), v.nonEmpty()), displayName: v.string(),
    localName: v.optional(v.never()), cwd: v.optional(v.never()), workspaceId: v.optional(v.never()), identityId: v.optional(v.never()),
  }),
]);

export type KinuAgentConfig = v.InferOutput<typeof KinuAgentConfigSchema>;

const McpServerConfigSchema = v.object({
  command: v.string(),
  args: v.optional(v.array(v.string())),
  env: v.optional(StringMapSchema),
  timeoutMs: v.optional(v.number()),
});

export const OpenAiCompatConfigSchema = v.strictObject({
  baseURL: v.string(),
  apiKey: v.optional(v.string()),
  extraHeaders: v.optional(StringMapSchema),
  contextWindow: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

const LocalApiKeyProviderSchema = v.object({
  apiKey: v.optional(v.string()),
  accounts: v.optional(v.record(v.string(), v.object({ apiKey: v.string() }))),
});

export type LocalApiKeyProvider = v.InferOutput<typeof LocalApiKeyProviderSchema>;

/** A subscription login as it is kept: its tokens, and what its issuer registered. */
const LocalOAuthSessionSchema = v.object({
  accessToken: v.optional(v.string()),
  refreshToken: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  metadata: v.optional(JsonObjectSchema),
});

export type LocalOAuthSession = v.InferOutput<typeof LocalOAuthSessionSchema>;

/** An issuer's main login and its named accounts. */
const LocalOAuthIssuerSchema = v.object({
  ...LocalOAuthSessionSchema.entries,
  accounts: v.optional(v.record(v.string(), LocalOAuthSessionSchema)),
});

const KinuConfigSchema = v.object({
  origin: v.optional(v.string()),
  accessToken: v.optional(v.string()),
  tokenExpiresAt: v.optional(v.string()),
  user: v.optional(v.object({
    id: v.string(),
    email: v.string(),
    displayName: v.optional(v.nullable(v.string())),
  })),
  agents: v.optional(v.record(v.string(), KinuAgentConfigSchema)),
  updateCheck: v.optional(v.boolean()),
  updateCheckedAt: v.optional(v.number()),
  updateLatestSeen: v.optional(v.string()),
  providers: v.optional(v.object({
    openai: v.optional(LocalApiKeyProviderSchema),
    anthropic: v.optional(LocalApiKeyProviderSchema),
    openrouter: v.optional(LocalApiKeyProviderSchema),
    chatgpt: v.optional(LocalOAuthIssuerSchema),
    claude: v.optional(LocalOAuthIssuerSchema),
    openaiCompat: v.optional(v.record(v.string(), OpenAiCompatConfigSchema)),
  })),
  mcpServers: v.optional(v.record(v.string(), McpServerConfigSchema)),
  deviceConnectPromptDismissed: v.optional(v.boolean()),
  /** Shadow-git checkpoints kept per working directory (default 50). */
  checkpointKeep: v.optional(v.number()),
  /**
   * Bumped on every provider change so resident sessions in other processes know to re-sweep their cached listing.
   * Only inequality is read; absent reads as 0.
   */
  providerRevision: v.optional(v.number()),
  /** Failed server-side logout. The raw token is the only copy (the server stores a hash); kept until a retry confirms revocation. */
  pendingRevocation: v.optional(v.object({
    token: v.string(),
    origin: v.string(),
    at: v.number(),
  })),
  /** Signed-out profile authority; never holds account data. */
  localProfile: v.optional(ProfileCatalogEnvelopeSchema),
});

/** `localProfile` keeps core's readonly envelope type; the schema's output is its mutable twin. */
export type KinuConfig = Omit<v.InferOutput<typeof KinuConfigSchema>, 'localProfile'> & { localProfile?: ProfileCatalogEnvelope };

/** The config at `path`; `{}` where none was ever written. One that cannot be read or does not parse is a failure, so
 *  no writer replaces what another wrote. */
export function readConfigFile(path: string): KinuConfig {
  const raw = tolerate(() => readFileSync(path, 'utf-8'), 'enoent');

  if (raw === undefined) return {};

  return settleSync(Effect.try({
    try: () => v.parse(KinuConfigSchema, JSON.parse(raw)),
    catch: (cause) => new KinuError('io', `${path} is malformed. Remove it and reconnect with kinu setup.`, { cause }),
  }));
}

/**
 * The one writer: under the config lock, reads the file, lets `mutate` change it in place, writes it back, and answers
 * what `mutate` answered. A `mutate` that throws writes nothing.
 */
export function updateConfigFile<T>(path: string, mutate: (config: KinuConfig) => T | Promise<T>): Promise<T> {
  return withConfigLock(path, async () => {
    const config = readConfigFile(path);
    const result = await mutate(config);

    ensureSecretDir(dirname(path));
    writeSecretFile(path, `${JSON.stringify(config, null, 2)}\n`);

    return result;
  });
}
