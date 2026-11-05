// Subscription logins on this machine, one `config.json` provider section per issuer with named accounts.
// Claude and the ChatGPT plan renew through core's issuers, as a hosted account's logins do.
import {
  CHATGPT_CRED_KEY,
  chatgptLoginIssuer,
  CLAUDE_CRED_KEY,
  CLAUDE_LOGIN_ISSUER,
  MAIN_ACCOUNT,
  accountCredentialKey,
  accountOf,
  baseCredentialKey,
  credentialToHeaders,
  refusedLogin,
  rotateLogin,
  heldLogin,
  usableLogin,
  type LoginRenewal,
  type AuthRequest,
  type AuthResolution,
  type JsonObject,
  type OAuthCredential,
  type SubscriptionIssuer,
} from '@kinu.run/core';
import { registrationOf, revokeSession } from '../../pc-agent/src/chatgpt.js';
import { readConfigFile, updateConfigFile, type KinuConfig, type LocalOAuthSession } from './config-file';
import { KinuError, settle, settleSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';

type StoredLogin = LocalOAuthSession;

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

function issuerOf(key: string): Effect.Effect<OAuthIssuer, KinuError> {
  const issuer = ISSUERS.get(baseCredentialKey(key));

  return issuer === undefined ? Effect.fail(new KinuError('bad_input', `${key} is not a subscription login`)) : Effect.succeed(issuer);
}

export interface LocalOAuthStore {
  /** Every stored login's key, `@account` included. */
  keys(): string[];
  has(key: string): boolean;
  getAuth(key: string, opts?: AuthRequest): Promise<AuthResolution | null>;
  save(key: string, credential: OAuthCredential): Promise<void>;
}

export function createFileOAuthStore(configPath: string, opts: { fetch?: typeof fetch } = {}): LocalOAuthStore {
  return {
    keys(): string[] {
      const providers = readConfigFile(configPath).providers;

      return [...ISSUERS].flatMap(([base, issuer]) => {
        const stored = providers?.[issuer.section];
        const named = Object.keys(stored?.accounts ?? {}).filter((name) => heldLogin(stored?.accounts?.[name])).sort();

        return [...(heldLogin(stored) ? [MAIN_ACCOUNT] : []), ...named].map((account) => accountCredentialKey(base, account));
      });
    },

    has(key: string): boolean {
      return settleSync(Effect.map(issuerOf(key), (issuer) => heldLogin(credentialIn(readConfigFile(configPath), key, issuer))));
    },

    getAuth(key: string, authOpts?: AuthRequest): Promise<AuthResolution | null> {
      return settle(Effect.gen(function* () {
        const issuer = yield* issuerOf(key);
        const credential = credentialIn(readConfigFile(configPath), key, issuer);

        if (!credential?.accessToken) return null;
        const rejected = authOpts?.rejected;
        const refused = rejected !== undefined && refusedLogin(issuer.headers(credential), rejected);

        const usable = yield* Effect.promise(() => usableLogin({
          issuer: issuer.renewal, credential, refused, renew: () => renewUnderLock(configPath, { key, issuer }, credential, opts.fetch),
        }));

        return usable === null ? null : { headers: issuer.headers(usable), credentialKey: key };
      }));
    },

    save(key: string, credential: OAuthCredential): Promise<void> {
      return settle(Effect.flatMap(issuerOf(key), (issuer) => Effect.promise(() => updateConfigFile(configPath, (config) => {
        replaceLogin(config, key, issuer, credentialToConfig(credential));
      }))));
    },
  };
}

/** The network call runs inside the lock: released at the first `await`, a
 *  second caller could submit the same refresh token and race its replacement.
 *  Only the login on disk renews, so a sign-out the wait let in is not undone. */
function renewUnderLock(
  configPath: string,
  { key, issuer }: { readonly key: string; readonly issuer: OAuthIssuer },
  original: OAuthCredential,
  fetchFn?: typeof fetch,
): Promise<LoginRenewal> {
  return updateConfigFile(configPath, async (config): Promise<LoginRenewal> => {
    const latest = credentialIn(config, key, issuer);

    if (latest?.refreshToken === undefined) return 'revoked';

    if (latest.accessToken !== original.accessToken && !issuer.renewal.expiring(latest)) return latest;
    const renewal = await rotateLogin(key, `refreshing the ${issuer.section} login`, () => issuer.renewal.refresh(latest, fetchFn));

    // A spent refresh token is retired, so no later call submits it again and the login reads as signed out.
    if (renewal === 'revoked') replaceLogin(config, key, issuer, signedOutLogin(issuer, latest.metadata));
    else if (!('failed' in renewal)) replaceLogin(config, key, issuer, credentialToConfig(renewal));

    return renewal;
  });
}

/** A signed-out login: the issuer's retained registration, or nothing where it keeps none. */
function signedOutLogin(issuer: OAuthIssuer, metadata: JsonObject | undefined): StoredLogin | null {
  const retained = issuer.signedOut?.(metadata) ?? null;

  return retained === null ? null : { metadata: retained };
}

/** What a sign-out did: `removed` a signed-in login; `unconfirmed` is null when OpenAI confirmed the
 *  revocation, its reason when it did not, and undefined when revoking was not asked or nothing could be. */
export interface ChatGptSignOut {
  readonly removed: boolean;
  readonly unconfirmed?: string | null;
}

/**
 * Signs a ChatGPT login out under the lock its refresh takes, so no refresh queued behind it renews the login again.
 * Asked to revoke, OpenAI first revokes the refresh token on disk, after any rotation in flight. The tokens go
 * whatever OpenAI answers; the registration stays, so the next sign-in reuses the issued client.
 */
export function signOutChatGptLogin(configPath: string, account: string, opts: { revoke: boolean; fetch?: typeof fetch }): Promise<ChatGptSignOut> {
  const key = accountCredentialKey(CHATGPT_CRED_KEY, account);

  return settle(Effect.flatMap(issuerOf(key), (issuer) => Effect.promise(() => updateConfigFile(configPath, async (config): Promise<ChatGptSignOut> => {
    const login = loginIn(config, key, issuer);

    if (login === undefined) return { removed: false };
    const registration = registrationOf(login.metadata);

    const revocation = !opts.revoke || login.refreshToken === undefined || registration === null
      ? undefined
      : await revokeSession({ clientId: registration.clientId, refreshToken: login.refreshToken, ...(opts.fetch !== undefined && { fetch: opts.fetch }) });

    replaceLogin(config, key, issuer, signedOutLogin(issuer, login.metadata));

    return { removed: login.accessToken !== undefined || login.refreshToken !== undefined, ...(revocation !== undefined && { unconfirmed: revocation.unconfirmed }) };
  }))));
}

/** Replaces one login in `config`, or removes it (null); the section's other logins and keys stay as they were. */
function replaceLogin(config: KinuConfig, key: string, { section }: OAuthIssuer, login: StoredLogin | null): void {
  const account = accountOf(key);
  const stored = config.providers?.[section] ?? {};
  const { accessToken: _access, refreshToken: _refresh, expiresAt: _expires, metadata: _metadata, accounts, ...rest } = stored;

  const next = account === MAIN_ACCOUNT
    ? { ...rest, ...login, ...(accounts !== undefined && { accounts }) }
    : { ...stored, accounts: login === null
      ? Object.fromEntries(Object.entries(accounts ?? {}).filter(([name]) => name !== account))
      : { ...accounts, [account]: login } };

  const { [section]: _replaced, ...providers } = config.providers ?? {};

  config.providers = Object.keys(next).length === 0 ? providers : { ...providers, [section]: next };
}

function loginIn(config: KinuConfig, key: string, issuer: OAuthIssuer): StoredLogin | undefined {
  const account = accountOf(key);
  const stored = config.providers?.[issuer.section];

  return account === MAIN_ACCOUNT ? stored : stored?.accounts?.[account];
}

function credentialIn(config: KinuConfig, key: string, issuer: OAuthIssuer): OAuthCredential | null {
  const login = loginIn(config, key, issuer);

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

