import {
  CODEX_CRED_KEY,
  JsonObjectSchema,
  JsonValueSchema,
  CODEX_REFRESH_LEAD_SEC,
  codexAccessTokenExpiring,
  codexCredentialToHeaders,
  createCodexOAuthClient,
  type AuthResolution,
  type OAuthCredential,
} from '@kinu.run/core';
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { tolerate } from '@kinu.run/core/obs';
import { withConfigLock } from './config-lock';
import { writeSecretFile } from './secret-file';

const storedCodexCredentialSchema = v.object({
  accessToken: v.optional(v.string()),
  refreshToken: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  metadata: v.optional(JsonObjectSchema),
});
type StoredCodexCredential = v.InferOutput<typeof storedCodexCredentialSchema>;
const kinuConfigSchema = v.objectWithRest({
  providers: v.optional(v.objectWithRest({
    codex: v.optional(storedCodexCredentialSchema),
  }, JsonValueSchema)),
}, JsonValueSchema);
type KinuConfigFile = v.InferOutput<typeof kinuConfigSchema>;

export interface LocalCodexAuthStore {
  hasCredential(): boolean;
  getAuth(opts?: { forceRefresh?: boolean }): Promise<AuthResolution | null>;
  save(credential: OAuthCredential): void;
}

export function createFileCodexAuthStore(configPath: string, opts: { fetch?: typeof fetch } = {}): LocalCodexAuthStore {
  return {
    hasCredential(): boolean {
      return Boolean(readCredential(configPath)?.accessToken);
    },

    async getAuth(authOpts?: { forceRefresh?: boolean }): Promise<AuthResolution | null> {
      const credential = readCredential(configPath);
      if (!credential?.accessToken) return null;
      if (!credential.refreshToken || !needsRefresh(credential, authOpts)) {
        return { headers: codexCredentialToHeaders(credential) };
      }

      const refreshed = await refreshUnderLock(configPath, credential, opts.fetch);
      return { headers: codexCredentialToHeaders(refreshed) };
    },

    save(credential: OAuthCredential): void {
      withConfigLock(configPath, () => {
        const config = readConfig(configPath);
        writeConfig(configPath, {
          ...config,
          providers: {
            ...config.providers,
            codex: credentialToConfig(credential),
          },
        });
      });
    },
  };
}

async function refreshUnderLock(
  configPath: string,
  original: OAuthCredential,
  fetchFn?: typeof fetch,
): Promise<OAuthCredential> {
  return withConfigLock(configPath, async () => {
    const latest = readCredential(configPath);
    if (latest?.accessToken && latest.accessToken !== original.accessToken && !needsRefresh(latest)) {
      return latest;
    }
    const refreshToken = latest?.refreshToken ?? original.refreshToken;
    if (!refreshToken) throw new Error('Codex session expired. Run: kinu setup');
    const refreshed = await createCodexOAuthClient(fetchFn).refresh(refreshToken);
    const credential: OAuthCredential = {
      kind: 'oauth',
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      metadata: latest?.metadata ?? original.metadata,
    };
    const config = readConfig(configPath);
    writeConfig(configPath, {
      ...config,
      providers: {
        ...config.providers,
        codex: credentialToConfig(credential),
      },
    });
    return credential;
  });
}

function needsRefresh(credential: OAuthCredential, opts?: { forceRefresh?: boolean }): boolean {
  if (opts?.forceRefresh) return true;
  // One lead, two places it can be read from: the stored `expiresAt` and the JWT's
  // own `exp`. These were 5*60_000 and 300 — the same window written twice in
  // different units, which is how they come to disagree.
  if (credential.expiresAt && Date.now() + CODEX_REFRESH_LEAD_SEC * 1_000 >= credential.expiresAt) return true;
  return codexAccessTokenExpiring(credential.accessToken);
}

function readCredential(configPath: string): OAuthCredential | null {
  const codex = readConfig(configPath).providers?.codex;
  if (!codex?.accessToken) return null;
  return {
    kind: 'oauth',
    accessToken: codex.accessToken,
    refreshToken: codex.refreshToken ?? '',
    expiresAt: codex.expiresAt,
    metadata: codex.metadata,
  };
}

function credentialToConfig(credential: OAuthCredential): StoredCodexCredential {
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAt,
    metadata: credential.metadata,
  };
}

/**
 * The config file, or `{}` when it has not been written yet. A file that exists
 * but does not parse propagates: reading it as empty would make `save` overwrite
 * every provider credential in it with only the one being saved.
 */
function readConfig(configPath: string): KinuConfigFile {
  const raw = tolerate(() => readFileSync(configPath, 'utf-8'), 'enoent');
  if (raw === undefined) return {};
  return v.parse(kinuConfigSchema, JSON.parse(raw));
}

function writeConfig(configPath: string, config: KinuConfigFile): void {
  writeSecretFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}


export { CODEX_CRED_KEY };
