import { parseCliTokenUserId } from '../cli/auth-store';
import {
  objectNamed,
  getActiveAccessTokenScopes, listAccessTokens as listAccessTokenRows, mintAccessToken as mintAccessTokenRow, revokeAccessToken as revokeAccessTokenRow, verifyAccessToken as verifyAccessTokenRow, type AccessTokenMint, type AccessTokenRecord, type AccessTokenScope, nanoid, ownerCaller, type UserCaller, validateWorkspaceName, randomToken, sha256Hex, type UserProfile,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  builtinAdmission, createBuiltinInvite, findPasskeyAccount, findPasswordAccount, hasBuiltinOwner, initBuiltinAccounts, invitedEmail, isBuiltinOwner, issuePasskeyChallenge, recordPasskeyUse, registerBuiltinAccount, spendPasskeyChallenge, reserveAttempt, clearAttempts, removeBuiltinAccount, applyReset, listBuiltinAccounts, resetAccount, type Admission, type AttemptBucket, type BuiltinSql, type ChallengePurpose, type Grant, type NewBuiltinAccount, type NewInvite, type PasskeyAccount, type PasswordAccount, type PendingChallenge, type ListedAccount, type Reset, type SigningAccount,
} from '@kinu.run/core/identity';
import { closeEndedRosterSockets, rosterSockets } from './roster';
import { singletonValue, type SessionStands, type UserObjectHost } from './user-host';
import { SingleUseTickets } from './single-use-tickets';

const CLI_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;



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

/** A revoked or lapsed session has no row and reads as null. */
export interface LiveBrowserSession {
  identity: BrowserSessionIdentity;
}

export function parseCliAgentConnectTicketUserId(ticket: string): string | null {
  const match = /^pat_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(ticket);

  return match?.[1] ?? null;
}

function cleanCliTokenLabel(label?: string): string {
  const trimmed = (label ?? '').trim().replace(/\s+/g, ' ');

  return trimmed ? trimmed.slice(0, 80) : 'Kinu CLI';
}

export interface UserSessionsHost extends Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier' | 'sqlx'> {
  readonly sql: BuiltinSql;
  accountName(): string;
  getProfile(caller: UserCaller): Promise<UserProfile | null>;
  workspaceRegistered(name: string): boolean;
}

/** The account's sign-ins, sessions, tokens and connect tickets. */
export class UserSessions {
  /** Single-use socket tickets a CLI bearer trades for one agent socket: the CLI's websocket to one workspace, the only
   *  thing a ticket opens, so a row holds whose, which workspace, and the bearer that asked. */
  private readonly connectTickets: SingleUseTickets<{ user_id: string; agent_name: string; cli_token_hash: string }>;

  constructor(private readonly host: UserSessionsHost) {
    this.connectTickets = new SingleUseTickets(host.sqlx.bind(host), 'cli_agent_connect_tickets', ['user_id', 'agent_name', 'cli_token_hash']);
  }

  /** Called before the cookie is issued. An existing hash throws; the caller compensates. */
  async registerBrowserSession(
    caller: UserCaller,
    tokenHash: string,
    expiresAt: number,
    identity: BrowserSessionIdentity & { credentialGeneration?: number },
  ): Promise<void> {
    await this.host.requireTier(caller, 'auth_tokens.mint');
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
        email: string;
        display_name: string | null;
        provider: string;
        provider_sub: string;
        auth_time: number;
      }>(
        `SELECT email, display_name, provider, provider_sub, auth_time
           FROM user_browser_sessions WHERE token_hash = ? LIMIT 1`, tokenHash,
      ).toArray()[0];

      if (!row) return null;

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

  /** A deleted account's sign-in, on the deployment's directory (`removeBuiltinAccount`). */
  async builtinRemoveAccount(caller: UserCaller, person: { readonly userId: string; readonly email: string }): Promise<void> {
    await this.builtinWrite(caller, (sql) => { removeBuiltinAccount(sql, person); });
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

  /** Revoke exactly this session; the row's absence is the revocation. The write is durable before the fan-out, so a
   *  failed push cannot keep a socket authorized (see retireCliAuthority). */
  async revokeBrowserSession(caller: UserCaller, tokenHash: string): Promise<void> {
    await this.host.requireTier(caller, 'auth_tokens.revoke');
    this.host.sqlx(`DELETE FROM user_browser_sessions WHERE token_hash = ?`, tokenHash);
    closeEndedRosterSockets(rosterSockets(this.host.ctx), this.sessionStands);
    await this.pushSessionSocketRevocation(tokenHash);
  }

  /** Close every websocket that named this session at upgrade. Best-effort, like the CLI socket push. */
  private async pushSessionSocketRevocation(tokenHash: string): Promise<void> {
    await this.pushToActiveWorkspaces({
      push: (workspace) => workspace.closeRevokedSessionSockets(tokenHash),
      doing: 'closing a workspace websocket whose browser session was revoked',
      failed: (workspace, failure) => { diagnostics.failure('auth.session_socket_revocation_push_failed', failure, { workspace }); },
    });
  }

  /**
   * Ask every live workspace to close the sockets a revocation ended. Best-effort: the revocation is durable before
   * this runs, so a failed push only delays a close; each caller reports its own failures under its own event.
   */
  private async pushToActiveWorkspaces(fanOut: {
    readonly push: (workspace: ReturnType<UserSessionsHost['env']['OrchestratorAgent']['get']>) => Promise<{ closed: number }>;
    readonly doing: string;
    readonly failed: (workspace: string, failure: KinuError) => void;
  }): Promise<void> {
    const workspaces = this.host.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces
       WHERE delete_pending = 0 AND create_pending = 0`,
    ).map((row) => row.name);

    const settled = await Promise.allSettled(workspaces.map((name) => fanOut.push(objectNamed(this.host.env.OrchestratorAgent, name))));

    for (const [index, outcome] of settled.entries()) {
      const workspace = workspaces[index];

      if (outcome.status === 'rejected' && workspace !== undefined) {
        fanOut.failed(workspace, toKinuError({ doing: fanOut.doing, cause: outcome.reason, otherwise: 'unavailable' }));
      }
    }
  }

  /** Whether a session stands: its row is there and has not lapsed. Revocation deletes the row and a raised credential
   * floor deletes every one, so the row is the whole answer. */
  readonly sessionStands: SessionStands = (tokenHash) => this.host.sqlx(
    `SELECT 1 AS stands FROM user_browser_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1`,
    tokenHash, Date.now(),
  ).length > 0;

  /** Frame-time liveness check for a session-authenticated websocket; twin of verifyCliSocketBearer.
   * An unreachable workspace is refused by the caller, not answered here. */
  async verifySocketSession(caller: UserCaller, tokenHash: string): Promise<{ live: boolean }> {
    await this.host.requireTier(caller, 'auth_tokens.socket');

    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return { live: false };

    return { live: this.sessionStands(tokenHash) };
  }

  /**
   * Mint a CLI bearer token; only its hash is stored. userId is embedded so edge routes can
   * reach this UserDO before verification. `authorizationHash` is the approval: the unique index
   * makes the mint single-use, since the KV device-code record has no compare-and-swap.
   */
  async mintCliToken(
    caller: UserCaller, userId: string, authorizationHash: string, label?: string,
  ): Promise<{ token: string; tokenHash: string; expiresAt: number }> {
    await this.host.requireTier(caller, 'auth_tokens.mint');

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
    await this.host.requireTier(caller, 'auth_tokens.revoke');
    this.host.sqlx(`UPDATE user_cli_tokens SET revoked_at = ? WHERE token_hash = ?`, Date.now(), tokenHash);
    await this.retireCliAuthority();

    return { ok: true };
  }

  /** Ends every browser session and CLI token of this account, and refuses any session of a lower generation. */
  async raiseCredentialFloor(caller: UserCaller, generation: number): Promise<void> {
    await this.host.requireTier(caller, 'auth_tokens.revoke');

    const sessions = this.host.ctx.storage.transactionSync(() => {
      this.host.sqlx(`INSERT INTO user_credential_floor (id, generation) VALUES (1, ?)
        ON CONFLICT (id) DO UPDATE SET generation = MAX(generation, excluded.generation)`, generation);

      const ended = this.host.sqlx<{ token_hash: string }>(`SELECT token_hash FROM user_browser_sessions`).map((row) => row.token_hash);

      this.host.sqlx(`DELETE FROM user_browser_sessions`);

      return ended;
    });

    closeEndedRosterSockets(rosterSockets(this.host.ctx), this.sessionStands);

    await this.revokeAllCliTokens(caller);

    for (const tokenHash of sessions) await this.pushSessionSocketRevocation(tokenHash);
  }

  async revokeAllCliTokens(caller: UserCaller): Promise<{ revoked: number }> {
    await this.host.requireTier(caller, 'auth_tokens.revoke');

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

    await this.pushToActiveWorkspaces({
      push: (workspace) => workspace.closeRevokedCliSockets(generation),
      doing: 'closing a workspace websocket whose CLI bearer was revoked',
      failed: (workspace, failure) => { diagnostics.failure('auth.socket_revocation_push_failed', failure, { workspace, generation }); },
    });
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
    await this.host.requireTier(caller, 'auth_tokens.mint');

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
    await this.host.requireTier(caller, 'auth_tokens.revoke');
    const result = revokeAccessTokenRow(this.host.ctx.storage.sql, ref);
    // Unconditional: `revoked: false` also covers an already-revoked token, and a spurious
    // generation rise is cheap while a skipped one leaves a socket open.
    await this.retireCliAuthority();

    return result;
  }

  async issueCliAgentConnectTicket(caller: UserCaller, input: {
    userId: string;
    agentName: string;
    cliTokenHash: string;
  }): Promise<{ ok: boolean; ticket?: string; expiresAt?: number; error?: string }> {
    await this.host.requireTier(caller, 'auth_tokens.mint');

    if (!/^[a-f0-9]{32}$/.test(input.userId)) return { ok: false, error: 'invalid user id' };

    if (!/^[a-f0-9]{64}$/.test(input.cliTokenHash)) return { ok: false, error: 'invalid token hash' };
    validateWorkspaceName(input.agentName);

    if (!this.host.workspaceRegistered(input.agentName)) return { ok: false, error: 'agent not found' };

    const now = Date.now();

    if (!this.cliBearerScopes(input.cliTokenHash, now)) return { ok: false, error: 'invalid CLI token' };

    const ticket = `pat_${input.userId}_${randomToken(32)}`;

    const expiresAt = this.connectTickets.mint(ticket, {
      user_id: input.userId,
      agent_name: input.agentName,
      cli_token_hash: input.cliTokenHash,
    }, now);

    return { ok: true, ticket, expiresAt };
  }

  async verifyCliAgentConnectTicket(
    caller: UserCaller,
    ticket: string,
    expected: { userId: string; agentName: string },
  ): Promise<CliAgentConnectTicketVerification> {
    await this.host.requireTier(caller, 'auth_tokens');
    const hintedUserId = parseCliAgentConnectTicketUserId(ticket);

    if (!hintedUserId) return { ok: false, error: 'malformed ticket' };

    if (hintedUserId !== expected.userId) return { ok: false, error: 'wrong user' };
    validateWorkspaceName(expected.agentName);

    const now = Date.now();
    // Spent on presentation, a match or not: a ticket shown to the wrong agent is burnt, never left live.
    const row = this.connectTickets.spend(ticket, now);

    if (!row) return { ok: false, error: 'invalid ticket' };

    if (row.user_id !== expected.userId) return { ok: false, error: 'wrong user' };

    if (row.agent_name !== expected.agentName) return { ok: false, error: 'wrong agent' };

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
