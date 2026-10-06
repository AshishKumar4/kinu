import { Effect } from 'effect';
import {
  type Credential, CLAUDE_CRED_KEY, CODEX_CRED_KEY, baseCredentialKey, claudeCodeFrom, createClaudeOAuthClient, createCodexOAuthClient, startClaudeSignIn, subscriptionIssuer, rotateLogin, usableLogin, type LoginRenewal, type SubscriptionIssuer, decodeCodexAccountId, tokensToCredential, type DeviceCodeStart, type JsonValue, type OAuthCredential, type EgressRequestFacts, type EgressSecretBinding, parseJsonValue, ownerCaller, type UserCaller, type ResolvedCaller, credentialToHeaders, refusedLogin, type AuthRequest, type AuthResolution, validateCredential, validateCredentialKey, createCredentialCipher, isSealedCredential, type CredentialCipher, listEgressSecrets, putEgressSecret, resolveEgressInjection, revokeEgressSecret, rewrapEgressSecrets, type EgressInjectionResult, type EgressSecretSummary, type EgressVaultDeps, type PutEgressSecretInput, revocationEndpointFor, revokeOAuthGrant, type UnrevokedGrant, isModelInferenceCredentialKey, CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY, accountIdFromCloudflareCredential, cloudflareAIGatewayId, cloudflareAccountsFromCredential, cloudflareWorkersAIBaseURL, fetchCloudflareAIGateways, isCloudflareAIGatewayId, isCloudflareCredentialExpiring, isCloudflareCredentialUsable, refreshCloudflareCredential, withCloudflareAccount, type CloudflareAccount, type CloudflareAIGatewaySummary,
} from '@kinu.run/core';
import { attempt, authoredRefusal, diagnostics, KinuError, renderThrownChain, settle, tolerate, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { UserObjectHost } from './user-host';

export interface CredentialSummary {
  key: string;
  kind: 'bearer' | 'oauth' | 'openai-compat';
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

function unrenewable(key: string, cred: Credential): string | null {
  return subscriptionIssuer(key) !== null && cred.kind === 'oauth' && !cred.refreshToken ? `${key} requires an OAuth refresh token.` : null;
}

export interface CodexStatus {
  connected: boolean;
  accountId: string | null;
  expiresAt: number | null;
  startedFlow: { userCode: string; portalURL: string; pollIntervalSec: number } | null;
}

export interface ConnectedProvider {
  id: string;
  label: string;
  credentialKeys: string[];
}

/** The endpoint a stored credential names; null where its provider's own endpoint applies. */
function credentialBaseURL(storedKey: string, cred: Credential): string | null {
  if (cred.kind === 'openai-compat') return cred.baseURL;

  if (cred.kind === 'bearer' && cred.baseURL !== undefined) return cred.baseURL;

  if (storedKey === CLOUDFLARE_OAUTH_CRED_KEY && cred.kind === 'oauth') {
    if (!isCloudflareCredentialUsable(cred)) return null;
    const accountId = accountIdFromCloudflareCredential(cred);

    return accountId ? cloudflareWorkersAIBaseURL(accountId) : null;
  }

  return null;
}

const CREDENTIAL_ENVELOPE_MARKER = 'credential_envelope_key_id';

const AI_GATEWAY_CONFIG_KEY = 'cloudflare_ai_gateway';

export interface UserCredentialsHost extends Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier' | 'sqlx'> {
  setConfig(caller: UserCaller, key: string, value: string): Promise<void>;
}

/** The account's credential vault. */
export class UserCredentials {
  constructor(private readonly host: UserCredentialsHost) {}

  async listCredentials(caller: UserCaller): Promise<CredentialSummary[]> {
    return this.credentialSummaries(await this.host.requireTier(caller, 'credentials.model'));
  }

  private credentialSummaries(_resolved: ResolvedCaller): CredentialSummary[] {
    return this.host.sqlx<{ key: string; kind: CredentialSummary['kind'] }>(`SELECT key, kind FROM user_credentials ORDER BY key`);
  }

  /** Model-inference credentials survive tainting (headers attach in trusted DO code, never in LLM
   * context); everything else is owner-level. */
  private requireCredentialAccess(caller: UserCaller, key: string): Promise<ResolvedCaller> {
    return this.host.requireTier(caller, isModelInferenceCredentialKey(key) ? 'credentials.model' : 'credentials.other');
  }

  async setCredential(caller: UserCaller, key: string, credentialJson: Credential | JsonValue): Promise<void> {
    await this.host.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);

    if (key === CLOUDFLARE_AI_GATEWAY_CRED_KEY) {
      throw new KinuError('bad_input', `${CLOUDFLARE_AI_GATEWAY_CRED_KEY} is derived from your Cloudflare login and cannot be stored directly.`);
    }

    const cred = validateCredential({ key, value: credentialJson });

    const refusal = unrenewable(key, cred);

    if (refusal !== null) throw new KinuError('bad_input', refusal);

    await this.writeCredential(key, cred);

    // Discover AI Gateways right after Cloudflare login so my-gateway works without a settings visit.
    // listAIGateways never throws.
    if (key === CLOUDFLARE_OAUTH_CRED_KEY) await this.listAIGateways(await ownerCaller(this.host.env));
  }

  async deleteCredential(caller: UserCaller, key: string): Promise<void> {
    await this.host.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);
    await this.disconnectCredential(key);
  }

  /** Disconnected grants the provider refused to revoke, newest first. */
  async listUnrevokedGrants(caller: UserCaller): Promise<UnrevokedGrant[]> {
    await this.host.requireTier(caller, 'credentials.other');

    return this.host.sqlx<{ key: string; reasons_json: string; recorded_at: number }>(
      `SELECT key, reasons_json, recorded_at FROM user_unrevoked_grants ORDER BY recorded_at DESC`,
    ).map((row) => ({ key: row.key, reasons: v.parse(v.array(v.string()), JSON.parse(row.reasons_json)), recordedAt: row.recorded_at }));
  }

  /** The owner revoked it at the provider by hand, or accepts it. */
  async dismissUnrevokedGrant(caller: UserCaller, key: string): Promise<void> {
    await this.host.requireTier(caller, 'credentials.other');
    this.host.sqlx(`DELETE FROM user_unrevoked_grants WHERE key = ?`, key);
  }

  /**
   * Removes the credential, then asks its provider to revoke the grant (RFC 7009). Removal comes first so a
   * slow or failing provider cannot keep it live here; a refused revoke is kept for the owner to see.
   */
  async disconnectCredential(key: string): Promise<void> {
    const endpoint = revocationEndpointFor(key, this.host.env);

    if (endpoint === null) {
      this.dropCredential(key);

      return;
    }

    let failures: readonly KinuError[];

    try {
      const credential = await this.readCredential(key);

      this.dropCredential(key);

      if (credential?.kind !== 'oauth') return;
      failures = await revokeOAuthGrant({ endpoint, credential, fetch: globalThis.fetch });
    } catch (cause) {
      // An unopenable row still leaves Kinu; its grant cannot be revoked from here.
      this.dropCredential(key);
      failures = [toKinuError({ doing: 'reading the credential to revoke it', cause, otherwise: 'io' })];
    }

    if (failures.length === 0) {
      this.host.sqlx(`DELETE FROM user_unrevoked_grants WHERE key = ?`, key);

      return;
    }

    for (const failure of failures) diagnostics.failure('credential.revoke_failed', failure, { credentialKey: key });

    this.host.sqlx(
      `INSERT INTO user_unrevoked_grants (key, reasons_json, recorded_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET reasons_json = excluded.reasons_json, recorded_at = excluded.recorded_at`,
      key, JSON.stringify(failures.map((failure) => failure.message)), Date.now(),
    );
  }

  private _credentialsRewrapped: Promise<void> | null = null;

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
    await this.rewrapCredentials();
    const row = this.host.sqlx<{ value: string }>(`SELECT value FROM user_credentials WHERE key = ?`, key)[0];
    const revision = this.credentialRevision(key);

    if (!row) return null;
    let plaintext: string;

    try { plaintext = await (await this.cipher()).open(this.credentialAad(key), row.value); }
    catch (err) {
      throw toKinuError({ doing: `opening the stored credential ${key}`, cause: err, otherwise: 'bad_input' });
    }

    // Through `tolerate`, never a caught parse error: a JSON error message
    // quotes the text it choked on, and that text is the decrypted secret.
    const decoded = tolerate(() => parseJsonValue(plaintext), 'malformed-input');

    if (decoded === undefined) throw new KinuError('bad_input', `the stored credential ${key} did not decode as JSON`);

    return { cred: validateCredential({ key, value: decoded }), revision };
  }

  /** Writes nothing, so {@link commitCredential} can be paired with a fence read in one turn. */
  async sealCredential(key: string, cred: Credential): Promise<string> {
    await this.rewrapCredentials();

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
      `SELECT revision FROM user_credentials_revision WHERE id = 1`,
    )[0]);

    return row.success ? row.output.revision : 0;
  }

  bumpCredentialsRevision(): void {
    this.host.sqlx(
      `INSERT INTO user_credentials_revision (id, revision, updated_at) VALUES (1, 1, ?)
       ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
      Date.now(),
    );
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

  /** Re-seals retired-key rows and a never-sealed store's plaintext once per instance, unless the
   *  marker matches. Unopenable rows are left so only that credential fails. */
  private rewrapCredentials(): Promise<void> {
    this._credentialsRewrapped ??= (async () => {
      const cipher = await this.cipher();

      const marker = this.host.sqlx<{ value: string }>(
        `SELECT value FROM user_schema_meta WHERE key = ?`, CREDENTIAL_ENVELOPE_MARKER,
      )[0];

      if (marker?.value === cipher.keyId) return;
      let clean = true;

      // Only a never-sealed store holds pre-encryption rows.
      const reopen = (aad: string, stored: string): Promise<string> => (
        marker === undefined && !isSealedCredential(stored) ? Promise.resolve(stored) : cipher.open(aad, stored)
      );

      for (const row of this.host.sqlx<{ key: string; value: string }>(`SELECT key, value FROM user_credentials`)) {
        const aad = this.credentialAad(row.key);

        try {
          this.host.sqlx(
            `UPDATE user_credentials SET value = ? WHERE key = ?`,
            await cipher.seal(aad, await reopen(aad, row.value)), row.key,
          );
        } catch (err) {
          clean = false;
          diagnostics.failure('credential.reseal_failed', toKinuError({
            doing: 'resealing a stored credential under the current key',
            cause: err,
            otherwise: 'bad_input',
          }), { credentialKey: row.key });
        }
      }

      for (const row of this.host.sqlx<{ id: string; headers: string }>(
        `SELECT id, headers FROM user_mcp_servers WHERE headers IS NOT NULL`,
      )) {
        const aad = this.mcpHeadersAad(row.id);

        try {
          this.host.sqlx(
            `UPDATE user_mcp_servers SET headers = ? WHERE id = ?`,
            await cipher.seal(aad, await reopen(aad, row.headers)), row.id,
          );
        } catch (err) {
          clean = false;
          diagnostics.failure('mcp.stored_headers_reseal_failed', toKinuError({
            doing: "resealing an MCP server's stored headers under the current key",
            cause: err,
            otherwise: 'bad_input',
          }), { serverId: row.id });
        }
      }

      // Egress secrets share the cipher and must rotate in the same pass as the marker.
      if (!await rewrapEgressSecrets(this.egressVaultDeps(cipher))) clean = false;

      // Rotation drops the retired key based on this marker, so only write it if no row was left.
      if (!clean) return;
      this.host.sqlx(
        `INSERT INTO user_schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        CREDENTIAL_ENVELOPE_MARKER, cipher.keyId,
      );
    })();

    return this._credentialsRewrapped;
  }


  /** MCP headers hold bearer tokens, sealed like credentials; AAD is the server id to prevent
   *  cross-server replay. Null passes through. */
  private mcpHeadersAad(serverId: string): string {
    return `${this.host.ctx.id.toString()}:mcp:${serverId}`;
  }

  async sealMcpHeaders(serverId: string, headers: string | null): Promise<string | null> {
    await this.rewrapCredentials();

    return headers === null ? null : (await this.cipher()).seal(this.mcpHeadersAad(serverId), headers);
  }

  /** Stored headers that do not open reject: sent without them, the request would reach
   * the server unauthenticated and read as a server wanting a login. */
  async openMcpHeaders(serverId: string, stored: string | null): Promise<string | null> {
    await this.rewrapCredentials();

    if (stored === null) return null;

    try { return await (await this.cipher()).open(this.mcpHeadersAad(serverId), stored); }
    catch (err) {
      throw toKinuError({ doing: `opening the stored headers of MCP server ${serverId}`, cause: err, otherwise: 'bad_input' });
    }
  }

  /** AAD names this row in this DO so a ciphertext cannot be replayed elsewhere. */
  private egressVaultDeps(cipher: CredentialCipher): EgressVaultDeps {
    return {
      sql: this.host.ctx.storage.sql,
      cipher,
      aad: (id) => `${this.host.ctx.id.toString()}:egress:${id}`,
    };
  }

  /** The only read-back surface; stored secrets are never returned. */
  async listEgressSecrets(caller: UserCaller): Promise<EgressSecretSummary[]> {
    await this.host.requireTier(caller, 'egress_secrets.manage');

    return listEgressSecrets(this.host.ctx.storage.sql);
  }

  /** The returned `placeholder` is the only thing that may enter the container; rotating an id
   *  keeps its placeholder. */
  async putEgressSecret(caller: UserCaller, input: PutEgressSecretInput): Promise<EgressSecretBinding> {
    await this.host.requireTier(caller, 'egress_secrets.manage');
    await this.rewrapCredentials();

    return putEgressSecret(this.egressVaultDeps(await this.cipher()), input);
  }

  /** A later request carrying the placeholder is refused rather than forwarded with a dummy. */
  async revokeEgressSecret(caller: UserCaller, id: string): Promise<{ revoked: boolean }> {
    await this.host.requireTier(caller, 'egress_secrets.manage');

    return { revoked: revokeEgressSecret(this.host.ctx.storage.sql, id) };
  }

  /**
   * `active` is already grant-filtered (consent); this decides destination per request.
   * The outbound handler presents the owner capability.
   */
  async resolveEgressInjection(
    caller: UserCaller,
    facts: EgressRequestFacts,
    active: readonly EgressSecretBinding[],
  ): Promise<EgressInjectionResult> {
    await this.host.requireTier(caller, 'egress_secrets.inject');
    await this.rewrapCredentials();

    return resolveEgressInjection(this.egressVaultDeps(await this.cipher()), facts, active);
  }

  /** baseURL is not a secret and is absent from listCredentials(); the provider proxy reads it without the login. */
  async getCredentialBaseURL(caller: UserCaller, key: string): Promise<string | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // The my-gateway view uses the same account-scoped /ai/v1 endpoint as Workers AI;
    // only the cf-aig-gateway-id header differs.
    const storedKey = key === CLOUDFLARE_AI_GATEWAY_CRED_KEY ? CLOUDFLARE_OAUTH_CRED_KEY : key;
    const cred = await this.readCredential(storedKey);

    return cred === null ? null : credentialBaseURL(storedKey, cred);
  }

  async getAuthHeaders(caller: UserCaller, key: string, opts?: AuthRequest): Promise<Record<string, string> | null> {
    return (await this.getAuth(caller, key, opts))?.headers ?? null;
  }

  /** What a model call needs of a credential, headers and endpoint, in one round trip. */
  async getAuth(caller: UserCaller, key: string, opts?: AuthRequest): Promise<AuthResolution | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // `cloudflare.ai-gateway` is a derived view of the Cloudflare login: same bearer and refresh,
    // but cf-aig-gateway-id names the user's selected gateway (null until selected).
    const storedKey = key === CLOUDFLARE_AI_GATEWAY_CRED_KEY ? CLOUDFLARE_OAUTH_CRED_KEY : key;
    const stored = await this.readCredentialAt(storedKey);

    if (!stored) return null;
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
    } else if (key === CLOUDFLARE_OAUTH_CRED_KEY) {
      // Use the user's selected gateway if any, otherwise the platform's configured default.
      headers['cf-aig-gateway-id'] = this.selectedAIGatewayId() ?? cloudflareAIGatewayId(this.host.env);
    }

    const baseURL = credentialBaseURL(storedKey, cred);

    return baseURL === null ? { headers } : { headers, baseURL };
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

  async selectAIGateway(caller: UserCaller, gatewayId: string | null): Promise<void> {
    await this.host.requireTier(caller, 'ai_gateway.admin');

    if (gatewayId === null) {
      this.host.sqlx(`DELETE FROM user_config WHERE key = ?`, AI_GATEWAY_CONFIG_KEY);

      return;
    }

    if (!isCloudflareAIGatewayId(gatewayId)) throw new KinuError('bad_input', 'Invalid AI Gateway id.');
    await this.host.setConfig(await ownerCaller(this.host.env), AI_GATEWAY_CONFIG_KEY, gatewayId);
  }

  /** Reads the stored credential only, no API call, so it cannot fail for a reason the user
   * did not cause. */
  async listCloudflareAccounts(caller: UserCaller): Promise<{
    connected: boolean;
    selectedId: string | null;
    accounts: CloudflareAccount[];
  }> {
    await this.host.requireTier(caller, 'ai_gateway.admin');
    const cred = await this.readCredential(CLOUDFLARE_OAUTH_CRED_KEY);

    if (cred?.kind !== 'oauth') return { connected: false, selectedId: null, accounts: [] };

    return {
      connected: true,
      selectedId: accountIdFromCloudflareCredential(cred),
      accounts: cloudflareAccountsFromCredential(cred),
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
    const inFlight = this._refreshing.get(key);

    if (inFlight) return inFlight;
    const task = this.rotateOAuthCredential(key, held, rotate, onRevoked);
    this._refreshing.set(key, task);

    try { return await task; } finally { this._refreshing.delete(key); }
  }

  private readonly _refreshing = new Map<string, Promise<LoginRenewal>>();

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

  async startCodexDeviceFlow(caller: UserCaller): Promise<DeviceCodeStart> {
    await this.host.requireTier(caller, 'subscription_auth');
    const client = createCodexOAuthClient();
    const result = await client.startDeviceFlow();
    // The generation rises in the write itself so two racing starts cannot get the same number.
    this.host.sqlx(
      `INSERT INTO codex_device_flow
         (id, device_auth_id, user_code, poll_interval, portal_url, generation, settled_at)
       VALUES (1, ?, ?, ?, ?, 1, NULL)
       ON CONFLICT(id) DO UPDATE SET
         device_auth_id = excluded.device_auth_id,
         user_code      = excluded.user_code,
         poll_interval  = excluded.poll_interval,
         portal_url     = excluded.portal_url,
         generation     = generation + 1,
         settled_at     = NULL`,
      result.deviceAuthId, result.userCode, result.pollIntervalSec, result.portalURL,
    );

    return result;
  }

  async pollCodexDeviceFlow(caller: UserCaller): Promise<{ connected: boolean; accountId?: string; error?: string }> {
    await this.host.requireTier(caller, 'subscription_auth');

    const row = this.host.sqlx<{ device_auth_id: string; user_code: string; generation: number }>(
      `SELECT device_auth_id, user_code, generation FROM codex_device_flow
       WHERE id = 1 AND settled_at IS NULL`,
    )[0];

    if (!row) return { connected: false, error: 'No device flow in progress: call startCodexDeviceFlow first.' };
    // Both fences must be read before the provider wait.
    const generation = row.generation;
    const revision = this.credentialRevision(CODEX_CRED_KEY);

    const client = createCodexOAuthClient();

    try {
      const poll = await client.pollDeviceFlow(row.device_auth_id, row.user_code);

      if (poll.status === 'pending') return { connected: false };

      if (poll.status === 'expired' || poll.status === 'denied') return { connected: false, error: poll.message };
      const accountId = decodeCodexAccountId(poll.tokens.accessToken);
      const cred = tokensToCredential(poll.tokens, accountId ? { accountId } : undefined);
      const sealed = await this.sealCredential(CODEX_CRED_KEY, cred);

      if (!this.commitCodexDeviceFlow({ generation, revision, kind: cred.kind, sealed })) {
        diagnostics.event('credential.codex_device_flow_superseded', { outcome: 'denied' });

        return {
          connected: false,
          error: 'That Codex sign-in was superseded before it completed: start the connection again.',
        };
      }

      return { connected: true, accountId: accountId ?? undefined };
    } catch (cause) {
      const error = authoredRefusal({ doing: 'checking the Codex sign-in', cause });
      diagnostics.failure('user.codex_poll_failed', error);

      return { connected: false, error: renderThrownChain({ cause: error }) };
    }
  }

  /** Commits credential and flow settlement together; synchronous, with both fences checked
   * before either write, so a poll lands whole against its attempt or not at all. */
  private commitCodexDeviceFlow(input: {
    generation: number; revision: number; kind: Credential['kind']; sealed: string;
  }): boolean {
    const open = this.host.sqlx(
      `SELECT 1 AS x FROM codex_device_flow
       WHERE id = 1 AND generation = ? AND settled_at IS NULL`,
      input.generation,
    ).length > 0;

    if (!open) return false;

    if (!this.commitCredential({
      key: CODEX_CRED_KEY, kind: input.kind, sealed: input.sealed, expectRevision: input.revision,
    })) return false;
    this.host.sqlx(`UPDATE codex_device_flow SET settled_at = ? WHERE id = 1`, Date.now());

    return true;
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

            return { error: renderThrownChain({ cause: error }) };
          },
          onSuccess: (credential) => ({ credential }),
        },
      );

      if ('error' in exchanged) return { connected: false, error: exchanged.error };
      const { credential } = exchanged;
      const refusal = unrenewable(CLAUDE_CRED_KEY, credential);

      if (refusal !== null) return { connected: false, error: `Claude signed you in without a refresh token, so Kinu cannot keep the login: ${refusal}` };
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

  async disconnectCodex(caller: UserCaller): Promise<void> {
    await this.host.requireTier(caller, 'subscription_auth');
    await this.disconnectCredential(CODEX_CRED_KEY);
    // Settled, not deleted: the generation must keep rising, and a poll already waiting on OpenAI
    // must find this attempt closed rather than find no row to fence against.
    this.host.sqlx(`UPDATE codex_device_flow SET settled_at = ? WHERE id = 1 AND settled_at IS NULL`, Date.now());
  }

  async getCodexStatus(caller: UserCaller): Promise<CodexStatus> {
    await this.host.requireTier(caller, 'subscription_auth');
    const cred = await this.readCredential(CODEX_CRED_KEY);

    // Only an open attempt is an in-progress flow; a settled row just keeps the generation rising.
    const flow = this.host.sqlx<{ user_code: string; portal_url: string; poll_interval: number }>(
      `SELECT user_code, portal_url, poll_interval FROM codex_device_flow
       WHERE id = 1 AND settled_at IS NULL`,
    )[0];

    if (cred?.kind === 'oauth') {
      return {
        connected: true,
        accountId: decodeCodexAccountId(cred.accessToken),
        expiresAt: cred.expiresAt ?? null,
        startedFlow: flow
          ? { userCode: flow.user_code, portalURL: flow.portal_url, pollIntervalSec: flow.poll_interval }
          : null,
      };
    }

    return {
      connected: false,
      accountId: null,
      expiresAt: null,
      startedFlow: flow
        ? { userCode: flow.user_code, portalURL: flow.portal_url, pollIntervalSec: flow.poll_interval }
        : null,
    };
  }

  async listConnectedProviders(caller: UserCaller): Promise<ConnectedProvider[]> {
    const creds = this.credentialSummaries(await this.host.requireTier(caller, 'credentials.model'));
    const byKey = new Map(creds.map((c) => [c.key, c]));
    const out: ConnectedProvider[] = [];

    // Built-in providers without credentials are listed by the server; only credential-gated ones here.
    if (byKey.has(CLOUDFLARE_OAUTH_CRED_KEY)) {
      out.push({ id: 'workers-ai', label: 'Cloudflare Workers AI', credentialKeys: [CLOUDFLARE_OAUTH_CRED_KEY] });

      if (this.selectedAIGatewayId()) {
        out.push({ id: 'my-gateway', label: 'Your AI Gateway', credentialKeys: [CLOUDFLARE_OAUTH_CRED_KEY] });
      }
    }

    if (byKey.has(CODEX_CRED_KEY)) out.push({ id: 'codex', label: 'ChatGPT Codex', credentialKeys: [CODEX_CRED_KEY] });

    for (const c of creds) {
      // BYO API keys; display names come from the catalog client-side.
      const bearer = /^([a-z0-9][a-z0-9._-]*)\.bearer$/.exec(c.key);

      if (bearer) {
        out.push({ id: bearer[1], label: bearer[1], credentialKeys: [c.key] });
        continue;
      }

      if (c.key.startsWith('openai-compat.')) {
        const name = c.key.slice('openai-compat.'.length);
        out.push({ id: `openai-compat:${name}`, label: `OpenAI-compatible (${name})`, credentialKeys: [c.key] });
      }
    }

    return out;
  }
}
