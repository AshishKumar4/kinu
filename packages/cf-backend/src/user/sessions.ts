import { parseCliTokenUserId } from '../cli/auth-store';
import {
  getActiveAccessTokenScopes, listAccessTokens as listAccessTokenRows, mintAccessToken as mintAccessTokenRow, revokeAccessToken as revokeAccessTokenRow, verifyAccessToken as verifyAccessTokenRow, type AccessTokenMint, type AccessTokenRecord, type AccessTokenScope, ORCHESTRATOR_AGENT_SLUG, nanoid, ownerCaller, type UserCaller, validateWorkspaceName, randomToken, sha256Hex,
} from '@kinu.run/core';
import { diagnostics, KinuError, tolerate, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  builtinAdmission, createBuiltinInvite, findPasskeyAccount, findPasswordAccount, hasBuiltinOwner, initBuiltinAccounts, invitedEmail, isBuiltinOwner, issuePasskeyChallenge, recordPasskeyUse, registerBuiltinAccount, spendPasskeyChallenge, reserveAttempt, clearAttempts, replacePassword, applyReset, listBuiltinAccounts, resetAccount, type Admission, type AttemptBucket, type BuiltinSql, type ChallengePurpose, type Grant, type NewBuiltinAccount, type NewInvite, type PasskeyAccount, type PasswordAccount, type PasswordHash, type PendingChallenge, type ListedAccount, type Reset, type SigningAccount,
} from '@kinu.run/core/identity';
import type { UserProfile } from './profile';
import { singletonValue, type UserObjectHost } from './user-host';

const CLI_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const CLI_AGENT_CONNECT_TICKET_TTL_MS = 60 * 1000;

export const CLI_AGENT_WEBSOCKET_CAPABILITY = 'agent.websocket' as const;

/** A CLI device-code approval redeemed twice; the poll route answers it as already-delivered.
 * Crosses the DO RPC boundary as its message. */
class CliAuthorizationSpentError extends Error {
  constructor(options: ErrorOptions) {
    super('That CLI authorization has already been redeemed.', options);
    this.name = 'CliAuthorizationSpentError';
  }
}

export interface CliTokenVerification {
  ok: boolean;
  user?: { id: string; email: string; displayName: string | null };
  tokenHash?: string;
  expiresAt?: number;
  /** Present only for scoped `pta_…` access tokens; session tokens are unscoped. */
  scopes?: AccessTokenScope[];
  error?: string;
}

export interface CliAgentConnectTicketVerification {
  ok: boolean;
  user?: { id: string; email: string; displayName: string | null };
  tokenHash?: string;
  expiresAt?: number;
  capabilities?: string[];
  /** Present only for tickets minted by a scoped `pta_…` token; the websocket pins to these scopes. */
  scopes?: AccessTokenScope[];
  /** Rides the connection's tags so a later revocation can name every older socket,
   * including one restored from hibernation, whose tags are its only identity. */
  authGeneration?: number;
  error?: string;
}

/** Identity as of the sign-in that minted the cookie. Written once, never updated;
 * a rename lands on the next sign-in. */
export interface BrowserSessionIdentity {
  email: string;
  displayName: string | null;
  provider: string;
  /** `sub`, or the provider's own stable user id. */
  sub: string;
  /** Interactive-auth time in epoch ms, read by step-up checks. */
  authTime: number;
}

/** A revoked or lapsed session has no row and reads as null. `identity` is null only for rows
 * registered before rows carried one; the KV projection is then the only copy. */
export interface LiveBrowserSession {
  identity: BrowserSessionIdentity | null;
}

export function parseCliAgentConnectTicketUserId(ticket: string): string | null {
  const match = /^pat_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(ticket);

  return match?.[1] ?? null;
}

function cleanCliTokenLabel(label?: string): string {
  const trimmed = (label ?? '').trim().replace(/\s+/g, ' ');

  return trimmed ? trimmed.slice(0, 80) : 'Kinu CLI';
}

function parseCapabilityList(value: string): string[] {
  const parsed = v.safeParse(v.array(v.string()), tolerate(() => JSON.parse(value), 'malformed-input'));

  return parsed.success ? parsed.output : [];
}

export interface UserSessionsHost extends Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier' | 'sqlx'> {
  readonly sql: BuiltinSql;
  accountName(): string;
  getProfile(caller: UserCaller): Promise<UserProfile | null>;
  workspaceRegistered(name: string): boolean;
}

/** The account's sign-ins, sessions, tokens and connect tickets. */
export class UserSessions {
  constructor(private readonly host: UserSessionsHost) {}

  /** Called before the cookie is issued. An existing hash throws; the caller compensates. */
  async registerBrowserSession(
    caller: UserCaller,
    tokenHash: string,
    expiresAt: number,
    identity: BrowserSessionIdentity & { credentialGeneration?: number },
  ): Promise<void> {
    await this.host.requireTier(caller, 'auth_tokens');
    this.host.sqlx(
      `INSERT INTO user_browser_sessions
         (token_hash, expires_at, email, display_name, provider, provider_sub, auth_time)
       SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE ? >= COALESCE((SELECT generation FROM user_credential_floor WHERE id = 1), 0)`,
      tokenHash, expiresAt,
      identity.email, identity.displayName, identity.provider, identity.sub, identity.authTime, identity.credentialGeneration ?? 0,
    );
  }

  /** This cookie's session, or null when not live. Expired rows are deleted in the same
   * transaction as the read, so expiry needs no sweeper or alarm. */
  async verifyBrowserSession(caller: UserCaller, tokenHash: string): Promise<LiveBrowserSession | null> {
    await this.host.requireTier(caller, 'auth_tokens');

    return this.host.ctx.storage.transactionSync(() => {
      this.host.ctx.storage.sql.exec(`DELETE FROM user_browser_sessions WHERE expires_at <= ?`, Date.now());

      const row = this.host.ctx.storage.sql.exec<{
        email: string | null;
        display_name: string | null;
        provider: string | null;
        provider_sub: string | null;
        auth_time: number | null;
      }>(
        `SELECT email, display_name, provider, provider_sub, auth_time
           FROM user_browser_sessions WHERE token_hash = ? LIMIT 1`, tokenHash,
      ).toArray()[0];

      if (!row) return null;

      // All five columns come from one INSERT, so they are present or absent together;
      // an older row without them carries no identity rather than half of one.
      if (row.email === null || row.provider === null || row.provider_sub === null || row.auth_time === null) {
        return { identity: null };
      }

      return {
        identity: {
          email: row.email,
          displayName: row.display_name,
          provider: row.provider,
          sub: row.provider_sub,
          authTime: row.auth_time,
        },
      };
    });
  }

  private builtinSql(): BuiltinSql {
    const sql = this.host.sql;

    initBuiltinAccounts(sql);

    return sql;
  }

  async builtinHasOwner(caller: UserCaller): Promise<boolean> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return hasBuiltinOwner(this.builtinSql());
  }

  async builtinIsOwner(caller: UserCaller, userId: string): Promise<boolean> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return isBuiltinOwner(this.builtinSql(), userId);
  }

  async builtinAdmissible(caller: UserCaller, request: Pick<NewBuiltinAccount, 'email' | 'grant'>): Promise<Admission> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return builtinAdmission(this.builtinSql(), request, Date.now());
  }

  async builtinReserveAttempt(caller: UserCaller, buckets: readonly AttemptBucket[]): Promise<number> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return reserveAttempt(this.builtinSql(), buckets, Date.now());
  }

  async builtinReplacePassword(caller: UserCaller, userId: string, password: PasswordHash): Promise<void> {
    await this.host.requireTier(caller, 'builtin_accounts');
    replacePassword(this.builtinSql(), userId, password);
  }

  async builtinResetAccount(caller: UserCaller, grant: Grant): Promise<SigningAccount | null> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return resetAccount(this.builtinSql(), grant, Date.now());
  }

  async builtinApplyReset(caller: UserCaller, reset: Reset): Promise<SigningAccount | null> {
    return this.builtinWrite(caller, (sql, now) => applyReset(sql, reset, now));
  }

  private async builtinWrite<Result>(caller: UserCaller, write: (sql: BuiltinSql, now: number) => Result): Promise<Result> {
    await this.host.requireTier(caller, 'builtin_accounts');
    const sql = this.builtinSql();

    return this.host.ctx.storage.transactionSync(() => write(sql, Date.now()));
  }

  async builtinListAccounts(caller: UserCaller): Promise<ListedAccount[]> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return listBuiltinAccounts(this.builtinSql());
  }

  async builtinClearAttempts(caller: UserCaller, keys: readonly string[]): Promise<void> {
    await this.host.requireTier(caller, 'builtin_accounts');
    clearAttempts(this.builtinSql(), keys);
  }

  async builtinInvitedEmail(caller: UserCaller, inviteHash: string): Promise<string | null> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return invitedEmail(this.builtinSql(), inviteHash, Date.now());
  }

  async builtinRegister(caller: UserCaller, account: NewBuiltinAccount): Promise<Admission> {
    return this.builtinWrite(caller, (sql, now) => registerBuiltinAccount(sql, account, now));
  }

  async builtinPasswordAccount(caller: UserCaller, email: string): Promise<PasswordAccount | null> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return findPasswordAccount(this.builtinSql(), email);
  }

  async builtinPasskeyAccount(caller: UserCaller, credentialId: string): Promise<PasskeyAccount | null> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return findPasskeyAccount(this.builtinSql(), credentialId);
  }

  async builtinRecordPasskeyUse(caller: UserCaller, credentialId: string, counter: number): Promise<void> {
    await this.host.requireTier(caller, 'builtin_accounts');
    recordPasskeyUse(this.builtinSql(), credentialId, counter);
  }

  async builtinIssueChallenge(caller: UserCaller, challenge: string, pending: PendingChallenge, expiresAt: number): Promise<void> {
    await this.host.requireTier(caller, 'builtin_accounts');
    issuePasskeyChallenge(this.builtinSql(), challenge, pending, expiresAt);
  }

  async builtinSpendChallenge(caller: UserCaller, challenge: string, purposes: readonly ChallengePurpose[]): Promise<PendingChallenge | null> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return spendPasskeyChallenge(this.builtinSql(), challenge, purposes, Date.now());
  }

  async builtinCreateInvite(caller: UserCaller, invite: NewInvite): Promise<boolean> {
    await this.host.requireTier(caller, 'builtin_accounts');

    return createBuiltinInvite(this.builtinSql(), invite);
  }

  async revokeBrowserSession(caller: UserCaller, tokenHash: string): Promise<void> {
    await this.host.requireTier(caller, 'auth_tokens');
    this.host.sqlx(`DELETE FROM user_browser_sessions WHERE token_hash = ?`, tokenHash);
    await this.pushSessionSocketRevocation(tokenHash);
  }

  /** Close every websocket that named this session at upgrade. Best-effort, like the CLI socket push. */
  private async pushSessionSocketRevocation(tokenHash: string): Promise<void> {
    const workspaces = this.host.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces
       WHERE delete_pending = 0 AND create_pending = 0`,
    ).map((row) => row.name);

    const settled = await Promise.allSettled(workspaces.map((name) => this.host.env.OrchestratorAgent
      .get(this.host.env.OrchestratorAgent.idFromName(name))
      .closeRevokedSessionSockets(tokenHash)));

    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') continue;
      diagnostics.failure('auth.session_socket_revocation_push_failed', toKinuError({
        doing: 'closing a workspace websocket whose browser session was revoked',
        cause: outcome.reason,
        otherwise: 'unavailable',
      }), { workspace: workspaces[index] });
    }
  }

  /** Frame-time liveness check for a session-authenticated websocket; twin of verifyCliSocketBearer.
   * An unreachable workspace is refused by the caller, not answered here. */
  async verifySocketSession(caller: UserCaller, tokenHash: string): Promise<{ live: boolean }> {
    await this.host.requireTier(caller, 'auth_tokens.socket');

    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return { live: false };

    const row = this.host.sqlx<{ token_hash: string }>(
      `SELECT token_hash FROM user_browser_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1`,
      tokenHash, Date.now(),
    )[0];

    return { live: row !== undefined };
  }

  /**
   * Mint a CLI bearer token; only its hash is stored. userId is embedded so edge routes can
   * reach this UserDO before verification. `authorizationHash` is the approval: the unique index
   * makes the mint single-use, since the KV device-code record has no compare-and-swap.
   */
  async mintCliToken(
    caller: UserCaller, userId: string, authorizationHash: string, label?: string,
  ): Promise<{ token: string; tokenHash: string; expiresAt: number }> {
    await this.host.requireTier(caller, 'auth_tokens');

    if (!/^[a-f0-9]{32}$/.test(userId)) throw new KinuError('bad_input', 'invalid user id');

    if (!/^[a-f0-9]{64}$/.test(authorizationHash)) throw new KinuError('bad_input', 'invalid authorization hash');
    const token = `ptc_${userId}_${nanoid(44)}`;
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const expiresAt = now + CLI_TOKEN_TTL_MS;

    try {
      this.host.sqlx(
        `INSERT INTO user_cli_tokens (token_hash, label, created_at, expires_at, authorization_hash)
         VALUES (?, ?, ?, ?, ?)`,
        tokenHash, cleanCliTokenLabel(label), now, expiresAt, authorizationHash,
      );
    } catch (cause) {
      throw new CliAuthorizationSpentError({ cause });
    }

    return { token, tokenHash, expiresAt };
  }

  async verifyCliToken(caller: UserCaller, token: string): Promise<CliTokenVerification> {
    await this.host.requireTier(caller, 'auth_tokens');
    const userId = parseCliTokenUserId(token);

    if (!userId) return { ok: false, error: 'malformed token' };
    const tokenHash = await sha256Hex(token);

    const row = this.host.sqlx<{ expires_at: number; revoked_at: number | null }>(
      `SELECT expires_at, revoked_at FROM user_cli_tokens WHERE token_hash = ? LIMIT 1`,
      tokenHash,
    )[0];

    if (!row || row.revoked_at !== null) return { ok: false, error: 'invalid token' };
    const now = Date.now();

    if (row.expires_at <= now) return { ok: false, error: 'expired token' };
    this.host.sqlx(`UPDATE user_cli_tokens SET last_used_at = ? WHERE token_hash = ?`, now, tokenHash);
    const profile = await this.host.getProfile(await ownerCaller(this.host.env));

    if (!profile) return { ok: false, error: 'profile missing' };

    return {
      ok: true,
      user: { id: userId, email: profile.email, displayName: profile.displayName },
      tokenHash,
      expiresAt: row.expires_at,
    };
  }

  async listCliTokens(caller: UserCaller): Promise<Array<{ tokenHash: string; label: string; createdAt: number; expiresAt: number; lastUsedAt: number | null }>> {
    await this.host.requireTier(caller, 'auth_tokens');

    return this.host.sqlx<{ token_hash: string; label: string; created_at: number; expires_at: number; last_used_at: number | null }>(
      `SELECT token_hash, label, created_at, expires_at, last_used_at
       FROM user_cli_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    ).map((r) => ({
      tokenHash: r.token_hash,
      label: r.label,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  async revokeCliTokenHash(caller: UserCaller, tokenHash: string): Promise<{ ok: boolean }> {
    await this.host.requireTier(caller, 'auth_tokens');
    this.host.sqlx(`UPDATE user_cli_tokens SET revoked_at = ? WHERE token_hash = ?`, Date.now(), tokenHash);
    await this.retireCliAuthority();

    return { ok: true };
  }

  /** Revoke every active CLI session token, for orphans the caller cannot name.
   * One generation rise covers every socket at once. */
  /** Ends every browser session and CLI token of this account, and refuses any session of a lower generation. */
  async raiseCredentialFloor(caller: UserCaller, generation: number): Promise<void> {
    await this.host.requireTier(caller, 'auth_tokens');

    const sessions = this.host.ctx.storage.transactionSync(() => {
      this.host.sqlx(`INSERT INTO user_credential_floor (id, generation) VALUES (1, ?)
        ON CONFLICT (id) DO UPDATE SET generation = MAX(generation, excluded.generation)`, generation);

      const ended = this.host.sqlx<{ token_hash: string }>(`SELECT token_hash FROM user_browser_sessions`).map((row) => row.token_hash);

      this.host.sqlx(`DELETE FROM user_browser_sessions`);

      return ended;
    });

    await this.revokeAllCliTokens(caller);

    for (const tokenHash of sessions) await this.pushSessionSocketRevocation(tokenHash);
  }

  async revokeAllCliTokens(caller: UserCaller): Promise<{ revoked: number }> {
    await this.host.requireTier(caller, 'auth_tokens');

    const revoked = this.host.sqlx<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_cli_tokens WHERE revoked_at IS NULL`,
    )[0]?.n ?? 0;

    this.host.sqlx(`UPDATE user_cli_tokens SET revoked_at = ? WHERE revoked_at IS NULL`, Date.now());
    await this.retireCliAuthority();

    return { revoked };
  }

  /**
   * Rises with every CLI or access-token revocation. Sockets record the generation they were
   * admitted under, so revocation reaches listening-only sockets that send no frames.
   */
  private authGeneration(): number {
    return singletonValue(this.host.sqlx, 'SELECT generation AS value FROM user_auth_generation WHERE id = 1', v.number()) ?? 0;
  }

  /**
   * The write must precede the fan-out: revocation is durable before any cross-DO await, so a
   * failed push only delays closure; the frame-time check still refuses the next frame.
   */
  private async retireCliAuthority(): Promise<void> {
    this.host.sqlx(
      `INSERT INTO user_auth_generation (id, generation) VALUES (1, 1)
       ON CONFLICT(id) DO UPDATE SET generation = generation + 1`,
    );
    const generation = this.authGeneration();

    const workspaces = this.host.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces
       WHERE delete_pending = 0 AND create_pending = 0`,
    ).map((row) => row.name);

    const settled = await Promise.allSettled(workspaces.map((name) => this.host.env.OrchestratorAgent
      .get(this.host.env.OrchestratorAgent.idFromName(name))
      .closeRevokedCliSockets(generation)));

    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') continue;
      diagnostics.failure('auth.socket_revocation_push_failed', toKinuError({
        doing: 'closing a workspace websocket whose CLI bearer was revoked',
        cause: outcome.reason,
        otherwise: 'unavailable',
      }), { workspace: workspaces[index], generation });
    }
  }

  /**
   * Frame-time check for a bearer-authenticated websocket, returning the generation it must hold.
   * Reads the same rows revocation writes; connect tickets are only checked at upgrade.
   */
  async verifyCliSocketBearer(caller: UserCaller, tokenHash: string): Promise<{
    live: boolean; generation: number; error?: string;
  }> {
    await this.host.requireTier(caller, 'auth_tokens.socket');
    const generation = this.authGeneration();

    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return { live: false, generation, error: 'invalid token hash' };
    const scopes = this.cliBearerScopes(tokenHash, Date.now());

    if (!scopes) return { live: false, generation, error: 'the CLI token behind this connection is no longer valid' };

    return { live: true, generation };
  }

  /** Step-up policy is enforced by the CLI routes; this DO owns hash-only storage and
   * name/scope validation. */
  async mintAccessToken(caller: UserCaller, userId: string, name: string, scopes: readonly string[]): Promise<AccessTokenMint> {
    await this.host.requireTier(caller, 'auth_tokens');

    return mintAccessTokenRow(this.host.ctx.storage.sql, userId, name, scopes);
  }

  /** Same contract as verifyCliToken, with the granted scopes attached. */
  async verifyAccessToken(caller: UserCaller, token: string): Promise<CliTokenVerification> {
    await this.host.requireTier(caller, 'auth_tokens');
    const verified = await verifyAccessTokenRow(this.host.ctx.storage.sql, token);

    if (!verified.ok) return { ok: false, error: verified.error };
    const profile = await this.host.getProfile(await ownerCaller(this.host.env));

    if (!profile) return { ok: false, error: 'profile missing' };

    return {
      ok: true,
      user: { id: verified.userId, email: profile.email, displayName: profile.displayName },
      tokenHash: verified.tokenHash,
      scopes: verified.scopes,
    };
  }

  async listAccessTokens(caller: UserCaller): Promise<AccessTokenRecord[]> {
    await this.host.requireTier(caller, 'auth_tokens');

    return listAccessTokenRows(this.host.ctx.storage.sql);
  }

  async revokeAccessToken(caller: UserCaller, ref: string): Promise<{ ok: true; revoked: boolean }> {
    await this.host.requireTier(caller, 'auth_tokens');
    const result = revokeAccessTokenRow(this.host.ctx.storage.sql, ref);
    // Unconditional: `revoked: false` also covers an already-revoked token, and a spurious
    // generation rise is cheap while a skipped one leaves a socket open.
    await this.retireCliAuthority();

    return result;
  }

  async issueCliAgentConnectTicket(caller: UserCaller, input: {
    userId: string;
    agentClass: typeof ORCHESTRATOR_AGENT_SLUG;
    agentName: string;
    cliTokenHash: string;
    capabilities?: Array<typeof CLI_AGENT_WEBSOCKET_CAPABILITY>;
  }): Promise<{ ok: boolean; ticket?: string; expiresAt?: number; error?: string }> {
    await this.host.requireTier(caller, 'auth_tokens');

    if (!/^[a-f0-9]{32}$/.test(input.userId)) return { ok: false, error: 'invalid user id' };

    if (input.agentClass !== ORCHESTRATOR_AGENT_SLUG) return { ok: false, error: 'invalid agent class' };

    if (!/^[a-f0-9]{64}$/.test(input.cliTokenHash)) return { ok: false, error: 'invalid token hash' };
    validateWorkspaceName(input.agentName);

    if (!this.host.workspaceRegistered(input.agentName)) return { ok: false, error: 'agent not found' };

    const now = Date.now();
    this.host.sqlx(`DELETE FROM cli_agent_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);

    if (!this.cliBearerScopes(input.cliTokenHash, now)) return { ok: false, error: 'invalid CLI token' };

    const capabilities = input.capabilities?.length ? input.capabilities : [CLI_AGENT_WEBSOCKET_CAPABILITY];

    if (!capabilities.includes(CLI_AGENT_WEBSOCKET_CAPABILITY)) return { ok: false, error: 'missing websocket capability' };
    const ticket = `pat_${input.userId}_${randomToken(32)}`;
    const expiresAt = now + CLI_AGENT_CONNECT_TICKET_TTL_MS;
    this.host.sqlx(
      `INSERT INTO cli_agent_connect_tickets
         (ticket_hash, user_id, agent_class, agent_name, cli_token_hash, capabilities, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      await sha256Hex(ticket),
      input.userId,
      input.agentClass,
      input.agentName,
      input.cliTokenHash,
      JSON.stringify(capabilities),
      expiresAt,
    );

    return { ok: true, ticket, expiresAt };
  }

  async verifyCliAgentConnectTicket(
    caller: UserCaller,
    ticket: string,
    expected: {
      userId: string;
      agentClass: typeof ORCHESTRATOR_AGENT_SLUG;
      agentName: string;
      capability: typeof CLI_AGENT_WEBSOCKET_CAPABILITY;
    },
  ): Promise<CliAgentConnectTicketVerification> {
    await this.host.requireTier(caller, 'auth_tokens');
    const hintedUserId = parseCliAgentConnectTicketUserId(ticket);

    if (!hintedUserId) return { ok: false, error: 'malformed ticket' };

    if (hintedUserId !== expected.userId) return { ok: false, error: 'wrong user' };
    validateWorkspaceName(expected.agentName);

    const now = Date.now();
    this.host.sqlx(`DELETE FROM cli_agent_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    const ticketHash = await sha256Hex(ticket);

    const row = this.host.sqlx<{
      user_id: string;
      agent_class: string;
      agent_name: string;
      cli_token_hash: string;
      capabilities: string;
      expires_at: number;
      used_at: number | null;
    }>(
      `SELECT user_id, agent_class, agent_name, cli_token_hash, capabilities, expires_at, used_at
         FROM cli_agent_connect_tickets
        WHERE ticket_hash = ? LIMIT 1`,
      ticketHash,
    )[0];

    if (!row || row.used_at !== null || row.expires_at <= now) return { ok: false, error: 'invalid ticket' };

    if (row.user_id !== expected.userId) return { ok: false, error: 'wrong user' };

    if (row.agent_class !== expected.agentClass) return { ok: false, error: 'wrong agent class' };

    if (row.agent_name !== expected.agentName) return { ok: false, error: 'wrong agent' };
    const capabilities = parseCapabilityList(row.capabilities);

    if (!capabilities.includes(expected.capability)) return { ok: false, error: 'missing capability' };

    this.host.sqlx(`UPDATE cli_agent_connect_tickets SET used_at = ? WHERE ticket_hash = ?`, now, ticketHash);

    if (!this.host.workspaceRegistered(expected.agentName)) return { ok: false, error: 'agent not found' };
    const bearerScopes = this.cliBearerScopes(row.cli_token_hash, now);

    if (!bearerScopes) return { ok: false, error: 'invalid CLI token' };
    const profile = await this.host.getProfile(await ownerCaller(this.host.env));

    if (!profile) return { ok: false, error: 'profile missing' };

    const verification: CliAgentConnectTicketVerification = {
      ok: true,
      user: { id: expected.userId, email: profile.email, displayName: profile.displayName },
      tokenHash: row.cli_token_hash,
      expiresAt: row.expires_at,
      capabilities,
      authGeneration: this.authGeneration(),
    };

    if (bearerScopes !== 'all') verification.scopes = bearerScopes;

    return verification;
  }

  /** Scopes of the ticket's bearer: session token → 'all', access token → its scopes, null if invalid.
   * Resolved at verify time so a revoked access token cannot ride a pre-minted ticket. */
  private cliBearerScopes(tokenHash: string, now: number): 'all' | AccessTokenScope[] | null {
    const session = this.host.sqlx<{ expires_at: number }>(
      `SELECT expires_at FROM user_cli_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
      tokenHash,
    )[0];

    if (session) return session.expires_at > now ? 'all' : null;

    return getActiveAccessTokenScopes(this.host.ctx.storage.sql, tokenHash);
  }
}
