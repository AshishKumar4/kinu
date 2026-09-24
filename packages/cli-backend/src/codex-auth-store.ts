import {
  CODEX_CRED_KEY,
  JsonObjectSchema,
  JsonValueSchema,
  CODEX_REFRESH_LEAD_SEC,
  MAIN_ACCOUNT,
  codexAccessTokenExpiring,
  codexCredentialToHeaders,
  createCodexOAuthClient,
  type AuthResolution,
  type OAuthCredential,
} from '@kinu.run/core';
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { tolerate } from '@kinu.run/core/obs';
import { withConfigLock, withConfigLockAsync } from './config-lock';
import { writeSecretFile } from './secret-file';

const storedCodexCredentialSchema = v.object({
  accessToken: v.optional(v.string()),
  refreshToken: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  metadata: v.optional(JsonObjectSchema),
});

type StoredCodexCredential = v.InferOutput<typeof storedCodexCredentialSchema>;

const storedCodexSchema = v.object({
  ...storedCodexCredentialSchema.entries,
  accounts: v.optional(v.record(v.string(), storedCodexCredentialSchema)),
});

const kinuConfigSchema = v.objectWithRest({
  providers: v.optional(v.objectWithRest({
    codex: v.optional(storedCodexSchema),
  }, JsonValueSchema)),
}, JsonValueSchema);

type KinuConfigFile = v.InferOutput<typeof kinuConfigSchema>;

export interface LocalCodexAuthStore {
  accounts(): string[];
  hasCredential(account?: string): boolean;
  getAuth(opts?: { forceRefresh?: boolean }, account?: string): Promise<AuthResolution | null>;
  save(credential: OAuthCredential, account?: string): void;
}

export function createFileCodexAuthStore(configPath: string, opts: { fetch?: typeof fetch } = {}): LocalCodexAuthStore {
  return {
    accounts(): string[] {
      const stored = readConfig(configPath).providers?.codex?.accounts ?? {};

      return Object.keys(stored).filter((name) => Boolean(stored[name]?.accessToken)).sort();
    },

    hasCredential(account = MAIN_ACCOUNT): boolean {
      return Boolean(readCredential(configPath, account)?.accessToken);
    },

    async getAuth(authOpts?: { forceRefresh?: boolean }, account = MAIN_ACCOUNT): Promise<AuthResolution | null> {
      const credential = readCredential(configPath, account);

      if (!credential?.accessToken) return null;

      if (!credential.refreshToken || !needsRefresh(credential, authOpts)) {
        return { headers: codexCredentialToHeaders(credential) };
      }

      const refreshed = await refreshUnderLock(configPath, account, credential, opts.fetch);

      return { headers: codexCredentialToHeaders(refreshed) };
    },

    save(credential: OAuthCredential, account = MAIN_ACCOUNT): void {
      withConfigLock(configPath, () => { writeCredential(configPath, account, credential); });
    },
  };
}

/** The network call runs inside the lock: released at the first `await`, a
 *  second caller could submit the same refresh token and race its replacement. */
async function refreshUnderLock(
  configPath: string,
  account: string,
  original: OAuthCredential,
  fetchFn?: typeof fetch,
): Promise<OAuthCredential> {
  return withConfigLockAsync(configPath, async () => {
    const latest = readCredential(configPath, account);

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

    writeCredential(configPath, account, credential);

    return credential;
  });
}

function writeCredential(configPath: string, account: string, credential: OAuthCredential): void {
  const config = readConfig(configPath);
  const codex = config.providers?.codex ?? {};

  const next = account === MAIN_ACCOUNT
    ? { ...codex, ...credentialToConfig(credential) }
    : { ...codex, accounts: { ...codex.accounts, [account]: credentialToConfig(credential) } };

  writeConfig(configPath, { ...config, providers: { ...config.providers, codex: next } });
}

function needsRefresh(credential: OAuthCredential, opts?: { forceRefresh?: boolean }): boolean {
  if (opts?.forceRefresh) return true;

  if (credential.expiresAt && Date.now() + CODEX_REFRESH_LEAD_SEC * 1_000 >= credential.expiresAt) return true;

  return codexAccessTokenExpiring(credential.accessToken);
}

function readCredential(configPath: string, account: string): OAuthCredential | null {
  const stored = readConfig(configPath).providers?.codex;
  const codex = account === MAIN_ACCOUNT ? stored : stored?.accounts?.[account];

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

/** `{}` when absent; a parse failure propagates so `save` cannot wipe other credentials. */
function readConfig(configPath: string): KinuConfigFile {
  const raw = tolerate(() => readFileSync(configPath, 'utf-8'), 'enoent');

  if (raw === undefined) return {};

  return v.parse(kinuConfigSchema, JSON.parse(raw));
}

function writeConfig(configPath: string, config: KinuConfigFile): void {
  writeSecretFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}


export { CODEX_CRED_KEY };
