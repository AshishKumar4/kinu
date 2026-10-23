import { Effect } from 'effect';
import {
  KeptProviderListingSchema, type ProviderListing, safeJsonParse, type Credential, CLAUDE_CRED_KEY, CODEX_CRED_KEY, baseCredentialKey, claudeCodeFrom, claudeSignInRefusal, createClaudeOAuthClient, startClaudeSignIn, subscriptionIssuer, renewableLogin, rotateLogin, usableLogin, type LoginRenewal, type SubscriptionIssuer, decodeCodexAccountId, type JsonValue, type OAuthCredential, parseJsonValue, ownerCaller, type UserCaller, type ResolvedCaller, credentialToHeaders, refusedLogin, type AuthRequest, type AuthResolution, validateCredential, validateCredentialKey, createCredentialCipher, type CredentialCipher, revocationEndpointFor, revokeOAuthGrant, type DisconnectOutcome, isModelInferenceCredentialKey, CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY, accountIdFromCloudflareCredential, cloudflareAIGatewayId, cloudflareAccountsFromCredential, cloudflareWorkersAIBaseURL, fetchCloudflareAIGateways, isCloudflareAIGatewayId, isCloudflareCredentialExpiring, isCloudflareCredentialUsable, refreshCloudflareCredential, withCloudflareAccount, type CloudflareAccount, type CloudflareAIGatewaySummary, type CredentialSummary, CLOUDFLARE_WEB_SEARCH_CRED_KEY, grantsWebSearch, storedCredentialKey,
} from '@kinu.run/core';
import { attempt, authoredRefusal, diagnostics, joining, KinuError, renderThrownChain, settle, tolerate, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { UserObjectHost } from './user-host';

/** A stored credential sealed for its account rather than its object, so it outlives a reset that recreates the object. */
export interface CheckpointedCredential {
  readonly key: string;
  readonly sealed: string;
}

function checkpointAad(account: string, key: string): string {
  return `checkpoint:${account}:${key}`;
}

/** Through `tolerate`, never a caught parse error: a JSON error message quotes the text it choked on, the decrypted secret. */
function decodedCredential(key: string, plaintext: string): Credential {
  const decoded = tolerate(() => parseJsonValue(plaintext), 'malformed-input');

  if (decoded === undefined) throw new KinuError('bad_input', `the stored credential ${key} did not decode as JSON`);

  return validateCredential({ key, value: decoded });
}

interface HeldLogin {
  readonly cred: OAuthCredential;
  readonly revision: number;
}

/** What a failed refresh names, per base key. */
const REFRESH_DOING: ReadonlyMap<string, string> = new Map([
  [CODEX_CRED_KEY, 'refreshing the Codex credential'],
  [CLAUDE_CRED_KEY, 'refreshing the Claude credential'],
  [CLOUDFLARE_OAUTH_CRED_KEY, 'refreshing the Cloudflare credential'],
]);

const CLAUDE_SIGN_IN_KEY = 'claude.sign-in';

/** `revision` at the start: a write or disconnect since spends the sign-in. */
const ClaudeSignInSchema = v.object({ url: v.string(), state: v.string(), verifier: v.string(), revision: v.number() });

export interface CodexStatus {
  connected: boolean;
  accountId: string | null;
  expiresAt: number | null;
}

/** The endpoint a stored credential names, and the window its owner declared; null where its provider's own applies. */
export interface CredentialEndpoint {
  readonly baseURL: string;
  readonly contextWindow?: number;
}

function credentialEndpoint(storedKey: string, cred: Credential): CredentialEndpoint | null {
  const baseURL = credentialBaseURL(storedKey, cred);

  if (baseURL === null) return null;

  return cred.kind === 'openai-compat' && cred.contextWindow !== undefined ? { baseURL, contextWindow: cred.contextWindow } : { baseURL };
}

function credentialBaseURL(storedKey: string, cred: Credential): string | null {
  if (cred.kind === 'openai-compat') return cred.baseURL;

  if (storedKey === CLOUDFLARE_OAUTH_CRED_KEY && cred.kind === 'oauth') {
    if (!isCloudflareCredentialUsable(cred)) return null;
    const accountId = accountIdFromCloudflareCredential(cred);

    return accountId ? cloudflareWorkersAIBaseURL(accountId) : null;
  }

  return null;
}


/** The selected AI Gateway: written only by `selectAIGateway`, an authentication setting like a credential. */
export const AI_GATEWAY_CONFIG_KEY = 'cloudflare_ai_gateway';

export type UserCredentialsHost = Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier' | 'sqlx'>;

/** The account's credential vault. */
export class UserCredentials {
  constructor(private readonly host: UserCredentialsHost) {}

  async listCredentials(caller: UserCaller): Promise<CredentialSummary[]> {
    return await this.credentialSummaries(await this.host.requireTier(caller, 'credentials.model'));
  }

  /** Each credential's key and kind; a subscription login that never renews says when it stops working. */
  private async credentialSummaries(_resolved: ResolvedCaller): Promise<CredentialSummary[]> {
    const rows = this.host.sqlx<{ key: string; kind: CredentialSummary['kind'] }>(`SELECT key, kind FROM user_credentials ORDER BY key`);

    return await Promise.all(rows.map(async (row): Promise<CredentialSummary> => {
      if (row.kind !== 'oauth' || subscriptionIssuer(row.key) === null) return row;
      const login = await this.readCredential(row.key);

      return login?.kind === 'oauth' && !renewableLogin(login) && login.expiresAt !== undefined ? { ...row, expiresAt: login.expiresAt } : row;
    }));
  }

  /** Model-inference credentials survive tainting (headers attach in trusted DO code, never in LLM
   * context); everything else is owner-level. */
  private requireCredentialAccess(caller: UserCaller, key: string): Promise<ResolvedCaller> {
    return this.host.requireTier(caller, isModelInferenceCredentialKey(key) ? 'credentials.model' : 'credentials.other');
  }

  async setCredential(caller: UserCaller, key: string, credentialJson: Credential | JsonValue): Promise<void> {
    await this.host.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);

    if (storedCredentialKey(key) !== key) {
      throw new KinuError('bad_input', `${key} is derived from your Cloudflare login and cannot be stored directly.`);
    }

    const cred = validateCredential({ key, value: credentialJson });

    await this.writeCredential(key, cred);

    // Discover AI Gateways right after Cloudflare login so my-gateway works without a settings visit.
    // listAIGateways never throws.
    if (key === CLOUDFLARE_OAUTH_CRED_KEY) await this.listAIGateways(await ownerCaller(this.host.env));
  }

  async deleteCredential(caller: UserCaller, key: string, revoke: boolean): Promise<DisconnectOutcome> {
    await this.host.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);

    return this.disconnectCredential(key, revoke);
  }

  /**
   * Removes the credential; asked to, then has its provider revoke the grant (RFC 7009). Removal comes first so a
   * slow or failing provider cannot keep it live here; a refusal comes back in the provider's words.
   */
  async disconnectCredential(key: string, revoke: boolean): Promise<DisconnectOutcome> {
    const endpoint = revoke ? revocationEndpointFor(key, this.host.env) : null;

    if (endpoint === null) {
      this.dropCredential(key);

      return { unrevoked: revoke ? `Kinu cannot revoke ${key} at its provider; it is disconnected here only.` : null };
    }

    let failures: readonly KinuError[];

    try {
      const credential = await this.readCredential(key);

      this.dropCredential(key);

      if (credential?.kind !== 'oauth') return { unrevoked: null };
      failures = await revokeOAuthGrant({ endpoint, credential, fetch: globalThis.fetch });
    } catch (cause) {
      // An unopenable row still leaves Kinu; its grant cannot be revoked from here.
      this.dropCredential(key);
      failures = [toKinuError({ doing: 'reading the credential to revoke it', cause, otherwise: 'io' })];
    }

    for (const failure of failures) diagnostics.failure('credential.revoke_failed', failure, { credentialKey: key });

    return { unrevoked: failures.length === 0 ? null : failures.map((failure) => failure.message).join(' · ') };
  }


  private cipher(): Promise<CredentialCipher> {
    return createCredentialCipher(this.host.env);
  }

  /** AAD binds the DO id (no cross-user reuse) and the credential key (no cross-row moves). */
  private credentialAad(key: string): string {
    return `${this.host.ctx.id.toString()}:${key}`;
  }

  /** Null when no credential is stored; a stored row that does not open or decode rejects,
   * so callers can tell "not connected" from "connected but unreadable". */
  async readCredential(key: string): Promise<Credential | null> {
    return (await this.readCredentialAt(key))?.cred ?? null;
  }

  /** The row and its revision, read in one step. */
  private async readCredentialAt(key: string): Promise<{ readonly cred: Credential; readonly revision: number } | null> {
    const row = this.host.sqlx<{ value: string }>(`SELECT value FROM user_credentials WHERE key = ?`, key)[0];
    const revision = this.credentialRevision(key);

    if (!row) return null;
    let plaintext: string;

    try { plaintext = await (await this.cipher()).open(this.credentialAad(key), row.value); }
    catch (err) {
      throw toKinuError({ doing: `opening the stored credential ${key}`, cause: err, otherwise: 'bad_input' });
    }

    return { cred: decodedCredential(key, plaintext), revision };
  }

  /** Every stored credential sealed for `account`: a reset recreates this object under a new id, which its own seal binds. */
  async checkpointCredentials(caller: UserCaller, account: string): Promise<CheckpointedCredential[]> {
    await this.host.requireTier(caller, 'credentials.other');
    // A rotation in flight would spend the refresh token this reads.
    await Promise.allSettled(this.refreshing.each());
    const cipher = await this.cipher();
    const checkpoint: CheckpointedCredential[] = [];

    for (const { key } of this.host.sqlx<{ key: string }>(`SELECT key FROM user_credentials ORDER BY key`)) {
      const cred = await this.readCredential(key);

      if (cred !== null) checkpoint.push({ key, sealed: await cipher.seal(checkpointAad(account, key), JSON.stringify(cred)) });
    }

    return checkpoint;
  }

  /** Each checkpointed credential this store does not hold, sealed again under this object's id; the keys restored. */
  async restoreCredentials(caller: UserCaller, account: string, checkpoint: readonly CheckpointedCredential[]): Promise<string[]> {
    await this.host.requireTier(caller, 'credentials.other');
    const cipher = await this.cipher();

    return settle(Effect.gen({ self: this }, function* () {
      const restored: string[] = [];

      for (const { key, sealed } of checkpoint) {
        const revision = this.credentialRevision(key);

        if (this.host.sqlx(`SELECT 1 FROM user_credentials WHERE key = ?`, key).length > 0) continue;

        const plaintext = yield* attempt({ doing: `opening the checkpointed credential ${key}`, otherwise: 'bad_input' },
          () => cipher.open(checkpointAad(account, key), sealed));

        const cred = decodedCredential(key, plaintext);
        const resealed = yield* Effect.promise(() => this.sealCredential(key, cred));

        if (this.commitCredential({ key, kind: cred.kind, sealed: resealed, expectRevision: revision })) restored.push(key);
      }

      return restored;
    }));
  }

  /** Writes nothing, so {@link commitCredential} can be paired with a fence read in one turn. */
  async sealCredential(key: string, cred: Credential): Promise<string> {
    return (await this.cipher()).seal(this.credentialAad(key), JSON.stringify(cred));
  }

  /**
   * Synchronous so `expectRevision` is a real compare-and-swap; preserves `created_at` on update.
   * `false` means the store moved while the caller was sealing, so nothing was written.
   */
  commitCredential(input: {
    key: string; kind: Credential['kind']; sealed: string; expectRevision?: number;
  }): boolean {
    if (input.expectRevision !== undefined && this.credentialRevision(input.key) !== input.expectRevision) {
      return false;
    }

    this.host.sqlx(
      `INSERT INTO user_credentials (key, kind, value) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value = excluded.value`,
      input.key, input.kind, input.sealed,
    );
    this.bumpCredentialRevision(input.key);
    this.bumpCredentialsRevision();

    return true;
  }

  private async writeCredential(key: string, cred: Credential): Promise<void> {
    this.commitCredential({ key, kind: cred.kind, sealed: await this.sealCredential(key, cred) });
  }

  /** Bumps the revision so an in-flight refresh cannot land a rotated token over this deletion. */
  private dropCredential(key: string): void {
    this.host.sqlx(`DELETE FROM user_credentials WHERE key = ?`, key);
    this.bumpCredentialRevision(key);
    this.bumpCredentialsRevision();
  }

  /** Moves on every write and deletion of the key; 0 for a key never held. */
  credentialRevision(key: string): number {
    const row = v.safeParse(v.object({ revision: v.number() }), this.host.sqlx(
      `SELECT revision FROM user_credential_revisions WHERE key = ?`, key,
    )[0]);

    return row.success ? row.output.revision : 0;
  }

  private bumpCredentialRevision(key: string): void {
    this.host.sqlx(
      `INSERT INTO user_credential_revisions (key, revision) VALUES (?, 1)
       ON CONFLICT(key) DO UPDATE SET revision = revision + 1`,
      key,
    );
  }

  /** Rises with every credential-store mutation; workspaces compare it before using cached state.
   *  `shared` like `auth_tokens.socket`: it names no secret and mints nothing. */
  async getCredentialsRevision(caller: UserCaller): Promise<number> {
    await this.host.requireTier(caller, 'credentials.model');

    return this.credentialsRevision();
  }

  private credentialsRevision(): number {
    const row = v.safeParse(v.object({ revision: v.number() }), this.host.sqlx(
      `SELECT COALESCE(credentials_revision, 0) AS revision FROM account_epochs WHERE id = 1`,
    )[0]);

    return row.success ? row.output.revision : 0;
  }

  /** The last complete provider listing kept, if it was swept under the credentials as they stand and under `accounts`,
   *  the canonical {provider: account} a workspace lists under; else none, and the asker sweeps. */
  async storedProviderListing(caller: UserCaller, accounts: string): Promise<ProviderListing | null> {
    await this.host.requireTier(caller, 'credentials.model');

    const row = this.host.sqlx<{ listing: string }>(
      `SELECT listing FROM user_provider_listing WHERE id = 1 AND credentials_revision = ? AND accounts = ?`,
      this.credentialsRevision(), accounts,
    )[0];

    const kept = row === undefined ? null : v.safeParse(KeptProviderListingSchema, safeJsonParse(row.listing));

    return kept?.success === true ? kept.output : null;
  }

  /** Keeps a workspace's complete listing, swept under `revision` and `accounts`, unless the credentials moved meanwhile:
   *  a listing from before a key changed is never kept. */
  async keepProviderListing(caller: UserCaller, revision: number, accounts: string, listing: ProviderListing): Promise<void> {
    await this.host.requireTier(caller, 'credentials.model');

    const kept = v.parse(KeptProviderListingSchema, listing);

    if (revision !== this.credentialsRevision()) return;
    this.host.sqlx(
      `INSERT INTO user_provider_listing (id, credentials_revision, accounts, listing) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET credentials_revision = excluded.credentials_revision, accounts = excluded.accounts, listing = excluded.listing`,
      revision, accounts, JSON.stringify(kept),
    );
  }

  bumpCredentialsRevision(): void {
    this.host.sqlx(`INSERT INTO account_epochs (id, credentials_revision) VALUES (1, 1)
      ON CONFLICT(id) DO UPDATE SET credentials_revision = COALESCE(credentials_revision, 0) + 1`);
  }

  /**
   * Returns the rotated credential, or `'revoked'` if the owner moved it meanwhile, so a late
   * rotation reply cannot reconnect a disconnected account or overwrite a replacement.
   */
  private async commitRefreshedCredential(
    key: string, next: OAuthCredential, expectRevision: number,
  ): Promise<OAuthCredential | 'revoked'> {
    const sealed = await this.sealCredential(key, next);

    if (this.commitCredential({ key, kind: next.kind, sealed, expectRevision })) return next;
    diagnostics.event('credential.refresh_superseded', { outcome: 'denied', credentialKey: key });
    // The store is the authority, not the token this call was carrying.
    const current = await this.readCredential(key);

    return current?.kind === 'oauth' ? current : 'revoked';
  }

  /** No-op if the owner already replaced the credential; the rejection belongs to the old one. */
  private retireRejectedCredential(key: string, expectRevision: number): void {
    if (this.credentialRevision(key) !== expectRevision) return;
    this.dropCredential(key);
  }

  /** MCP headers hold bearer tokens, sealed like credentials; AAD is the server id to prevent
   *  cross-server replay. Null passes through. */
  private mcpHeadersAad(serverId: string): string {
    return `${this.host.ctx.id.toString()}:mcp:${serverId}`;
  }

  async sealMcpHeaders(serverId: string, headers: string | null): Promise<string | null> {

    return headers === null ? null : (await this.cipher()).seal(this.mcpHeadersAad(serverId), headers);
  }

  /** Stored headers that do not open reject: sent without them, the request would reach
   * the server unauthenticated and read as a server wanting a login. */
  async openMcpHeaders(serverId: string, stored: string | null): Promise<string | null> {

    if (stored === null) return null;

    try { return await (await this.cipher()).open(this.mcpHeadersAad(serverId), stored); }
    catch (err) {
      throw toKinuError({ doing: `opening the stored headers of MCP server ${serverId}`, cause: err, otherwise: 'bad_input' });
    }
  }

  /** The endpoint is not a secret and is absent from listCredentials(); the provider proxy reads it without the login. */
  async getCredentialEndpoint(caller: UserCaller, key: string): Promise<CredentialEndpoint | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // The my-gateway and web search views use the same account-scoped /ai/v1 endpoint as Workers AI;
    // only the cf-aig-gateway-id header differs.
    const storedKey = storedCredentialKey(key);
    const cred = await this.readCredential(storedKey);

    return cred === null ? null : credentialEndpoint(storedKey, cred);
  }

  async getAuthHeaders(caller: UserCaller, key: string, opts?: AuthRequest): Promise<Record<string, string> | null> {
    return (await this.getAuth(caller, key, opts))?.headers ?? null;
  }

  /** What a model call needs of a credential, headers and endpoint, in one round trip. */
  async getAuth(caller: UserCaller, key: string, opts?: AuthRequest): Promise<AuthResolution | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // `cloudflare.ai-gateway` and `cloudflare.web-search` are derived views of the Cloudflare login: same bearer and
    // refresh, but cf-aig-gateway-id names the user's selected gateway (null until selected for my-gateway).
    const storedKey = storedCredentialKey(key);
    const stored = await this.readCredentialAt(storedKey);

    if (!stored) return null;

    if (key === CLOUDFLARE_WEB_SEARCH_CRED_KEY && (stored.cred.kind !== 'oauth' || !grantsWebSearch(stored.cred))) return null;
    // Explicitly non-null so the refresh reassignment below doesn't re-widen to `Credential | null`.
    let cred: Credential = stored.cred;

    const issuer = subscriptionIssuer(storedKey);
    // Refused on the login this store still holds; one another caller already rotated is served as it stands.
    const refused = opts?.rejected !== undefined && refusedLogin(credentialToHeaders(storedKey, cred), opts.rejected);

    if (issuer !== null && cred.kind === 'oauth') {
      const held = { cred, revision: stored.revision };
      const usable = await usableLogin({ issuer, credential: cred, refused, renew: () => this.refreshSubscriptionLogin(storedKey, held, issuer) });

      if (usable === null) return null;
      cred = usable;
    }

    if (storedKey === CLOUDFLARE_OAUTH_CRED_KEY && cred.kind === 'oauth') {
      const needRefresh = refused || isCloudflareCredentialExpiring(cred);

      if (needRefresh) {
        if (!cred.refreshToken) return null;
        const refreshed = await this.refreshCloudflareInternal({ cred, revision: stored.revision });

        if (refreshed === 'revoked') return null;

        if (!('failed' in refreshed)) cred = refreshed;
      }
    }

    // A credential whose stored shape doesn't match its key is a defect and must not reach
    // the caller as "not connected".
    const headers = credentialToHeaders(storedKey, cred);

    if (key === CLOUDFLARE_AI_GATEWAY_CRED_KEY) {
      const gatewayId = this.selectedAIGatewayId();

      if (!gatewayId) return null;
      headers['cf-aig-gateway-id'] = gatewayId;
    } else if (key === CLOUDFLARE_OAUTH_CRED_KEY || key === CLOUDFLARE_WEB_SEARCH_CRED_KEY) {
      // Use the user's selected gateway if any, otherwise the platform's configured default.
      headers['cf-aig-gateway-id'] = this.selectedAIGatewayId() ?? cloudflareAIGatewayId(this.host.env);
    }

    return { headers, ...credentialEndpoint(storedKey, cred) };
  }


  private selectedAIGatewayId(): string | null {
    const row = this.host.sqlx<{ value: string }>(
      `SELECT value FROM user_config WHERE key = ?`, AI_GATEWAY_CONFIG_KEY,
    )[0];

    return row && isCloudflareAIGatewayId(row.value) ? row.value : null;
  }

  /** Null when no usable Cloudflare credential is stored; rejects when the login
   * is there and its refresh failed. */
  private async cloudflareAPICredential(): Promise<{ accessToken: string; accountId: string } | null> {
    const stored = await this.readCredentialAt(CLOUDFLARE_OAUTH_CRED_KEY);

    if (stored?.cred.kind !== 'oauth' || !isCloudflareCredentialUsable(stored.cred)) return null;
    let cred = stored.cred;

    if (isCloudflareCredentialExpiring(cred)) {
      const refreshed = await this.refreshCloudflareInternal({ cred, revision: stored.revision });

      if (refreshed === 'revoked') return null;

      if ('failed' in refreshed) throw refreshed.failed;
      cred = refreshed;
    }

    const accountId = accountIdFromCloudflareCredential(cred);

    return accountId ? { accessToken: cred.accessToken, accountId } : null;
  }

  /** With exactly one gateway and nothing selected, selects it (persisted). Never throws:
   * unusable login or failed discovery surface in `error`, so login can call this inline. */
  async listAIGateways(caller: UserCaller): Promise<{
    connected: boolean;
    selectedId: string | null;
    gateways: CloudflareAIGatewaySummary[];
    error: string | null;
  }> {
    await this.host.requireTier(caller, 'ai_gateway.admin');
    let selectedId = this.selectedAIGatewayId();

    try {
      const api = await this.cloudflareAPICredential();

      if (!api) return { connected: false, selectedId, gateways: [], error: null };
      const gateways = await fetchCloudflareAIGateways(api.accountId, api.accessToken);

      if (!selectedId && gateways.length === 1) {
        await this.selectAIGateway(await ownerCaller(this.host.env), gateways[0].id);
        selectedId = gateways[0].id;
      }

      return { connected: true, selectedId, gateways, error: null };
    } catch (cause) {
      const error = authoredRefusal({ doing: 'listing your Cloudflare AI Gateways', cause });
      diagnostics.failure('user.ai_gateways_unread', error);

      return { connected: true, selectedId, gateways: [], error: renderThrownChain({ cause: error }) };
    }
  }

  /** The gateway names the `cf-aig-gateway-id` every Cloudflare request sends, so a change moves the credentials'
   *  revision as a credential's does: a workspace the fan-out skips as idle reads it at its next turn's open, with
   *  the model catalog that gateway serves. */
  async selectAIGateway(caller: UserCaller, gatewayId: string | null): Promise<void> {
    await this.host.requireTier(caller, 'ai_gateway.admin');

    if (gatewayId !== null && !isCloudflareAIGatewayId(gatewayId)) throw new KinuError('bad_input', 'Invalid AI Gateway id.');

    const changed = gatewayId === null
      ? this.host.sqlx(`DELETE FROM user_config WHERE key = ? RETURNING key`, AI_GATEWAY_CONFIG_KEY)
      : this.host.sqlx(
        `INSERT INTO user_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value RETURNING key`,
        AI_GATEWAY_CONFIG_KEY, gatewayId,
      );

    if (changed.length > 0) this.bumpCredentialsRevision();
  }

  /** Reads the stored credential only, no API call, so it cannot fail for a reason the user
   * did not cause. */
  async listCloudflareAccounts(caller: UserCaller): Promise<{
    connected: boolean;
    selectedId: string | null;
    accounts: CloudflareAccount[];
    /** The login grants web search, so searches through Cloudflare bill this account (`cloudflare.web-search`). */
    webSearch: boolean;
    /** The login is past its expiry with no refresh left (Cloudflare refused it): only signing in again restores it. */
    signInExpired: boolean;
  }> {
    await this.host.requireTier(caller, 'ai_gateway.admin');
    const cred = await this.readCredential(CLOUDFLARE_OAUTH_CRED_KEY);

    if (cred?.kind !== 'oauth') return { connected: false, selectedId: null, accounts: [], webSearch: false, signInExpired: false };

    return {
      connected: true,
      selectedId: accountIdFromCloudflareCredential(cred),
      accounts: cloudflareAccountsFromCredential(cred),
      webSearch: grantsWebSearch(cred),
      signInExpired: isCloudflareCredentialExpiring(cred) && !renewableLogin(cred),
    };
  }

  /** Point Workers AI at another of this login's accounts. The AI Gateway selection belongs
   * to the old account, so it is dropped and rediscovered. */
  async selectCloudflareAccount(caller: UserCaller, accountId: string): Promise<void> {
    await this.host.requireTier(caller, 'ai_gateway.admin');
    const cred = await this.readCredential(CLOUDFLARE_OAUTH_CRED_KEY);

    if (cred?.kind !== 'oauth') throw new KinuError('bad_input', 'Cloudflare is not connected.');
    await this.writeCredential(CLOUDFLARE_OAUTH_CRED_KEY, withCloudflareAccount(cred, accountId));
    const owner = await ownerCaller(this.host.env);
    await this.selectAIGateway(owner, null);
    await this.listAIGateways(owner);
  }

  /** `'revoked'` on `invalid_grant` or a disconnect mid-refresh; `{ failed }` when the issuer could not be asked. One
   *  refresh per login at a time, shared by later callers: two spending one rotating token would lose the login. */
  private async refreshOAuthCredential(
    key: string,
    held: HeldLogin,
    rotate: () => Promise<OAuthCredential>,
    onRevoked: (revision: number) => Promise<void>,
  ): Promise<LoginRenewal> {
    return this.refreshing(key, () => this.rotateOAuthCredential(key, held, rotate, onRevoked));
  }

  private readonly refreshing = joining<string, LoginRenewal>();

  private async rotateOAuthCredential(
    key: string,
    held: HeldLogin,
    rotate: () => Promise<OAuthCredential>,
    onRevoked: (revision: number) => Promise<void>,
  ): Promise<LoginRenewal> {
    // Replaced since this caller read it: the held refresh token may be spent. Writes fence on that revision.
    if (this.credentialRevision(key) !== held.revision) {
      const current = await this.readCredential(key);

      return current?.kind === 'oauth' ? current : 'revoked';
    }

    const rotated = await rotateLogin(key, REFRESH_DOING.get(baseCredentialKey(key)) ?? `refreshing ${key}`, rotate);

    if (rotated === 'revoked') await onRevoked(held.revision);

    if (rotated === 'revoked' || 'failed' in rotated) return rotated;

    return await this.commitRefreshedCredential(key, rotated, held.revision);
  }

  /** The token still serves management APIs after a rejected refresh; only the refresh token is stripped. */
  private refreshCloudflareInternal(held: HeldLogin): Promise<LoginRenewal> {
    return this.refreshOAuthCredential(
      CLOUDFLARE_OAUTH_CRED_KEY,
      held,
      () => refreshCloudflareCredential(this.host.env, held.cred),
      async (revision) => {
        const { refreshToken: _dead, ...rest } = held.cred;
        await this.commitRefreshedCredential(CLOUDFLARE_OAUTH_CRED_KEY, rest, revision);
      },
    );
  }

  /** A rejected refresh deletes only that login's row, so its connect CTA resurfaces. */
  private refreshSubscriptionLogin(key: string, held: HeldLogin, issuer: SubscriptionIssuer): Promise<LoginRenewal> {
    return this.refreshOAuthCredential(
      key,
      held,
      () => issuer.refresh(held.cred),
      async (revision) => { this.retireRejectedCredential(key, revision); },
    );
  }

  /** One Claude sign-in at a time; its PKCE verifier stays in this object, as the CLI's stays on the machine. */
  async startClaudeSignIn(caller: UserCaller): Promise<{ readonly url: string }> {
    await this.host.requireTier(caller, 'subscription_auth');
    const signIn = await startClaudeSignIn();

    this.host.ctx.storage.kv.put(CLAUDE_SIGN_IN_KEY, { ...signIn, revision: this.credentialRevision(CLAUDE_CRED_KEY) });

    return { url: signIn.url };
  }

  /**
   * `returned` is what Claude showed the owner: the code, or the address it sent the browser to. A code that
   * is not this sign-in's is refused; Claude's own refusal comes back as `error`, as a Codex poll's does.
   */
  async finishClaudeSignIn(caller: UserCaller, returned: string): Promise<{ connected: boolean; error?: string }> {
    await this.host.requireTier(caller, 'subscription_auth');

    return settle(Effect.gen({ self: this }, function* () {
      const held = v.safeParse(ClaudeSignInSchema, this.host.ctx.storage.kv.get(CLAUDE_SIGN_IN_KEY));

      if (!held.success) return yield* Effect.fail(new KinuError('missing', 'No Claude sign-in is in progress: start it again.'));
      const signIn = held.output;
      const code = claudeCodeFrom(returned, signIn.state);

      const exchanged = yield* Effect.match(
        attempt({ doing: 'exchanging the Claude sign-in code', otherwise: 'io' }, () => createClaudeOAuthClient().exchange(signIn, code)),
        {
          onFailure: (error) => {
            diagnostics.failure('user.claude_sign_in_failed', error);

            return { error: claudeSignInRefusal(error) };
          },
          onSuccess: (credential) => ({ credential }),
        },
      );

      if ('error' in exchanged) return { connected: false, error: exchanged.error };
      const { credential } = exchanged;
      const sealed = yield* attempt({ doing: 'sealing the Claude credential', otherwise: 'io' }, () => this.sealCredential(CLAUDE_CRED_KEY, credential));
      const current = v.safeParse(ClaudeSignInSchema, this.host.ctx.storage.kv.get(CLAUDE_SIGN_IN_KEY));

      if (!current.success || current.output.state !== signIn.state
        || !this.commitCredential({ key: CLAUDE_CRED_KEY, kind: credential.kind, sealed, expectRevision: signIn.revision })) {
        return { connected: false, error: 'That Claude sign-in was superseded before it completed: start it again.' };
      }

      this.host.ctx.storage.kv.delete(CLAUDE_SIGN_IN_KEY);

      return { connected: true };
    }));
  }

  async disconnectCodex(caller: UserCaller, revoke: boolean): Promise<DisconnectOutcome> {
    await this.host.requireTier(caller, 'subscription_auth');

    return this.disconnectCredential(CODEX_CRED_KEY, revoke);
  }

  async getCodexStatus(caller: UserCaller): Promise<CodexStatus> {
    await this.host.requireTier(caller, 'subscription_auth');
    const cred = await this.readCredential(CODEX_CRED_KEY);

    if (cred?.kind === 'oauth') return { connected: true, accountId: decodeCodexAccountId(cred.accessToken), expiresAt: cred.expiresAt ?? null };

    return { connected: false, accountId: null, expiresAt: null };
  }
}
