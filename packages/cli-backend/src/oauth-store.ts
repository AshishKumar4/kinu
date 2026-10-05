// Subscription logins on this machine, one `config.json` provider section per issuer with named accounts.
// Claude renews through core's issuer table, as a hosted account's login does; the ChatGPT plan's login
// exists only on a machine, so its issuer lives beside the daemon's (`chatgpt-login.ts`).
import {
  CHATGPT_CRED_KEY,
  CLAUDE_CRED_KEY,
  CLAUDE_LOGIN_ISSUER,
  JsonObjectSchema,
  JsonValueSchema,
  MAIN_ACCOUNT,
  accountCredentialKey,
  accountOf,
  baseCredentialKey,
  credentialToHeaders,
  refusedLogin,
  rotateLogin,
  usableLogin,
  type LoginRenewal,
  type AuthRequest,
  type AuthResolution,
  type JsonObject,
  type OAuthCredential,
  type SubscriptionIssuer,
} from '@kinu.run/core';
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { tolerate } from '@kinu.run/core/obs';
import { registrationOf, revokeSession } from '../../pc-agent/src/chatgpt.js';
import { chatgptLoginIssuer } from './chatgpt-login';
import { withConfigLock } from './config-lock';
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
    chatgpt: v.optional(storedIssuerSchema),
    claude: v.optional(storedIssuerSchema),
  }, JsonValueSchema)),
}, JsonValueSchema);

type KinuConfigFile = v.InferOutput<typeof kinuConfigSchema>;

interface OAuthIssuer {
  readonly section: 'chatgpt' | 'claude';
  headers(credential: OAuthCredential): Record<string, string>;
  readonly renewal: SubscriptionIssuer;
  /** What a login keeps once its tokens are spent: SIWC's sign-out keeps only the registration. Without it the
   *  login stays as it was, for a new sign-in to replace. */
  readonly signedOut?: (metadata: JsonObject | undefined) => JsonObject | null;
}

/** The account and client mapping a ChatGPT login keeps signed out; null when it holds no issued client. */
function chatgptRegistration(metadata: JsonObject | undefined): JsonObject | null {
  const registration = registrationOf(metadata);

  if (registration === null) return null;
  const { clientId, subject, email } = registration;

  return { clientId, ...(subject !== undefined && { subject }), ...(email !== undefined && { email }) };
}

const ISSUERS = new Map<string, OAuthIssuer>([
  [CHATGPT_CRED_KEY, {
    section: 'chatgpt', headers: (credential) => ({ Authorization: `Bearer ${credential.accessToken}` }), renewal: chatgptLoginIssuer(), signedOut: chatgptRegistration,
  }],
  [CLAUDE_CRED_KEY, { section: 'claude', headers: (credential) => credentialToHeaders(CLAUDE_CRED_KEY, credential), renewal: CLAUDE_LOGIN_ISSUER }],
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
  getAuth(key: string, opts?: AuthRequest): Promise<AuthResolution | null>;
  save(key: string, credential: OAuthCredential): Promise<void>;
}

/** A login a call can use: one without a refresh token is no login, as a hosted account refuses to store one. */
function renewable(login: { readonly accessToken?: string; readonly refreshToken?: string } | null | undefined): boolean {
  return Boolean(login?.accessToken && login.refreshToken);
}

export function createFileOAuthStore(configPath: string, opts: { fetch?: typeof fetch } = {}): LocalOAuthStore {
  return {
    keys(): string[] {
      const providers = readConfig(configPath).providers;

      return [...ISSUERS].flatMap(([base, issuer]) => {
        const stored = providers?.[issuer.section];
        const named = Object.keys(stored?.accounts ?? {}).filter((name) => renewable(stored?.accounts?.[name])).sort();

        return [...(renewable(stored) ? [MAIN_ACCOUNT] : []), ...named].map((account) => accountCredentialKey(base, account));
      });
    },

    has(key: string): boolean {
      return renewable(readCredential(configPath, key));
    },

    async getAuth(key: string, authOpts?: AuthRequest): Promise<AuthResolution | null> {
      const issuer = issuerOf(key);
      const credential = readCredential(configPath, key);

      if (!credential?.accessToken) return null;
      const rejected = authOpts?.rejected;
      const refused = rejected !== undefined && refusedLogin(issuer.headers(credential), rejected);

      const usable = await usableLogin({
        issuer: issuer.renewal, credential, refused, renew: () => renewUnderLock(configPath, key, credential, opts.fetch),
      });

      return usable === null ? null : { headers: issuer.headers(usable), credentialKey: key };
    },

    async save(key: string, credential: OAuthCredential): Promise<void> {
      await withConfigLock(configPath, () => { writeLogin(configPath, key, credentialToConfig(credential)); });
    },
  };
}

/** The network call runs inside the lock: released at the first `await`, a
 *  second caller could submit the same refresh token and race its replacement.
 *  Only the login on disk renews, so a sign-out the wait let in is not undone. */
function renewUnderLock(
  configPath: string,
  key: string,
  original: OAuthCredential,
  fetchFn?: typeof fetch,
): Promise<LoginRenewal> {
  const issuer = issuerOf(key);

  return withConfigLock(configPath, async (): Promise<LoginRenewal> => {
    const latest = readCredential(configPath, key);

    if (latest?.refreshToken === undefined) return 'revoked';

    if (latest.accessToken !== original.accessToken && !issuer.renewal.expiring(latest)) return latest;
    const renewal = await rotateLogin(key, `refreshing the ${issuer.section} login`, () => issuer.renewal.refresh(latest, fetchFn));

    // A spent refresh token is retired, so no later call submits it again and the login reads as signed out.
    if (renewal === 'revoked') writeLogin(configPath, key, signedOutLogin(issuer, latest.metadata));
    else if (!('failed' in renewal)) writeLogin(configPath, key, credentialToConfig(renewal));

    return renewal;
  });
}

/** A signed-out login: the issuer's retained registration, or nothing where it keeps none. */
function signedOutLogin(issuer: OAuthIssuer, metadata: JsonObject | undefined): StoredLogin | null {
  const retained = issuer.signedOut?.(metadata) ?? null;

  return retained === null ? null : { metadata: retained };
}

/** What a sign-out did: `removed` a signed-in login; `unconfirmed` is null when OpenAI confirmed the
 *  revocation, a reason when it did not, and undefined when there was no refresh token to revoke. */
export interface ChatGptSignOut {
  readonly removed: boolean;
  readonly unconfirmed?: string | null;
}

/**
 * Signs a ChatGPT login out under the lock its refresh takes: the refresh token revoked is the one on disk,
 * after any rotation in flight, and no refresh queued behind it renews the login again. The tokens go
 * whatever OpenAI answers; the registration stays, so the next sign-in reuses the issued client.
 */
export function signOutChatGptLogin(configPath: string, account: string, opts: { fetch?: typeof fetch } = {}): Promise<ChatGptSignOut> {
  const key = accountCredentialKey(CHATGPT_CRED_KEY, account);
  const issuer = issuerOf(key);

  return withConfigLock(configPath, async (): Promise<ChatGptSignOut> => {
    const login = readLogin(configPath, key);

    if (login === undefined) return { removed: false };
    const registration = registrationOf(login.metadata);

    const revocation = login.refreshToken === undefined || registration === null
      ? undefined
      : await revokeSession({ clientId: registration.clientId, refreshToken: login.refreshToken, ...(opts.fetch !== undefined && { fetch: opts.fetch }) });

    writeLogin(configPath, key, signedOutLogin(issuer, login.metadata));

    return { removed: login.accessToken !== undefined || login.refreshToken !== undefined, ...(revocation !== undefined && { unconfirmed: revocation.unconfirmed }) };
  });
}

/** Replaces one login, or removes it (null); the section's other logins and keys stay as they were. */
function writeLogin(configPath: string, key: string, login: StoredLogin | null): void {
  const { section } = issuerOf(key);
  const account = accountOf(key);
  const config = readConfig(configPath);
  const stored = config.providers?.[section] ?? {};
  const { accessToken: _access, refreshToken: _refresh, expiresAt: _expires, metadata: _metadata, accounts, ...rest } = stored;

  const next = account === MAIN_ACCOUNT
    ? { ...rest, ...login, ...(accounts !== undefined && { accounts }) }
    : { ...stored, accounts: login === null
      ? Object.fromEntries(Object.entries(accounts ?? {}).filter(([name]) => name !== account))
      : { ...accounts, [account]: login } };

  const { [section]: _replaced, ...providers } = config.providers ?? {};

  writeConfig(configPath, { ...config, providers: Object.keys(next).length === 0 ? providers : { ...providers, [section]: next } });
}

function readLogin(configPath: string, key: string): StoredLogin | undefined {
  const account = accountOf(key);
  const stored = readConfig(configPath).providers?.[issuerOf(key).section];

  return account === MAIN_ACCOUNT ? stored : stored?.accounts?.[account];
}

function readCredential(configPath: string, key: string): OAuthCredential | null {
  const login = readLogin(configPath, key);

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
