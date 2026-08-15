import {
  CODEX_CRED_KEY,
  JsonObjectSchema,
  JsonValueSchema,
  codexAccessTokenExpiring,
  codexCredentialToHeaders,
  createCodexOAuthClient,
  type AuthResolution,
  type OAuthCredential,
} from '@proteus/core';
import * as v from 'valibot';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const storedCodexCredentialSchema = v.object({
  accessToken: v.optional(v.string()),
  refreshToken: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  metadata: v.optional(JsonObjectSchema),
});
type StoredCodexCredential = v.InferOutput<typeof storedCodexCredentialSchema>;
const proteusConfigSchema = v.objectWithRest({
  providers: v.optional(v.objectWithRest({
    codex: v.optional(storedCodexCredentialSchema),
  }, JsonValueSchema)),
}, JsonValueSchema);
type ProteusConfigFile = v.InferOutput<typeof proteusConfigSchema>;

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
      withLock(configPath, () => {
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
  return withLock(configPath, async () => {
    const latest = readCredential(configPath);
    if (latest?.accessToken && latest.accessToken !== original.accessToken && !needsRefresh(latest)) {
      return latest;
    }
    const refreshToken = latest?.refreshToken ?? original.refreshToken;
    if (!refreshToken) throw new Error('Codex session expired. Run: proteus setup');
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
  if (credential.expiresAt && Date.now() + 5 * 60_000 >= credential.expiresAt) return true;
  return codexAccessTokenExpiring(credential.accessToken, 300);
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

function readConfig(configPath: string): ProteusConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    return v.parse(proteusConfigSchema, JSON.parse(readFileSync(configPath, 'utf-8')));
  } catch {
    return {};
  }
}

function writeConfig(configPath: string, config: ProteusConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, configPath);
  try { chmodSync(configPath, 0o600); } catch {}
}

function withLock<T>(configPath: string, fn: () => T): T {
  mkdirSync(dirname(configPath), { recursive: true });
  const lockPath = `${configPath}.lock`;
  const fd = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

function acquireLock(lockPath: string): number {
  const started = Date.now();
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      return fd;
    } catch (err) {
      if (!isAlreadyExists({ error: err })) throw err;
      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > 30_000) unlinkSync(lockPath);
      } catch {}
      if (Date.now() - started > 30_000) {
        throw new Error(`Timed out waiting for Codex auth lock: ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function isAlreadyExists(input: { error: unknown }): boolean {
  return v.safeParse(v.object({ code: v.literal('EEXIST') }), input.error).success;
}

export { CODEX_CRED_KEY };
