// Subscription logins on this machine, one `config.json` provider section per issuer with named accounts.
// Every issuer refreshes through the one path below.
import {
  CLAUDE_CRED_KEY,
  CLAUDE_REFRESH_LEAD_MS,
  CODEX_CRED_KEY,
  CODEX_REFRESH_LEAD_SEC,
  JsonObjectSchema,
  JsonValueSchema,
  MAIN_ACCOUNT,
  accountCredentialKey,
  accountOf,
  baseCredentialKey,
  codexAccessTokenExpiring,
  codexCredentialToHeaders,
  createClaudeOAuthClient,
  createCodexOAuthClient,
  credentialToHeaders,
  type AuthResolution,
  type OAuthCredential,
} from '@kinu.run/core';
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { tolerate } from '@kinu.run/core/obs';
import { withConfigLock, withConfigLockAsync } from './config-lock';
import { writeSecretFile } from './secret-file';

const storedLoginSchema = v.object({
  accessToken: v.optional(v.string()),
  refreshToken: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  metadata: v.optional(JsonObjectSchema),
});

type StoredLogin = v.InferOutput<typeof storedLoginSchema>;

const storedIssuerSchema = v.object({
  ...storedLoginSchema.entries,
  accounts: v.optional(v.record(v.string(), storedLoginSchema)),
});

const kinuConfigSchema = v.objectWithRest({
  providers: v.optional(v.objectWithRest({
    codex: v.optional(storedIssuerSchema),
    claude: v.optional(storedIssuerSchema),
  }, JsonValueSchema)),
}, JsonValueSchema);

type KinuConfigFile = v.InferOutput<typeof kinuConfigSchema>;

interface OAuthIssuer {
  readonly section: 'codex' | 'claude';
  headers(credential: OAuthCredential): Record<string, string>;
  expiring(credential: OAuthCredential): boolean;
  refresh(credential: OAuthCredential, fetchFn: typeof fetch | undefined): Promise<OAuthCredential>;
}

const ISSUERS = new Map<string, OAuthIssuer>([
  [CODEX_CRED_KEY, {
    section: 'codex',
    headers: codexCredentialToHeaders,
    expiring: (credential) => (credential.expiresAt !== undefined && Date.now() + CODEX_REFRESH_LEAD_SEC * 1_000 >= credential.expiresAt)
      || codexAccessTokenExpiring(credential.accessToken),
    async refresh(credential, fetchFn) {
      const fresh = await createCodexOAuthClient(fetchFn).refresh(credential.refreshToken ?? '');

      return { kind: 'oauth', accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt, metadata: credential.metadata };
    },
  }],
  [CLAUDE_CRED_KEY, {
    section: 'claude',
    headers: (credential) => credentialToHeaders(CLAUDE_CRED_KEY, credential),
    expiring: (credential) => credential.expiresAt !== undefined && Date.now() + CLAUDE_REFRESH_LEAD_MS >= credential.expiresAt,
    refresh: (credential, fetchFn) => createClaudeOAuthClient(fetchFn).refresh(credential),
  }],
]);

/** Whether a key names a subscription login this store holds, any account. */
export function isOAuthLoginKey(key: string): boolean {
  return ISSUERS.has(baseCredentialKey(key));
}

function issuerOf(key: string): OAuthIssuer {
  const issuer = ISSUERS.get(baseCredentialKey(key));

  if (issuer === undefined) throw new Error(`${key} is not a subscription login`);

  return issuer;
}

export interface LocalOAuthStore {
  /** Every stored login's key, `@account` included. */
  keys(): string[];
  has(key: string): boolean;
  getAuth(key: string, opts?: { forceRefresh?: boolean }): Promise<AuthResolution | null>;
  save(key: string, credential: OAuthCredential): void;
}

export function createFileOAuthStore(configPath: string, opts: { fetch?: typeof fetch } = {}): LocalOAuthStore {
  return {
    keys(): string[] {
      const providers = readConfig(configPath).providers;

      return [...ISSUERS].flatMap(([base, issuer]) => {
        const stored = providers?.[issuer.section];
        const named = Object.keys(stored?.accounts ?? {}).filter((name) => Boolean(stored?.accounts?.[name]?.accessToken)).sort();

        return [...(stored?.accessToken ? [MAIN_ACCOUNT] : []), ...named].map((account) => accountCredentialKey(base, account));
      });
    },

    has(key: string): boolean {
      return Boolean(readCredential(configPath, key)?.accessToken);
    },

    async getAuth(key: string, authOpts?: { forceRefresh?: boolean }): Promise<AuthResolution | null> {
      const issuer = issuerOf(key);
      const credential = readCredential(configPath, key);

      if (!credential?.accessToken) return null;

      if (!credential.refreshToken || !(authOpts?.forceRefresh === true || issuer.expiring(credential))) {
        return { headers: issuer.headers(credential), credentialKey: key };
      }

      const refreshed = await refreshUnderLock(configPath, key, credential, opts.fetch);

      return { headers: issuer.headers(refreshed), credentialKey: key };
    },

    save(key: string, credential: OAuthCredential): void {
      withConfigLock(configPath, () => { writeCredential(configPath, key, credential); });
    },
  };
}

/** The network call runs inside the lock: released at the first `await`, a
 *  second caller could submit the same refresh token and race its replacement. */
async function refreshUnderLock(
  configPath: string,
  key: string,
  original: OAuthCredential,
  fetchFn?: typeof fetch,
): Promise<OAuthCredential> {
  const issuer = issuerOf(key);

  return withConfigLockAsync(configPath, async () => {
    const latest = readCredential(configPath, key);

    if (latest?.accessToken && latest.accessToken !== original.accessToken && !issuer.expiring(latest)) {
      return latest;
    }

    const current = latest ?? original;
    const refreshed = await issuer.refresh({ ...current, refreshToken: current.refreshToken ?? original.refreshToken }, fetchFn);

    writeCredential(configPath, key, refreshed);

    return refreshed;
  });
}

function writeCredential(configPath: string, key: string, credential: OAuthCredential): void {
  const { section } = issuerOf(key);
  const account = accountOf(key);
  const config = readConfig(configPath);
  const stored = config.providers?.[section] ?? {};

  const next = account === MAIN_ACCOUNT
    ? { ...stored, ...credentialToConfig(credential) }
    : { ...stored, accounts: { ...stored.accounts, [account]: credentialToConfig(credential) } };

  writeConfig(configPath, { ...config, providers: { ...config.providers, [section]: next } });
}

function readCredential(configPath: string, key: string): OAuthCredential | null {
  const account = accountOf(key);
  const stored = readConfig(configPath).providers?.[issuerOf(key).section];
  const login = account === MAIN_ACCOUNT ? stored : stored?.accounts?.[account];

  if (!login?.accessToken) return null;

  return {
    kind: 'oauth',
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    expiresAt: login.expiresAt,
    metadata: login.metadata,
  };
}

function credentialToConfig(credential: OAuthCredential): StoredLogin {
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
