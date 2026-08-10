/**
 * UserDO — per-user Durable Object. Keyed by the stable Proteus userId.
 * OAuth identities are mapped by the D1 auth store before requests reach this DO.
 *
 * Owns:
 *   - identity (email, displayName, last_seen)
 *   - agent registry (replaces the browser-side localStorage list)
 *   - credentials (single source of truth — Codex OAuth, BYO API keys)
 *   - user-level config (defaults: model, strategy, inference loop, approval mode)
 *   - in-flight Codex device-code state
 *
 * All secrets live here. Orchestrator agents never store credential material;
 * they call `getAuthHeaders(key)` and get ready-to-attach HTTP headers.
 * Token refresh (Codex OAuth) happens atomically inside this DO.
 *
 * Every privileged method takes a `UserCaller` as its FIRST argument and gates
 * on `requireTier` before doing anything else. That is the whole attenuation
 * boundary: it lives where the secrets are, so no workspace-DO code path,
 * crafted tool, or forgotten tool gate can route around it. Worker routes act
 * for the owner whose identity the edge verified and pass `OWNER_SESSION`;
 * agents pass their workspace capability token and get whatever their tier
 * allows. Methods the DO calls on itself pass `OWNER_SESSION` because their
 * public entry point was already gated.
 */
import { Agent, type AgentContext } from "agents";
import { USER_DO_RPC_SURFACE, sealRpcSurface } from "../rpc-surface.js";
import { parseCliTokenUserId } from "../cli/auth-store.js";
import {
  getActiveAccessTokenScopes,
  listAccessTokens as listAccessTokenRows,
  mintAccessToken as mintAccessTokenRow,
  revokeAccessToken as revokeAccessTokenRow,
  verifyAccessToken as verifyAccessTokenRow,
  type AccessTokenMint,
  type AccessTokenRecord,
  type AccessTokenScope,
} from "../cli/access-token-store.js";
import { MCPClientManager } from "agents/mcp/client";
import {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider,
} from "agents/mcp/do-oauth-client-provider";
import {
  DEVICE_CONNECT_PATH,
  NO_DEVICE_CONNECTED,
  ORCHESTRATOR_AGENT_SLUG,
  nanoid,
  createExperienceLibrary,
  createProductChangeStore,
  productChangeSqlFromExec,
  type Credential,
  type ExperienceEntry,
  type ExperienceKind,
  type PublishableCandidate,
  type ProductChangeBoard,
  type ProductChangeApproval,
  type ProductChangeCheck,
  type ProductChangeDetail,
  type ProductChangeRequest,
  type ProductChangeStatus,
  type ProductDeploymentRecord,
  type ProductSourceBinding,
  type ProductSourceBindingInput,
  CODEX_CRED_KEY,
  createCodexOAuthClient,
  decodeCodexAccountId,
  tokensToCredential,
  mcpToolKey,
  type DeviceCodeStart,
  type DeviceCheckpointHint,
} from '@proteus/core';
import { initUserTables } from './schema.js';
import {
  OWNER_SESSION,
  mintWorkspaceCapability,
  requireTier,
  revokeWorkspaceCapability,
  workspaceCapabilityHash,
  type UserCaller,
  type WorkspaceCapability,
  type ResolvedCaller,
} from './workspace-capability.js';
import { DeviceSocketHub, deviceIdFromSocket } from './device-hub.js';
import { credentialToHeaders, accessTokenExpiring, isModelInferenceCredentialKey } from './credential-headers.js';
import { validateCredential, validateCredentialKey, validateWorkspaceName } from './validate.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { resolveWorkspaceTitle } from '../lib/agent-naming.js';
import {
  DEVICE_CONSENT_SCOPE, DEVICE_CONSENT_SCOPE_FULL_FS,
  mergeConsentScope, parseConsentScope, summarizeDeviceAction,
  type DeviceConsentScope,
} from './device-consent.js';
import {
  validateMcpServerInput, parseAllowedTools, mapConnectionStatus,
  parseMcpHeaders, buildMcpHeaderTransportOpts,
  type McpServerSummary, type McpTransport,
  type SerializableToolDescriptor,
} from './mcp.js';
import {
  CLOUDFLARE_AI_GATEWAY_CRED_KEY,
  CLOUDFLARE_OAUTH_CRED_KEY,
  CloudflareOAuthTokenError,
  accountIdFromCloudflareCredential,
  cloudflareAIGatewayId,
  cloudflareWorkersAIBaseURL,
  fetchCloudflareAIGateways,
  isCloudflareAIGatewayId,
  isCloudflareCredentialExpiring,
  isCloudflareCredentialUsable,
  refreshCloudflareCredential,
  type CloudflareAIGatewaySummary,
} from '../lib/cloudflare-oauth.js';

const CLI_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
const DEVICE_CONNECT_TICKET_TTL_MS = 60 * 1000;
const CLI_AGENT_CONNECT_TICKET_TTL_MS = 60 * 1000;
const CLI_AGENT_WEBSOCKET_CAPABILITY = 'agent.websocket' as const;

/** `user_schema_meta` key retiring the one-shot capability backfill. */
const BACKFILL_MARKER = 'workspace_capability_backfill';

/** Stable per-user OAuth callback path. The full URL is built from the
 *  request origin at add-time so it works in any environment without
 *  configuration. NOT the SDK's per-agent default (`/agents/.../callback`)
 *  — every server uses this single per-user endpoint so callback routing
 *  is uniform regardless of which agent triggered the addition. */
const MCP_OAUTH_CALLBACK_PATH = '/api/user/mcp/callback';

interface SqlRow extends Record<string, unknown> {}

export interface UserProfile {
  email: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface WorkspaceEntry {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
  archivedAt: number | null;
}

export interface CredentialSummary {
  key: string;
  kind: 'bearer' | 'oauth' | 'openai-compat';
  createdAt: number;
  updatedAt: number;
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
  /** Credential keys this provider can use. */
  credentialKeys: string[];
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
  /** Present only when the ticket was minted by a scoped `pta_…` access
   *  token — the websocket boundary pins the connection to these scopes.
   *  Interactive session tickets are unscoped. */
  scopes?: AccessTokenScope[];
  error?: string;
}

export function parseCliAgentConnectTicketUserId(ticket: string): string | null {
  const match = /^pat_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(ticket);
  return match?.[1] ?? null;
}

function cleanCliTokenLabel(label?: string): string {
  const trimmed = (label ?? '').trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, 80) : 'Proteus CLI';
}

function parseCapabilityList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export class UserDO extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, USER_DO_RPC_SURFACE);
  }

  private _initialized = false;

  /** Per-user MCP manager. NOTE: distinct from the inherited `Agent.mcp`
   *  — that field is the SDK's agent-scoped manager (we don't use it).
   *  This one is per-user and stores its config in `user_mcp_servers`. */
  private _userMcp: MCPClientManager | null = null;

  /** Monotonic watermark bumped on every MCP config mutation. The
   *  orchestrator's per-turn cache compares this against its last-seen value
   *  to decide whether to refetch tool descriptors. */
  private _userMcpUpdatedAt = 0;

  private ensureInit(): void {
    if (this._initialized) return;
    initUserTables(this.ctx.storage.sql);
    this._initialized = true;
  }

  private sqlx<T = SqlRow>(query: string, ...bindings: unknown[]): T[] {
    this.ensureInit();
    return this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  /** The attenuation gate. First statement of every privileged method below —
   *  the check lives here, next to the secrets, rather than in any caller. */
  private requireTier(caller: UserCaller, capability: WorkspaceCapability): Promise<ResolvedCaller> {
    this.ensureInit();
    return requireTier(this.ctx.storage.sql, caller, capability);
  }

  /** Provisioning in flight, per workspace. A Durable Object serializes nothing
   *  across an outbound RPC await, so two concurrent first-touches would
   *  otherwise each mint and each install, leaving the surviving stored hash
   *  and the surviving installed token from DIFFERENT mints — a workspace that
   *  can never authenticate again and never re-provisions, because it does hold
   *  a token. Coalescing on this map is what makes the handshake atomic. */
  private readonly _provisioning = new Map<string, Promise<void>>();

  /**
   * Reconcile a workspace's identity: the workspace reports the hash of the
   * token it holds, and any disagreement with the registry is repaired by
   * minting a fresh one and installing it.
   *
   * `presentedHash` makes this self-healing in both directions — a workspace
   * that holds nothing, and a workspace holding a token this UserDO no longer
   * recognizes (its storage was reset, or a delete tore down one side only).
   *
   * Deliberately ungated, and the ONLY method that is: this is the bootstrap of
   * workspace identity, so it cannot require identity. It is safe because it
   * hands the secret to nobody — the token is delivered straight into the
   * Durable Object of the named workspace, which must already be in this user's
   * registry. The worst a caller can do is force a rotation, after which both
   * sides still agree and the tier is untouched.
   */
  async ensureWorkspaceCapability(workspaceName: string, presentedHash: string | null): Promise<void> {
    this.ensureInit();
    validateWorkspaceName(workspaceName);
    if (!this.workspaceRegistered(workspaceName)) {
      throw new Error(`Workspace ${workspaceName} is not in your registry.`);
    }
    if (presentedHash && presentedHash === workspaceCapabilityHash(this.ctx.storage.sql, workspaceName)) return;

    const inFlight = this._provisioning.get(workspaceName);
    if (inFlight) return inFlight;
    const task = (async () => {
      const { token } = await mintWorkspaceCapability(this.ctx.storage.sql, workspaceName);
      const workspace = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspaceName));
      await workspace.installWorkspaceCapability(token);
    })();
    this._provisioning.set(workspaceName, task);
    try { await task; } finally { this._provisioning.delete(workspaceName); }
  }

  /** One-shot repair for workspaces that predate this boundary. They are owned
   *  but identity-less, and a workspace runs without anyone opening it — an
   *  alarm, an inbound email, a webhook, a peer's task — so waiting for a human
   *  to visit each one would fail those turns. Runs once per user, off the
   *  request's critical path. */
  async backfillWorkspaceCapabilities(caller: UserCaller): Promise<{ provisioned: number }> {
    await this.requireTier(caller, 'workspaces.write');
    if (this.sqlx(`SELECT 1 AS x FROM user_schema_meta WHERE key = ?`, BACKFILL_MARKER)[0]) {
      return { provisioned: 0 };
    }
    const names = this.sqlx<{ name: string }>(`SELECT name FROM user_workspaces`).map((r) => r.name);
    const settled = await Promise.allSettled(names.map(async (name) => {
      // Ask each workspace what it holds so an already-provisioned one is left
      // alone; rotating a live token would invalidate the copies its facets
      // hold until the parent pushes again.
      const stub = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name));
      const presentedHash = await stub.getWorkspaceCapabilityHash();
      await this.ensureWorkspaceCapability(name, presentedHash);
    }));
    const failed = settled.filter((r) => r.status === 'rejected');
    for (const failure of failed) {
      console.warn('[user-do] capability backfill failed for a workspace:', (failure as PromiseRejectedResult).reason);
    }
    // Only a clean sweep retires the marker; a partial one retries next boot.
    if (failed.length === 0) {
      this.sqlx(`INSERT INTO user_schema_meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, BACKFILL_MARKER, String(Date.now()));
    }
    return { provisioned: names.length - failed.length };
  }

  private productChanges() {
    this.ensureInit();
    return createProductChangeStore(productChangeSqlFromExec(this.ctx.storage.sql), { validateAgentName: validateWorkspaceName });
  }

  // ── Profile ────────────────────────────────────────────────────────

  async ensureProfile(caller: UserCaller, email: string, displayName?: string): Promise<UserProfile> {
    await this.requireTier(caller, 'profile');
    const now = Date.now();
    const existing = this.sqlx<{ email: string; display_name: string | null; created_at: number; last_seen_at: number }>(
      `SELECT email, display_name, created_at, last_seen_at FROM user_profile WHERE id = 1`,
    )[0];
    if (existing) {
      this.sqlx(
        `UPDATE user_profile SET last_seen_at = ?, display_name = COALESCE(?, display_name) WHERE id = 1`,
        now, displayName ?? null,
      );
      return {
        email: existing.email,
        displayName: displayName ?? existing.display_name,
        createdAt: existing.created_at,
        lastSeenAt: now,
      };
    }
    this.sqlx(
      `INSERT INTO user_profile (id, email, display_name, created_at, last_seen_at) VALUES (1, ?, ?, ?, ?)`,
      email, displayName ?? null, now, now,
    );
    return { email, displayName: displayName ?? null, createdAt: now, lastSeenAt: now };
  }

  async getProfile(caller: UserCaller): Promise<UserProfile | null> {
    await this.requireTier(caller, 'profile');
    const row = this.sqlx<{ email: string; display_name: string | null; created_at: number; last_seen_at: number }>(
      `SELECT email, display_name, created_at, last_seen_at FROM user_profile WHERE id = 1`,
    )[0];
    if (!row) return null;
    return {
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  // ── Workspace registry ─────────────────────────────────────────────

  async listWorkspaces(caller: UserCaller): Promise<WorkspaceEntry[]> {
    await this.requireTier(caller, 'workspaces.read');
    return this.sqlx<{ name: string; display_name: string; created_at: number; last_visited: number; archived_at: number | null }>(
      `SELECT name, display_name, created_at, last_visited, archived_at
       FROM user_workspaces WHERE archived_at IS NULL ORDER BY last_visited DESC`,
    ).map((r) => ({
      name: r.name,
      displayName: r.display_name,
      createdAt: r.created_at,
      lastVisited: r.last_visited,
      archivedAt: r.archived_at,
    }));
  }

  /** Insert-or-resurrect a roster row. `existed` reports whether ANY row
   *  (archived included — a name conflict un-archives) was already there, so
   *  a failed create can roll back ONLY rows it actually inserted. */
  async registerWorkspace(caller: UserCaller, name: string, displayName?: string, purpose?: string): Promise<{ entry: WorkspaceEntry; existed: boolean }> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    const now = Date.now();
    const existing = this.sqlx<{ display_name: string }>(
      `SELECT display_name FROM user_workspaces WHERE name = ?`, name,
    )[0];
    const title = resolveWorkspaceTitle({
      explicit: displayName, existing: existing?.display_name, purpose, slug: name,
    });
    this.sqlx(
      `INSERT INTO user_workspaces (name, display_name, created_at, last_visited)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         display_name = excluded.display_name,
         last_visited = excluded.last_visited,
         archived_at  = NULL`,
      name, title, now, now,
    );
    return {
      entry: { name, displayName: title, createdAt: now, lastVisited: now, archivedAt: null },
      existed: !!existing,
    };
  }

  async touchWorkspace(caller: UserCaller, name: string): Promise<void> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    this.sqlx(`UPDATE user_workspaces SET last_visited = ? WHERE name = ?`, Date.now(), name);
  }

  async removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) throw new Error('invalid owner user id');
    // Tear down the agent's Durable Object (storage, alarm, sandbox) BEFORE
    // dropping it from the registry — otherwise the DO's SQLite (conversation,
    // model, scaffold, triggers) survives and a same-name recreate inherits
    // stale state, and its alarm keeps firing. Best-effort: the registry row is
    // removed even if teardown fails.
    try {
      const stub = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name));
      await stub.destroyAgent(ownerUserId);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'destroyed') {
        console.warn('[proteus] removeWorkspace: agent teardown failed:', err instanceof Error ? err.message : err);
      }
    }
    this.sqlx(`DELETE FROM user_workspaces WHERE name = ?`, name);
    // The workspace's identity dies with it, so a same-name recreate is issued
    // a fresh secret rather than inheriting this one's.
    revokeWorkspaceCapability(this.ctx.storage.sql, name);
  }

  /** Update only the roster display name — keeps the Sidebar in sync with the
   *  agent's own `agent_config.display_name` (e.g. after AI auto-titling). */
  async setWorkspaceDisplayName(caller: UserCaller, name: string, displayName: string): Promise<void> {
    const resolved = await this.requireTier(caller, 'workspaces.rename_self');
    validateWorkspaceName(name);
    // Workspace-scoped by construction: an agent renames itself, never a
    // sibling. This is what makes rename safe to keep at the `shared` tier.
    if (resolved.kind === 'workspace' && resolved.workspace !== name) {
      throw new Error(`Workspace "${resolved.workspace}" may only rename itself.`);
    }
    this.sqlx(`UPDATE user_workspaces SET display_name = ? WHERE name = ?`, displayName, name);
  }

  async hasWorkspace(caller: UserCaller, name: string): Promise<boolean> {
    await this.requireTier(caller, 'workspaces.read');
    return this.workspaceRegistered(name);
  }

  /** Registry membership, ungated — the internal read behind `hasWorkspace`
   *  and the ticket flows, whose own entry points are already gated. */
  private workspaceRegistered(name: string): boolean {
    validateWorkspaceName(name);
    const row = this.sqlx(`SELECT 1 AS x FROM user_workspaces WHERE name = ? AND archived_at IS NULL`, name)[0];
    return !!row;
  }

  // ── Peer-messaging grants (cross-owner, default deny) ──────────────

  /** Read by the receiving agent's `receivePeerMessage` — whether a foreign
   *  sender may deliver into this user's agents. Same-owner peers never need
   *  a grant (ownership is checked before this). */
  async hasPeerGrant(caller: UserCaller, senderAgentName: string, senderUserId: string): Promise<boolean> {
    await this.requireTier(caller, 'peers.grants');
    const row = this.sqlx(
      `SELECT 1 AS x FROM user_peer_grants WHERE sender_user_id = ? AND sender_agent_name = ?`,
      senderUserId, senderAgentName,
    )[0];
    return !!row;
  }


  // ── CLI auth tokens ────────────────────────────────────────────────

  /** Mint a CLI bearer token after browser approval. The raw token is returned
   *  once to the CLI; only its hash is stored. The userId is embedded solely so
   *  edge routes can route directly to the correct UserDO before verification. */
  async mintCliToken(caller: UserCaller, userId: string, label?: string): Promise<{ token: string; tokenHash: string; expiresAt: number }> {
    await this.requireTier(caller, 'auth_tokens');
    if (!/^[a-f0-9]{32}$/.test(userId)) throw new Error('invalid user id');
    const token = `ptc_${userId}_${nanoid(44)}`;
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const expiresAt = now + CLI_TOKEN_TTL_MS;
    this.sqlx(
      `INSERT INTO user_cli_tokens (token_hash, label, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      tokenHash, cleanCliTokenLabel(label), now, expiresAt,
    );
    return { token, tokenHash, expiresAt };
  }

  /** Verify a CLI bearer token. Called by Worker HTTP routes after routing to
   *  this UserDO via the user id embedded in the token. */
  async verifyCliToken(caller: UserCaller, token: string): Promise<CliTokenVerification> {
    await this.requireTier(caller, 'auth_tokens');
    const userId = parseCliTokenUserId(token);
    if (!userId) return { ok: false, error: 'malformed token' };
    const tokenHash = await sha256Hex(token);
    const row = this.sqlx<{ expires_at: number; revoked_at: number | null }>(
      `SELECT expires_at, revoked_at FROM user_cli_tokens WHERE token_hash = ? LIMIT 1`,
      tokenHash,
    )[0];
    if (!row || row.revoked_at !== null) return { ok: false, error: 'invalid token' };
    const now = Date.now();
    if (row.expires_at <= now) return { ok: false, error: 'expired token' };
    this.sqlx(`UPDATE user_cli_tokens SET last_used_at = ? WHERE token_hash = ?`, now, tokenHash);
    const profile = await this.getProfile(OWNER_SESSION);
    if (!profile) return { ok: false, error: 'profile missing' };
    return {
      ok: true,
      user: { id: userId, email: profile.email, displayName: profile.displayName },
      tokenHash,
      expiresAt: row.expires_at,
    };
  }

  async listCliTokens(caller: UserCaller): Promise<Array<{ tokenHash: string; label: string; createdAt: number; expiresAt: number; lastUsedAt: number | null }>> {
    await this.requireTier(caller, 'auth_tokens');
    return this.sqlx<{ token_hash: string; label: string; created_at: number; expires_at: number; last_used_at: number | null }>(
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
    await this.requireTier(caller, 'auth_tokens');
    this.sqlx(`UPDATE user_cli_tokens SET revoked_at = ? WHERE token_hash = ?`, Date.now(), tokenHash);
    return { ok: true };
  }

  // ── CI access tokens (long-lived, scoped `pta_…` bearers) ──────────

  /** Mint a scoped access token. The step-up policy (interactive session
   *  token, freshly minted) is enforced by the CLI routes; this DO owns the
   *  hash-only storage plus name/scope validation. */
  async mintAccessToken(caller: UserCaller, userId: string, name: string, scopes: readonly string[]): Promise<AccessTokenMint> {
    await this.requireTier(caller, 'auth_tokens');
    return mintAccessTokenRow(this.ctx.storage.sql, userId, name, scopes);
  }

  /** Verify a `pta_…` access token presented as a bearer. Same contract as
   *  verifyCliToken, with the granted scopes attached. */
  async verifyAccessToken(caller: UserCaller, token: string): Promise<CliTokenVerification> {
    await this.requireTier(caller, 'auth_tokens');
    const verified = await verifyAccessTokenRow(this.ctx.storage.sql, token);
    if (!verified.ok) return { ok: false, error: verified.error };
    const profile = await this.getProfile(OWNER_SESSION);
    if (!profile) return { ok: false, error: 'profile missing' };
    return {
      ok: true,
      user: { id: verified.userId, email: profile.email, displayName: profile.displayName },
      tokenHash: verified.tokenHash,
      scopes: verified.scopes,
    };
  }

  async listAccessTokens(caller: UserCaller): Promise<AccessTokenRecord[]> {
    await this.requireTier(caller, 'auth_tokens');
    return listAccessTokenRows(this.ctx.storage.sql);
  }

  async revokeAccessToken(caller: UserCaller, ref: string): Promise<{ ok: true; revoked: boolean }> {
    await this.requireTier(caller, 'auth_tokens');
    return revokeAccessTokenRow(this.ctx.storage.sql, ref);
  }

  async issueCliAgentConnectTicket(caller: UserCaller, input: {
    userId: string;
    agentClass: typeof ORCHESTRATOR_AGENT_SLUG;
    agentName: string;
    cliTokenHash: string;
    capabilities?: Array<typeof CLI_AGENT_WEBSOCKET_CAPABILITY>;
  }): Promise<{ ok: boolean; ticket?: string; expiresAt?: number; error?: string }> {
    await this.requireTier(caller, 'auth_tokens');
    if (!/^[a-f0-9]{32}$/.test(input.userId)) return { ok: false, error: 'invalid user id' };
    if (input.agentClass !== ORCHESTRATOR_AGENT_SLUG) return { ok: false, error: 'invalid agent class' };
    if (!/^[a-f0-9]{64}$/.test(input.cliTokenHash)) return { ok: false, error: 'invalid token hash' };
    validateWorkspaceName(input.agentName);
    if (!this.workspaceRegistered(input.agentName)) return { ok: false, error: 'agent not found' };

    const now = Date.now();
    this.sqlx(`DELETE FROM cli_agent_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    if (!this.cliBearerScopes(input.cliTokenHash, now)) return { ok: false, error: 'invalid CLI token' };

    const capabilities = input.capabilities?.length ? input.capabilities : [CLI_AGENT_WEBSOCKET_CAPABILITY];
    if (!capabilities.includes(CLI_AGENT_WEBSOCKET_CAPABILITY)) return { ok: false, error: 'missing websocket capability' };
    const ticket = `pat_${input.userId}_${randomToken(32)}`;
    const expiresAt = now + CLI_AGENT_CONNECT_TICKET_TTL_MS;
    this.sqlx(
      `INSERT INTO cli_agent_connect_tickets
         (ticket_hash, user_id, agent_class, agent_name, cli_token_hash, capabilities, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      await sha256Hex(ticket),
      input.userId,
      input.agentClass,
      input.agentName,
      input.cliTokenHash,
      JSON.stringify(capabilities),
      now,
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
    await this.requireTier(caller, 'auth_tokens');
    const hintedUserId = parseCliAgentConnectTicketUserId(ticket);
    if (!hintedUserId) return { ok: false, error: 'malformed ticket' };
    if (hintedUserId !== expected.userId) return { ok: false, error: 'wrong user' };
    validateWorkspaceName(expected.agentName);

    const now = Date.now();
    this.sqlx(`DELETE FROM cli_agent_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    const ticketHash = await sha256Hex(ticket);
    const row = this.sqlx<{
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

    this.sqlx(`UPDATE cli_agent_connect_tickets SET used_at = ? WHERE ticket_hash = ?`, now, ticketHash);
    if (!this.workspaceRegistered(expected.agentName)) return { ok: false, error: 'agent not found' };
    const bearerScopes = this.cliBearerScopes(row.cli_token_hash, now);
    if (!bearerScopes) return { ok: false, error: 'invalid CLI token' };
    const profile = await this.getProfile(OWNER_SESSION);
    if (!profile) return { ok: false, error: 'profile missing' };
    return {
      ok: true,
      user: { id: expected.userId, email: profile.email, displayName: profile.displayName },
      tokenHash: row.cli_token_hash,
      expiresAt: row.expires_at,
      capabilities,
      ...(bearerScopes === 'all' ? {} : { scopes: bearerScopes }),
    };
  }

  /** A connect ticket stays bound to the bearer that minted it: an
   *  interactive session token (expiring, unscoped → 'all') or a live access
   *  token (revocable, pinned to its granted scopes). Null when the bearer is
   *  no longer valid. Scopes are resolved at verify time so a revoked access
   *  token can never ride a pre-minted ticket. */
  private cliBearerScopes(tokenHash: string, now: number): 'all' | AccessTokenScope[] | null {
    const session = this.sqlx<{ expires_at: number }>(
      `SELECT expires_at FROM user_cli_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
      tokenHash,
    )[0];
    if (session) return session.expires_at > now ? 'all' : null;
    return getActiveAccessTokenScopes(this.ctx.storage.sql, tokenHash);
  }

  // ── Connected devices (user-level laptop/PC tunnel hub) ──────────────
  //
  // The reverse-WS tunnel from a user's machine terminates HERE, not on a
  // specific agent — so one `proteus connect` lets every one of the user's
  // agents reach the device. The worker forwards the daemon's upgrade Request
  // to this DO (a WebSocket itself cannot cross the RPC boundary) and the
  // socket is accepted inside fetch() as a hibernatable WebSocket owned by
  // the DeviceSocketHub (tagging, replace-on-reconnect, DeviceTunnel rebuild
  // on wake). Agents reach a device by forwarding to `deviceRpc()` over a
  // DO-to-DO call.
  private readonly _devices = new DeviceSocketHub(this.ctx);

  /** Intercept device-daemon WebSocket upgrades; everything else (agents-SDK
   *  routing, sub-agents) flows to the SDK untouched. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === DEVICE_CONNECT_PATH) return this.acceptDeviceSocket(request, url);
    return super.fetch(request);
  }

  /** Verify + consume the daemon's connect ticket and accept its WebSocket.
   *  Ticket verification lives HERE (not in the worker) so the upgrade is
   *  safe no matter how the request reached this DO. */
  private async acceptDeviceSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const ticket = url.searchParams.get('ticket');
    const verified = ticket ? await this.verifyDeviceConnectTicket(OWNER_SESSION, ticket) : { ok: false as const };
    if (!verified.ok || !verified.deviceId) return new Response('unauthorized', { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this._devices.accept(verified.deviceId, server);
    const now = Date.now();
    this.sqlx(`UPDATE user_devices SET connected_at = ?, last_seen_at = ? WHERE id = ?`, now, now, verified.deviceId);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const deviceId = deviceIdFromSocket(ws);
    if (!deviceId) return super.webSocketMessage(ws, message);
    this.ensureInit();
    const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
    // The daemon's HELLO carries metadata; everything else is an RPC response.
    try {
      const m = JSON.parse(data) as { type?: string; os?: string; hostname?: string };
      if (m.type === 'HELLO') {
        this.sqlx(`UPDATE user_devices SET os = ?, hostname = ?, last_seen_at = ? WHERE id = ?`,
          m.os ?? null, m.hostname ?? null, Date.now(), deviceId);
        return;
      }
    } catch { /* not JSON / not HELLO — fall through to RPC */ }
    this._devices.handleMessage(deviceId, data);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const deviceId = deviceIdFromSocket(ws);
    if (!deviceId) return super.webSocketClose(ws, code, reason, wasClean);
    this.ensureInit();
    this._devices.handleClose(deviceId, ws);
    // A replacing socket may already be live — only then keep connected_at.
    if (!this._devices.isConnected(deviceId)) {
      try { this.sqlx(`UPDATE user_devices SET connected_at = NULL WHERE id = ?`, deviceId); } catch { /* nop */ }
    }
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // Device sockets clean up in webSocketClose, which the runtime fires next.
    if (!deviceIdFromSocket(ws)) return super.webSocketError(ws, error);
  }

  /** Mint a device + connect token. The authenticated CLI receives the raw
   *  token once and writes it to the local daemon config; only its hash is
   *  stored here. */
  async registerDevice(caller: UserCaller, label?: string): Promise<{ deviceId: string; token: string }> {
    await this.requireTier(caller, 'device.manage');
    const deviceId = `dev-${nanoid(10)}`;
    const token = `pdt_${randomToken(32)}`;
    const tokenHash = await sha256Hex(token);
    this.sqlx(
      `INSERT INTO user_devices (id, token_hash, label, created_at) VALUES (?, ?, ?, ?)`,
      deviceId, tokenHash, (label && label.trim()) || 'My device', Date.now(),
    );
    return { deviceId, token };
  }

  /** Verify a presented device token against the stored hash. */
  async verifyDeviceToken(caller: UserCaller, token: string): Promise<{ ok: boolean; deviceId?: string }> {
    await this.requireTier(caller, 'device.manage');
    if (!/^pdt_[A-Za-z0-9_-]{32,}$/.test(token)) return { ok: false };
    const tokenHash = await sha256Hex(token);
    const row = this.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`, tokenHash,
    )[0];
    return row ? { ok: true, deviceId: row.id } : { ok: false };
  }

  /** Exchange the daemon's local long-lived token for a one-minute WebSocket
   *  ticket. The ticket is scoped to this UserDO and can be consumed once. */
  async issueDeviceConnectTicket(caller: UserCaller, token: string): Promise<{ ok: boolean; ticket?: string; expiresAt?: number }> {
    await this.requireTier(caller, 'device.manage');
    const verified = await this.verifyDeviceToken(OWNER_SESSION, token);
    if (!verified.ok || !verified.deviceId) return { ok: false };
    const now = Date.now();
    this.sqlx(`DELETE FROM device_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    const ticket = `pct_${randomToken(32)}`;
    const expiresAt = now + DEVICE_CONNECT_TICKET_TTL_MS;
    this.sqlx(
      `INSERT INTO device_connect_tickets (ticket_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      await sha256Hex(ticket),
      verified.deviceId,
      now,
      expiresAt,
    );
    return { ok: true, ticket, expiresAt };
  }

  /** Consume a short-lived WebSocket connect ticket. */
  async verifyDeviceConnectTicket(caller: UserCaller, ticket: string): Promise<{ ok: boolean; deviceId?: string }> {
    await this.requireTier(caller, 'device.manage');
    if (!/^pct_[A-Za-z0-9_-]{32,}$/.test(ticket)) return { ok: false };
    const now = Date.now();
    this.sqlx(`DELETE FROM device_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    const ticketHash = await sha256Hex(ticket);
    const row = this.sqlx<{ device_id: string; expires_at: number; used_at: number | null }>(
      `SELECT device_id, expires_at, used_at
         FROM device_connect_tickets
        WHERE ticket_hash = ? LIMIT 1`,
      ticketHash,
    )[0];
    if (!row || row.used_at !== null || row.expires_at <= now) return { ok: false };
    this.sqlx(`UPDATE device_connect_tickets SET used_at = ? WHERE ticket_hash = ?`, now, ticketHash);
    const active = this.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, row.device_id,
    )[0];
    return active ? { ok: true, deviceId: row.device_id } : { ok: false };
  }

  private deviceLabel(deviceId: string): string {
    return this.sqlx<{ label: string }>(`SELECT label FROM user_devices WHERE id = ?`, deviceId)[0]?.label ?? 'your device';
  }

  /** Forward a JSON-RPC call to a connected device — the single consent
   *  chokepoint. Every agent call passes its name, so we can enforce the
   *  per-(agent, device) policy: allow → run; deny → block; ask → call back to
   *  the agent to raise a consent card and await the user's decision. */
  async deviceRpc(
    caller: UserCaller,
    method: string,
    params: unknown[],
    opts?: { deviceId?: string; agentName?: string; checkpoint?: DeviceCheckpointHint },
  ): Promise<unknown> {
    const resolved = await this.requireTier(caller, 'device.rpc');
    const deviceId = this._devices.connectedDeviceId(opts?.deviceId);
    if (!deviceId) throw new Error(NO_DEVICE_CONNECTED);
    if (opts?.agentName) {
      // Consent is keyed on the PROVEN workspace, never the claimed name — an
      // agent cannot ride a sibling workspace's remembered grant. Calls that
      // pass no agentName (checkpoint bookkeeping) stay consent-free as before.
      const consentAgent = resolved.kind === 'workspace' ? resolved.workspace : opts.agentName;
      const allowed = await this.checkDeviceConsent(consentAgent, deviceId, method, params);
      if (!allowed) throw new Error('device use was not approved');
    }
    const tunnel = this._devices.tunnel(deviceId);
    if (!tunnel) throw new Error(NO_DEVICE_CONNECTED);
    return tunnel.rpc(method, params, opts?.checkpoint ? { checkpoint: opts.checkpoint } : undefined);
  }

  // ── Device consent (ask-once-then-remember) ──────────────────────────

  private getDeviceConsentPolicy(agentName: string, deviceId: string): { policy: 'allow' | 'deny'; scope: DeviceConsentScope } | null {
    const row = this.sqlx<{ policy: string; scope: string }>(
      `SELECT policy, scope FROM device_consent WHERE agent_name = ? AND device_id = ?`, agentName, deviceId,
    )[0];
    if (row?.policy !== 'allow' && row?.policy !== 'deny') return null;
    return { policy: row.policy, scope: parseConsentScope(row.scope) };
  }

  private setDeviceConsentPolicy(
    agentName: string,
    deviceId: string,
    policy: 'allow' | 'deny',
    lastAction?: { method: string; command: string },
    scope: DeviceConsentScope = DEVICE_CONSENT_SCOPE,
  ): void {
    // Remembering a base action grant must not downgrade full_filesystem.
    const existing = this.sqlx<{ scope: string }>(
      `SELECT scope FROM device_consent WHERE agent_name = ? AND device_id = ?`, agentName, deviceId,
    )[0];
    const effectiveScope = policy === 'allow' ? mergeConsentScope(existing?.scope, scope) : scope;
    this.sqlx(
      `INSERT INTO device_consent
         (agent_name, device_id, policy, scope, last_method, last_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_name, device_id) DO UPDATE SET
         policy = excluded.policy,
         scope = excluded.scope,
         last_method = excluded.last_method,
         last_summary = excluded.last_summary,
         updated_at = excluded.updated_at`,
      agentName, deviceId, policy, effectiveScope,
      lastAction?.method ?? null, lastAction?.command ?? null, Date.now(),
    );
  }

  /** Resolve consent for one agent→device call. Remembered policies short-
   *  circuit (either tier covers device actions — full_filesystem implies the
   *  base grant); otherwise the agent renders a card and the user decides. */
  private async checkDeviceConsent(agentName: string, deviceId: string, method: string, params: unknown[]): Promise<boolean> {
    const policy = this.getDeviceConsentPolicy(agentName, deviceId);
    if (policy?.policy === 'allow') return true;
    if (policy?.policy === 'deny') return false;
    const action = summarizeDeviceAction(method, params);
    let decision: 'once' | 'always' | 'deny';
    try {
      const stub = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(agentName)) as unknown as {
        awaitDeviceConsent(req: {
          deviceId: string;
          deviceLabel: string;
          method: string;
          command: string;
          scope: DeviceConsentScope;
        }): Promise<'once' | 'always' | 'deny'>;
      };
      decision = await stub.awaitDeviceConsent({
        deviceId,
        deviceLabel: this.deviceLabel(deviceId),
        method: action.method,
        command: action.command,
        scope: DEVICE_CONSENT_SCOPE,
      });
    } catch {
      return false; // agent unreachable / timed out → fail closed (not remembered)
    }
    // Only "always" is remembered; "once" and "deny" are per-call decisions.
    if (decision === 'deny') return false;
    if (decision === 'always') this.setDeviceConsentPolicy(agentName, deviceId, 'allow', action);
    return true;
  }

  /** The remembered consent policies (Account settings → Devices — see/revoke which agents may
   *  use a device). */
  async listDeviceConsents(caller: UserCaller): Promise<Array<{
    agentName: string;
    deviceId: string;
    policy: string;
    scope: string;
    lastMethod: string | null;
    lastSummary: string | null;
  }>> {
    await this.requireTier(caller, 'device.consent');
    return this.sqlx<{
      agent_name: string; device_id: string; policy: string; scope: string;
      last_method: string | null; last_summary: string | null;
    }>(
      `SELECT agent_name, device_id, policy, scope, last_method, last_summary
       FROM device_consent ORDER BY updated_at DESC`,
    ).map((r) => ({
      agentName: r.agent_name,
      deviceId: r.device_id,
      policy: r.policy,
      scope: r.scope,
      lastMethod: r.last_method,
      lastSummary: r.last_summary,
    }));
  }

  /** Grant or reduce an agent's consent tier on a device (workspace settings / CLI).
   *  Granting full_filesystem also records the base 'allow' policy. */
  async setDeviceConsentScope(caller: UserCaller, agentName: string, deviceId: string, scope: DeviceConsentScope): Promise<{ ok: boolean }> {
    const resolved = await this.requireTier(caller, 'device.consent');
    // Same rule as the two reads below it: a workspace caller's agent name is
    // the proven one, never the claimed one. The owner's settings route grants
    // on any of their workspaces and is unaffected.
    const target = resolved.kind === 'workspace' ? resolved.workspace : agentName;
    if (scope !== DEVICE_CONSENT_SCOPE && scope !== DEVICE_CONSENT_SCOPE_FULL_FS) {
      return { ok: false };
    }
    // An explicit tier choice overrides the no-downgrade merge.
    this.sqlx(
      `INSERT INTO device_consent (agent_name, device_id, policy, scope, updated_at)
       VALUES (?, ?, 'allow', ?, ?)
       ON CONFLICT(agent_name, device_id) DO UPDATE SET
         policy = 'allow', scope = excluded.scope, updated_at = excluded.updated_at`,
      target, deviceId, scope, Date.now(),
    );
    return { ok: true };
  }

  /** The /pc mount's path-scope check: does this agent hold the
   *  full-filesystem tier on the currently connected device? */
  async getDeviceFsConsent(caller: UserCaller, agentName: string): Promise<{ fullFilesystem: boolean }> {
    const resolved = await this.requireTier(caller, 'device.consent');
    const deviceId = this._devices.connectedDeviceId();
    if (!deviceId) return { fullFilesystem: false };
    const policy = this.getDeviceConsentPolicy(
      resolved.kind === 'workspace' ? resolved.workspace : agentName, deviceId,
    );
    return {
      fullFilesystem: policy?.policy === 'allow' && policy.scope === DEVICE_CONSENT_SCOPE_FULL_FS,
    };
  }

  /** The user's devices for Account settings → Devices (live-connected flag from the
   *  hibernatable-socket tags). */
  async listDevices(caller: UserCaller): Promise<Array<{
    id: string; label: string; os: string | null; hostname: string | null;
    connected: boolean; createdAt: number; lastSeenAt: number | null;
  }>> {
    await this.requireTier(caller, 'device.manage');
    return this.sqlx<{
      id: string; label: string; os: string | null; hostname: string | null;
      created_at: number; last_seen_at: number | null;
    }>(`SELECT id, label, os, hostname, created_at, last_seen_at FROM user_devices
        WHERE revoked_at IS NULL ORDER BY created_at DESC`)
      .map((r) => ({
        id: r.id, label: r.label, os: r.os, hostname: r.hostname,
        connected: this._devices.isConnected(r.id),
        createdAt: r.created_at, lastSeenAt: r.last_seen_at,
      }));
  }

  /** Revoke a device: drop its live socket + mark the row revoked. */
  async revokeDevice(caller: UserCaller, deviceId: string): Promise<{ ok: boolean }> {
    await this.requireTier(caller, 'device.manage');
    this._devices.close(deviceId, 'device revoked');
    this.sqlx(`UPDATE user_devices SET revoked_at = ?, connected_at = NULL WHERE id = ?`, Date.now(), deviceId);
    return { ok: true };
  }

  // ── Product changes ─────────────────────────────────────────────────

  async upsertProductSourceBinding(caller: UserCaller, input: ProductSourceBindingInput & { id?: string }): Promise<ProductSourceBinding> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().upsertSourceBinding(input);
  }

  async createProductChange(caller: UserCaller, agentName: string, input: { bindingId: string; userPrompt: string; plan?: string | null }): Promise<ProductChangeRequest> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().createChange(agentName, input);
  }

  async updateProductChange(
    caller: UserCaller,
    changeId: string,
    patch: { plan?: string | null; summary?: string | null; patch?: string | null; previewUrl?: string | null },
  ): Promise<ProductChangeRequest> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().updateChange(changeId, patch);
  }

  async transitionProductChange(caller: UserCaller, changeId: string, to: ProductChangeStatus): Promise<ProductChangeRequest> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().transitionChange(changeId, to);
  }

  async recordProductChangeCheck(
    caller: UserCaller,
    changeId: string,
    input: { name: string; status: ProductChangeCheck['status']; stdout?: string | null; stderr?: string | null; durationMs?: number | null },
  ): Promise<ProductChangeCheck> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().recordCheck(changeId, input);
  }

  async requestProductChangeApproval(caller: UserCaller, changeId: string, approvalType: ProductChangeApproval['approvalType']): Promise<ProductChangeApproval> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().requestApproval(changeId, approvalType);
  }

  async decideProductChangeApproval(
    caller: UserCaller,
    approvalId: string,
    decision: 'approved' | 'rejected',
    approvedBy: string,
    note?: string | null,
  ): Promise<ProductChangeApproval> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().decideApproval(approvalId, decision, approvedBy, note);
  }

  async recordProductDeployment(
    caller: UserCaller,
    changeId: string,
    input: { environment: ProductDeploymentRecord['environment']; workerVersionId?: string | null; deploymentId?: string | null; rollbackTarget?: string | null },
  ): Promise<ProductDeploymentRecord> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().recordDeployment(changeId, input);
  }

  async getProductChangeBoard(caller: UserCaller, agentName?: string, limit = 20): Promise<ProductChangeBoard> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().board(agentName, limit);
  }

  /** Full ledger view of one change — the execution engine's read surface. */
  async getProductChangeDetail(caller: UserCaller, changeId: string): Promise<ProductChangeDetail> {
    await this.requireTier(caller, 'product_change');
    return this.productChanges().detail(changeId);
  }

  // ── Experience library (cross-workspace transfer) ───────────────────

  private experienceLibrary() {
    this.ensureInit();
    return createExperienceLibrary(this.ctx.storage.sql);
  }

  /**
   * Publish one artifact this workspace has proven. The source workspace is
   * taken from the PROVEN caller, never from the argument — a workspace can
   * only ever publish under its own name, and an owner session (which is not
   * any workspace) cannot publish at all.
   */
  async publishExperience(caller: UserCaller, candidate: PublishableCandidate): Promise<ExperienceEntry> {
    const resolved = await this.requireTier(caller, 'experience.write');
    if (resolved.kind !== 'workspace') {
      throw new Error('Only a workspace can publish experience; it publishes under its own name.');
    }
    return this.experienceLibrary().publish(candidate, resolved.workspace);
  }

  /** Search the owner's library. The calling workspace's own entries are
   *  excluded — re-importing what you already have is noise, not transfer. */
  async searchExperience(
    caller: UserCaller,
    options: { query?: string; kind?: ExperienceKind; limit?: number } = {},
  ): Promise<ExperienceEntry[]> {
    const resolved = await this.requireTier(caller, 'experience.read');
    return this.experienceLibrary().search({
      ...options,
      ...(resolved.kind === 'workspace' ? { excludeWorkspace: resolved.workspace } : {}),
    });
  }

  async getExperienceEntry(caller: UserCaller, id: string): Promise<ExperienceEntry | null> {
    await this.requireTier(caller, 'experience.read');
    return this.experienceLibrary().get(id);
  }

  // ── Credentials ────────────────────────────────────────────────────

  async listCredentials(caller: UserCaller): Promise<CredentialSummary[]> {
    return this.credentialSummaries(await this.requireTier(caller, 'credentials.model'));
  }

  /** Non-model credentials are cut from a shared workspace's view along with
   *  access to them: the agent must not even learn that the owner holds a
   *  GitHub PAT. Model providers stay listed so the model picker still works. */
  private credentialSummaries(resolved: ResolvedCaller): CredentialSummary[] {
    const attenuated = resolved.kind === 'workspace' && resolved.tier === 'shared';
    return this.sqlx<{ key: string; kind: string; created_at: number; updated_at: number }>(
      `SELECT key, kind, created_at, updated_at FROM user_credentials ORDER BY key`,
    ).filter((r) => !attenuated || isModelInferenceCredentialKey(r.key))
      .map((r) => ({
        key: r.key,
        kind: r.kind as CredentialSummary['kind'],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  /** Model-inference credentials survive tainting — the agent must still be
   *  able to think, and provider headers attach inside trusted DO code without
   *  ever entering LLM context. Everything else in the store is owner-level. */
  private requireCredentialAccess(caller: UserCaller, key: string): Promise<ResolvedCaller> {
    return this.requireTier(caller, isModelInferenceCredentialKey(key) ? 'credentials.model' : 'credentials.other');
  }

  async setCredential(caller: UserCaller, key: string, credentialJson: unknown): Promise<void> {
    await this.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);
    if (key === CLOUDFLARE_AI_GATEWAY_CRED_KEY) {
      throw new Error(`${CLOUDFLARE_AI_GATEWAY_CRED_KEY} is derived from your Cloudflare login and cannot be stored directly.`);
    }
    const cred = validateCredential(credentialJson);
    if (key === CODEX_CRED_KEY && cred.kind === 'oauth' && !cred.refreshToken) {
      throw new Error('codex.oauth requires an OAuth refresh token.');
    }
    const now = Date.now();
    this.sqlx(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value = excluded.value, updated_at = excluded.updated_at`,
      key, cred.kind, JSON.stringify(cred), now, now,
    );
    // Cloudflare login just landed → discover the account's AI Gateways now
    // (single-gateway auto-select lives in listAIGateways), so my-gateway
    // works without a settings visit. listAIGateways never throws.
    if (key === CLOUDFLARE_OAUTH_CRED_KEY) await this.listAIGateways(OWNER_SESSION);
  }

  async deleteCredential(caller: UserCaller, key: string): Promise<void> {
    await this.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);
    this.sqlx(`DELETE FROM user_credentials WHERE key = ?`, key);
  }

  /** Internal read of the raw credential. */
  private getCredentialRow(key: string): Credential | null {
    const row = this.sqlx<{ value: string }>(`SELECT value FROM user_credentials WHERE key = ?`, key)[0];
    if (!row) return null;
    try { return JSON.parse(row.value) as Credential; } catch { return null; }
  }

  /** Expose the baseURL for openai-compat credentials. The orchestrator's
   *  provider deps need this to point the SDK at the right endpoint —
   *  baseURL isn't a secret on its own and won't show up in
   *  listCredentials(). */
  async getCredentialBaseURL(caller: UserCaller, key: string): Promise<string | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // The my-gateway view rides the same account-scoped /ai/v1 endpoint as
    // Workers AI — only the cf-aig-gateway-id header differs.
    const storedKey = key === CLOUDFLARE_AI_GATEWAY_CRED_KEY ? CLOUDFLARE_OAUTH_CRED_KEY : key;
    const cred = this.getCredentialRow(storedKey);
    if (cred?.kind === 'openai-compat') return cred.baseURL;
    if (storedKey === CLOUDFLARE_OAUTH_CRED_KEY && cred?.kind === 'oauth') {
      if (!isCloudflareCredentialUsable(cred)) return null;
      const accountId = accountIdFromCloudflareCredential(cred);
      return accountId ? cloudflareWorkersAIBaseURL(accountId) : null;
    }
    return null;
  }

  /** Returns headers ready to inject into a fetch. Handles Codex OAuth
   *  refresh atomically (DO event loop serializes concurrent calls). */
  async getAuthHeaders(caller: UserCaller, key: string, opts?: { forceRefresh?: boolean }): Promise<Record<string, string> | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // `cloudflare.ai-gateway` is a DERIVED view of the Cloudflare login: same
    // bearer + refresh path, but cf-aig-gateway-id names the user's own
    // selected gateway (null until one is selected — that gates my-gateway).
    const storedKey = key === CLOUDFLARE_AI_GATEWAY_CRED_KEY ? CLOUDFLARE_OAUTH_CRED_KEY : key;
    const stored = this.getCredentialRow(storedKey);
    if (!stored) return null;
    // Explicitly-typed non-null so the conditional refresh-reassignment below
    // doesn't re-widen back to `Credential | null`.
    let cred: Credential = stored;

    // Codex OAuth — auto-refresh if expiring or forced.
    if (storedKey === CODEX_CRED_KEY && cred.kind === 'oauth') {
      const refreshToken = cred.refreshToken;
      if (!refreshToken) return null;
      const needRefresh = opts?.forceRefresh || accessTokenExpiring(cred.accessToken);
      if (needRefresh) {
        const refreshed = await this.refreshCodexInternal({ ...cred, refreshToken });
        if (refreshed) cred = refreshed;
        // If refresh failed we keep using the old (possibly-expired) creds —
        // the caller may still succeed, and if not it gets 401 and a clear
        // signal that re-auth is needed.
      }
    }
    if (storedKey === CLOUDFLARE_OAUTH_CRED_KEY && cred.kind === 'oauth') {
      const needRefresh = opts?.forceRefresh || isCloudflareCredentialExpiring(cred);
      if (needRefresh) {
        if (!cred.refreshToken) return null;
        const refreshed = await this.refreshCloudflareInternal(cred);
        if (refreshed === 'revoked') return null;
        if (refreshed) cred = refreshed;
      }
    }

    try {
      const headers = credentialToHeaders(storedKey, cred);
      if (key === CLOUDFLARE_AI_GATEWAY_CRED_KEY) {
        const gatewayId = this.selectedAIGatewayId();
        if (!gatewayId) return null;
        headers['cf-aig-gateway-id'] = gatewayId;
      } else if (key === CLOUDFLARE_OAUTH_CRED_KEY) {
        // Workers AI traffic routes through the user's selected gateway when
        // they picked one (their caching/logging/limits apply), otherwise the
        // platform's configured default.
        headers['cf-aig-gateway-id'] = this.selectedAIGatewayId() ?? cloudflareAIGatewayId(this.env);
      }
      return headers;
    }
    catch { return null; }
  }

  // ── Cloudflare AI Gateway (the user's own gateway) ───────────────────

  private static readonly AI_GATEWAY_CONFIG_KEY = 'cloudflare_ai_gateway';

  private selectedAIGatewayId(): string | null {
    const row = this.sqlx<{ value: string }>(
      `SELECT value FROM user_config WHERE key = ?`, UserDO.AI_GATEWAY_CONFIG_KEY,
    )[0];
    return row && isCloudflareAIGatewayId(row.value) ? row.value : null;
  }

  /** Fresh (refreshed-if-expiring) access token + account id for management
   *  API calls. Null when no usable Cloudflare credential is stored. */
  private async cloudflareAPICredential(): Promise<{ accessToken: string; accountId: string } | null> {
    const stored = this.getCredentialRow(CLOUDFLARE_OAUTH_CRED_KEY);
    if (stored?.kind !== 'oauth' || !isCloudflareCredentialUsable(stored)) return null;
    let cred = stored;
    if (isCloudflareCredentialExpiring(cred)) {
      const refreshed = await this.refreshCloudflareInternal(cred);
      if (refreshed === 'revoked' || !refreshed) return null;
      cred = refreshed;
    }
    const accountId = accountIdFromCloudflareCredential(cred);
    return accountId ? { accessToken: cred.accessToken, accountId } : null;
  }

  /** The user's AI Gateways + current selection. Zero-friction rule: exactly
   *  one gateway and nothing selected → select it (persisted). Never throws —
   *  discovery failures surface in `error` so login can call this inline. */
  async listAIGateways(caller: UserCaller): Promise<{
    connected: boolean;
    selectedId: string | null;
    gateways: CloudflareAIGatewaySummary[];
    error: string | null;
  }> {
    await this.requireTier(caller, 'ai_gateway.admin');
    let selectedId = this.selectedAIGatewayId();
    const api = await this.cloudflareAPICredential();
    if (!api) return { connected: false, selectedId, gateways: [], error: null };
    try {
      const gateways = await fetchCloudflareAIGateways(api.accountId, api.accessToken);
      if (!selectedId && gateways.length === 1) {
        await this.selectAIGateway(OWNER_SESSION, gateways[0].id);
        selectedId = gateways[0].id;
      }
      return { connected: true, selectedId, gateways, error: null };
    } catch (err) {
      return { connected: true, selectedId, gateways: [], error: (err as Error).message };
    }
  }

  async selectAIGateway(caller: UserCaller, gatewayId: string | null): Promise<void> {
    await this.requireTier(caller, 'ai_gateway.admin');
    if (gatewayId === null) {
      this.sqlx(`DELETE FROM user_config WHERE key = ?`, UserDO.AI_GATEWAY_CONFIG_KEY);
      return;
    }
    if (!isCloudflareAIGatewayId(gatewayId)) throw new Error('Invalid AI Gateway id.');
    await this.setConfig(OWNER_SESSION, UserDO.AI_GATEWAY_CONFIG_KEY, gatewayId);
  }

  /** Returns the rotated credential, `'revoked'` when Cloudflare rejected
   *  the refresh token outright (`invalid_grant`), or null on transient
   *  failure (the current credential stays in place). On `invalid_grant`
   *  the dead refresh token is stripped from storage so the credential
   *  stops counting as usable and the connect CTA resurfaces, instead of
   *  advertising a provider whose every call would 401. */
  private async refreshCloudflareInternal(current: Credential & { kind: 'oauth' }): Promise<(Credential & { kind: 'oauth' }) | 'revoked' | null> {
    try {
      const next = await refreshCloudflareCredential(this.env, current);
      this.sqlx(
        `UPDATE user_credentials SET value = ?, updated_at = ? WHERE key = ?`,
        JSON.stringify(next), Date.now(), CLOUDFLARE_OAUTH_CRED_KEY,
      );
      return next as Credential & { kind: 'oauth' };
    } catch (err) {
      if (err instanceof CloudflareOAuthTokenError && err.oauthError === 'invalid_grant') {
        console.warn('[user-do] cloudflare refresh token revoked; reconnect required:', err.message);
        const { refreshToken: _dead, ...rest } = current;
        this.sqlx(
          `UPDATE user_credentials SET value = ?, updated_at = ? WHERE key = ?`,
          JSON.stringify(rest), Date.now(), CLOUDFLARE_OAUTH_CRED_KEY,
        );
        return 'revoked';
      }
      console.warn('[user-do] cloudflare refresh failed; keeping current credential:', (err as Error).message);
      return null;
    }
  }

  private async refreshCodexInternal(current: Credential & { kind: 'oauth'; refreshToken: string }): Promise<(Credential & { kind: 'oauth' }) | null> {
    const client = createCodexOAuthClient();
    try {
      const fresh = await client.refresh(current.refreshToken);
      const next: Credential = {
        kind: 'oauth',
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        metadata: current.metadata,
      };
      // Persist with refreshed tokens. Keep created_at by ON CONFLICT.
      this.sqlx(
        `UPDATE user_credentials SET value = ?, updated_at = ? WHERE key = ?`,
        JSON.stringify(next), Date.now(), CODEX_CRED_KEY,
      );
      return next as Credential & { kind: 'oauth' };
    } catch (err) {
      console.warn('[user-do] codex refresh failed; keeping current credential:', (err as Error).message);
      return null;
    }
  }

  // ── Codex device flow ──────────────────────────────────────────────

  async startCodexDeviceFlow(caller: UserCaller): Promise<DeviceCodeStart> {
    await this.requireTier(caller, 'codex_auth');
    const client = createCodexOAuthClient();
    const result = await client.startDeviceFlow();
    this.sqlx(`DELETE FROM codex_device_flow`);
    this.sqlx(
      `INSERT INTO codex_device_flow (id, device_auth_id, user_code, poll_interval, portal_url, started_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      result.deviceAuthId, result.userCode, result.pollIntervalSec, result.portalURL, Date.now(),
    );
    return result;
  }

  async pollCodexDeviceFlow(caller: UserCaller): Promise<{ connected: boolean; accountId?: string; error?: string }> {
    await this.requireTier(caller, 'codex_auth');
    const row = this.sqlx<{ device_auth_id: string; user_code: string }>(
      `SELECT device_auth_id, user_code FROM codex_device_flow WHERE id = 1`,
    )[0];
    if (!row) return { connected: false, error: 'No device flow in progress — call startCodexDeviceFlow first.' };

    const client = createCodexOAuthClient();
    try {
      const tokens = await client.pollDeviceFlow(row.device_auth_id, row.user_code);
      if (!tokens) return { connected: false }; // still pending
      const accountId = decodeCodexAccountId(tokens.accessToken);
      const cred = tokensToCredential(tokens, accountId ? { accountId } : undefined);
      const now = Date.now();
      this.sqlx(
        `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value = excluded.value, updated_at = excluded.updated_at`,
        CODEX_CRED_KEY, cred.kind, JSON.stringify(cred), now, now,
      );
      this.sqlx(`DELETE FROM codex_device_flow`);
      return { connected: true, accountId: accountId ?? undefined };
    } catch (err) {
      return { connected: false, error: (err as Error).message };
    }
  }

  async disconnectCodex(caller: UserCaller): Promise<void> {
    await this.requireTier(caller, 'codex_auth');
    this.sqlx(`DELETE FROM user_credentials WHERE key = ?`, CODEX_CRED_KEY);
    this.sqlx(`DELETE FROM codex_device_flow`);
  }

  async getCodexStatus(caller: UserCaller): Promise<CodexStatus> {
    await this.requireTier(caller, 'codex_auth');
    const cred = this.getCredentialRow(CODEX_CRED_KEY);
    const flow = this.sqlx<{ user_code: string; portal_url: string; poll_interval: number }>(
      `SELECT user_code, portal_url, poll_interval FROM codex_device_flow WHERE id = 1`,
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

  // ── User-level config (defaults) ───────────────────────────────────

  async getConfig(caller: UserCaller, key: string): Promise<string | null> {
    await this.requireTier(caller, 'config');
    const row = this.sqlx<{ value: string }>(`SELECT value FROM user_config WHERE key = ?`, key)[0];
    return row?.value ?? null;
  }

  async setConfig(caller: UserCaller, key: string, value: string): Promise<void> {
    await this.requireTier(caller, 'config');
    this.sqlx(
      `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, value, Date.now(),
    );
  }

  async listConfig(caller: UserCaller): Promise<Record<string, string>> {
    await this.requireTier(caller, 'config');
    const rows = this.sqlx<{ key: string; value: string }>(`SELECT key, value FROM user_config`);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ── MCP servers ────────────────────────────────────────────────────

  /** Lazy MCPClientManager construction. The callback URL is built per-add
   *  (it depends on the request origin) so we don't bake it in here. */
  private userMcp(): MCPClientManager {
    if (this._userMcp) return this._userMcp;
    this.ensureInit();
    this._userMcp = new MCPClientManager('proteus-user-mcp', '0.1.0', {
      storage: this.ctx.storage,
      // Override so EVERY server (regardless of when added) uses the same
      // per-user callback URL pattern. The SDK calls this for new connect()s
      // and for restoreConnectionsFromStorage(). The stored callback_url is
      // the source of truth for which path the IdP is told to redirect to,
      // so we pass it through verbatim.
      createAuthProvider: (callbackUrl: string): AgentMcpOAuthProvider =>
        new DurableObjectOAuthClientProvider(
          this.ctx.storage,
          'proteus-user-mcp',
          callbackUrl,
        ),
    });
    return this._userMcp;
  }

  /** Idempotent boot warmup. Called by the routes layer on first hit per
   *  process so MCP connections can re-establish in parallel with the user's
   *  first orchestrator turn, not on its critical path. Fire-and-forget. */
  async userMcp_warmConnections(caller: UserCaller): Promise<{ servers: number }> {
    await this.requireTier(caller, 'mcp.manage');
    const rows = this.sqlx(`SELECT COUNT(*) AS n FROM user_mcp_servers`)[0] as { n: number };
    if (!rows || rows.n === 0) return { servers: 0 };
    try { await this.userMcp().restoreConnectionsFromStorage('proteus-user-mcp'); }
    catch (err) { console.warn('[user-do] userMcp_warmConnections failed:', (err as Error).message); }
    return { servers: rows.n };
  }

  async userMcp_list(caller: UserCaller): Promise<McpServerSummary[]> {
    await this.requireTier(caller, 'mcp.manage');
    const rows = this.sqlx<{
      id: string; name: string; server_url: string; transport: string;
      allowed_tools: string | null; created_at: number; updated_at: number;
    }>(
      `SELECT id, name, server_url, transport, allowed_tools, created_at, updated_at
       FROM user_mcp_servers ORDER BY name`,
    );
    // Touch the manager so the live view of connection state is hydrated.
    // Cheap on cold start (storage scan); idempotent.
    if (rows.length > 0) {
      try { await this.userMcp().restoreConnectionsFromStorage('proteus-user-mcp'); }
      catch { /* connection failures don't block the list */ }
    }
    const connections = this._userMcp?.mcpConnections ?? {};
    return rows.map((r): McpServerSummary => {
      const conn = connections[r.id];
      const status = mapConnectionStatus(conn?.connectionState);
      const allowed = parseAllowedTools(r.allowed_tools);
      const toolsCount = conn?.tools
        ? (allowed
            ? conn.tools.filter((t: { name: string }) => allowed.includes(t.name)).length
            : conn.tools.length)
        : 0;
      // authUrl is set on the auth provider while AUTHENTICATING. The SDK
      // also persists it on the storage row; expose only if currently
      // pending so the UI knows whether to render the "Open authorize" link.
      const authUrl = status === 'authenticating'
        ? (conn?.options?.transport?.authProvider?.authUrl ?? null)
        : null;
      return {
        id: r.id,
        name: r.name,
        serverUrl: r.server_url,
        transport: (r.transport as McpTransport),
        status,
        error: conn?.connectionError ?? null,
        toolsCount,
        authUrl,
        allowedTools: allowed,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  /** Add a new MCP server. `publicOrigin` is the user-facing origin the
   *  Worker should redirect OAuth callbacks to (e.g. `https://proteus.example`).
   *  The routes layer derives it from the inbound request's `Origin` /
   *  `Host` header — UserDO doesn't see the request. */
  async userMcp_add(
    caller: UserCaller,
    input: unknown,
    publicOrigin: string,
  ): Promise<{ id: string; authUrl: string | null }> {
    await this.requireTier(caller, 'mcp.manage');
    const cfg = validateMcpServerInput(input);
    if (typeof publicOrigin !== 'string' || !/^https?:\/\//.test(publicOrigin)) {
      throw new Error('publicOrigin must be a full https?:// origin.');
    }
    this.requireFreeMcpServerName(cfg.name, null);
    const id = nanoid(8);
    const now = Date.now();
    const headersJson = cfg.headers ? JSON.stringify(cfg.headers) : null;
    const allowedJson = cfg.allowedTools ? JSON.stringify(cfg.allowedTools) : null;

    this.sqlx(
      `INSERT INTO user_mcp_servers
         (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, cfg.name, cfg.serverUrl, cfg.transport ?? 'auto',
      headersJson, allowedJson, now, now,
    );
    this._userMcpUpdatedAt = now;

    const callbackUrl = `${publicOrigin.replace(/\/+$/, '')}${MCP_OAUTH_CALLBACK_PATH}`;
    const authProvider = new DurableObjectOAuthClientProvider(
      this.ctx.storage, 'proteus-user-mcp', callbackUrl,
    );
    authProvider.serverId = id;

    // Header passthrough for non-OAuth servers behind private/bearer auth.
    // requestInit.headers is what survives hibernation and authenticates both
    // transports; see buildMcpHeaderTransportOpts.
    const headerOpts = buildMcpHeaderTransportOpts(cfg.headers ?? null) ?? {};

    let authUrl: string | null = null;
    try {
      const mgr = this.userMcp();
      await mgr.registerServer(id, {
        url: cfg.serverUrl,
        name: cfg.name,
        callbackUrl,
        transport: {
          ...headerOpts,
          authProvider,
          type: cfg.transport ?? 'auto',
        },
      });
      const result = await mgr.connectToServer(id);
      if (result.state === 'failed') {
        throw new Error(result.error ?? 'connection failed');
      }
      if (result.state === 'authenticating') {
        authUrl = result.authUrl ?? null;
      } else {
        // Discovery is async; fire-and-forget so the response returns quickly.
        // The next userMcp_list() poll surfaces the discovered tool count.
        void mgr.discoverIfConnected(id).catch(() => undefined);
      }
    } catch (err) {
      // Rollback both our row AND the SDK's storage entry so the user can
      // retry with a corrected URL rather than have a stuck failed entry.
      try { await this.userMcp().removeServer(id); } catch { /* nop */ }
      this.sqlx(`DELETE FROM user_mcp_servers WHERE id = ?`, id);
      this._userMcpUpdatedAt = Date.now();
      throw new Error(`MCP connect failed: ${(err as Error).message}`);
    }
    return { id, authUrl };
  }

  async userMcp_remove(caller: UserCaller, id: string): Promise<void> {
    await this.requireTier(caller, 'mcp.manage');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid server id.');
    try { await this.userMcp().removeServer(id); }
    catch (err) { console.warn('[user-do] removeServer (live):', (err as Error).message); }
    this.sqlx(`DELETE FROM user_mcp_servers WHERE id = ?`, id);
    this._userMcpUpdatedAt = Date.now();
  }

  /** Server names address the tools (`mcp_<server>_<tool>`), so two servers
   *  sharing one name would mint colliding tool keys. The CLI gets this for
   *  free — its config is an `mcpServers` object — so cf enforces it. */
  private requireFreeMcpServerName(name: string, exceptId: string | null): void {
    const taken = this.sqlx<{ id: string }>(
      `SELECT id FROM user_mcp_servers WHERE lower(name) = lower(?)`, name,
    ).some((row) => row.id !== exceptId);
    if (taken) throw new Error(`An MCP server named '${name}' already exists.`);
  }

  /** Patch-update editable fields. `name` and `allowedTools` take effect
   *  without reconnecting (a rename re-keys the tools on the next descriptor
   *  fetch; allowedTools is enforced from SQL at descriptor/dispatch time). A
   *  `headers` change re-registers the live connection — the SSE/HTTP
   *  transport reads its auth headers at connect
   *  time, so a rotated bearer only takes effect (and re-persists into the
   *  SDK's snapshot) after a reconnect. `serverUrl` / `transport` changes still
   *  require remove + re-add (the SDK doesn't support live re-targeting). */
  async userMcp_update(caller: UserCaller, id: string, patch: unknown): Promise<void> {
    await this.requireTier(caller, 'mcp.manage');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid server id.');
    if (!patch || typeof patch !== 'object') throw new Error('patch must be a JSON object.');
    const p = patch as Record<string, unknown>;
    const sets: string[] = [];
    const args: unknown[] = [];
    if (typeof p.name === 'string') {
      if (!p.name.trim() || p.name.length > 64) throw new Error('name must be 1..64 chars.');
      this.requireFreeMcpServerName(p.name.trim(), id);
      sets.push('name = ?'); args.push(p.name.trim());
    }
    if (p.allowedTools !== undefined) {
      if (p.allowedTools === null) {
        sets.push('allowed_tools = ?'); args.push(null);
      } else if (Array.isArray(p.allowedTools) && p.allowedTools.every((t) => typeof t === 'string')) {
        sets.push('allowed_tools = ?'); args.push(JSON.stringify(p.allowedTools));
      } else {
        throw new Error('allowedTools must be string[] or null.');
      }
    }
    if (p.headers !== undefined) {
      if (p.headers === null) {
        sets.push('headers = ?'); args.push(null);
      } else if (
        typeof p.headers === 'object' && !Array.isArray(p.headers)
        && Object.values(p.headers as Record<string, unknown>).every((v) => typeof v === 'string')
      ) {
        sets.push('headers = ?'); args.push(JSON.stringify(p.headers));
      } else {
        throw new Error('headers must be Record<string,string> or null.');
      }
    }
    if (sets.length === 0) return;
    const now = Date.now();
    sets.push('updated_at = ?'); args.push(now);
    args.push(id);
    this.sqlx(`UPDATE user_mcp_servers SET ${sets.join(', ')} WHERE id = ?`, ...args);
    this._userMcpUpdatedAt = now;

    // A headers patch must re-register the live transport (and the SDK's
    // stored snapshot) — writing the SQL column alone never reaches the wire.
    if (p.headers !== undefined) {
      try { await this.reregisterUserMcpServer(id); }
      catch (err) { console.warn('[user-do] userMcp_update header re-register:', (err as Error).message); }
    }
  }

  /** Rebuild a server's live MCP connection from its current `user_mcp_servers`
   *  row. The transport reads auth headers at connect time, so applying a
   *  rotated bearer means tearing down the connection and re-establishing it
   *  with freshly-built transport options (which also re-persists the new
   *  headers into the SDK's `server_options` snapshot). Any OAuth callback URL
   *  is preserved across the re-register. */
  private async reregisterUserMcpServer(id: string): Promise<void> {
    const row = this.sqlx<{ name: string; server_url: string; transport: string; headers: string | null }>(
      `SELECT name, server_url, transport, headers FROM user_mcp_servers WHERE id = ?`, id,
    )[0];
    if (!row) return;
    const mgr = this.userMcp();
    const callbackUrl = mgr.listServers().find((s) => s.id === id)?.callback_url ?? '';
    try { await mgr.removeServer(id); }
    catch (err) { console.warn('[user-do] reregister removeServer:', (err as Error).message); }

    const headerOpts = buildMcpHeaderTransportOpts(parseMcpHeaders(row.headers)) ?? {};
    let authProvider: AgentMcpOAuthProvider | undefined;
    if (callbackUrl) {
      authProvider = new DurableObjectOAuthClientProvider(this.ctx.storage, 'proteus-user-mcp', callbackUrl);
      authProvider.serverId = id;
    }
    await mgr.registerServer(id, {
      url: row.server_url,
      name: row.name,
      callbackUrl,
      transport: {
        ...headerOpts,
        ...(authProvider ? { authProvider } : {}),
        type: (row.transport as McpTransport) ?? 'auto',
      },
    });
    void mgr.establishConnection(id).catch(() => undefined);
  }

  /** Monotonic watermark — the orchestrator caches by this value. */
  async userMcp_updatedAt(caller: UserCaller): Promise<number> {
    await this.requireTier(caller, 'mcp.tools');
    return this._userMcpUpdatedAt;
  }

  /** Serializable tool descriptors for every connected MCP server, filtered
   *  by per-server `allowed_tools`. The orchestrator wraps each into an
   *  AI-SDK Tool whose `execute` closure dispatches back via `userMcp_callTool`. */
  async userMcp_toolDescriptors(caller: UserCaller): Promise<SerializableToolDescriptor[]> {
    await this.requireTier(caller, 'mcp.tools');
    const rows = this.sqlx<{ id: string; name: string; allowed_tools: string | null }>(
      `SELECT id, name, allowed_tools FROM user_mcp_servers`,
    );
    if (rows.length === 0) return [];

    // Ensure connections are restored. Don't await failures — partial
    // descriptors are better than none.
    try {
      await this.userMcp().restoreConnectionsFromStorage('proteus-user-mcp');
      // Cap at 5s so a single slow server can't block a turn indefinitely.
      await this.userMcp().waitForConnections({ timeout: 5_000 });
    } catch (err) {
      console.warn('[user-do] userMcp_toolDescriptors warmup:', (err as Error).message);
    }

    const out: SerializableToolDescriptor[] = [];
    const allowedById = new Map<string, ReadonlySet<string> | null>();
    for (const r of rows) {
      const allowed = parseAllowedTools(r.allowed_tools);
      allowedById.set(r.id, allowed ? new Set(allowed) : null);
    }
    const connections = this._userMcp?.mcpConnections ?? {};
    for (const [id, conn] of Object.entries(connections)) {
      const allowed = allowedById.get(id);
      if (allowed === undefined) continue; // server was just deleted
      const meta = rows.find((r) => r.id === id);
      if (!meta) continue;
      for (const tool of conn.tools) {
        if (allowed && !allowed.has(tool.name)) continue;
        out.push({
          serverId: id,
          serverName: meta.name,
          name: tool.name,
          toolKey: mcpToolKey(meta.name, tool.name),
          description: tool.description,
          title: (tool as { title?: string }).title
            ?? (tool as { annotations?: { title?: string } }).annotations?.title,
          inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
          outputSchema: (tool as { outputSchema?: Record<string, unknown> }).outputSchema,
        });
      }
    }
    return out;
  }

  /** Execute a single MCP tool call. Called over RPC by the orchestrator's
   *  per-tool closure. The result must be JSON-serializable; the SDK already
   *  guarantees this (no closures in CallToolResult). */
  async userMcp_callTool(
    caller: UserCaller,
    serverId: string,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    // Caller identity is proven by the capability token rather than claimed in
    // an argument, so there is no agent name left to spoof: a token exists only
    // for a workspace this user's registry issued one to, and dies with it.
    await this.requireTier(caller, 'mcp.tools');
    if (!this._userMcp) {
      // Cold start: hydrate the manager before dispatching.
      this.userMcp();
      try { await this._userMcp!.restoreConnectionsFromStorage('proteus-user-mcp'); }
      catch (err) { throw new Error(`MCP not ready: ${(err as Error).message}`); }
    }
    // Type-check the server membership inside our SQL so a stale orchestrator
    // closure can't dispatch to a server the user just deleted.
    const row = this.sqlx<{ allowed_tools: string | null }>(
      `SELECT allowed_tools FROM user_mcp_servers WHERE id = ?`, serverId,
    )[0];
    if (!row) throw new Error(`Unknown MCP server: ${serverId}`);
    const allowed = parseAllowedTools(row.allowed_tools);
    if (allowed && !allowed.includes(name)) {
      throw new Error(`Tool '${name}' is not in the allowed_tools list for this server.`);
    }
    const params = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
    const result = await this._userMcp!.callTool({
      serverId, name, arguments: params,
    });
    return result;
  }

  /** OAuth callback receiver. The routes layer matches the incoming
   *  `/api/user/mcp/callback` request and forwards it here verbatim. */
  async userMcp_handleOAuthCallback(caller: UserCaller, url: string): Promise<{ ok: boolean; serverId: string | null; error: string | null }> {
    await this.requireTier(caller, 'mcp.manage');
    try {
      const req = new Request(url);
      const result = await this.userMcp().handleCallbackRequest(req);
      this._userMcpUpdatedAt = Date.now();
      if (result.authSuccess) {
        // Background-establish the connection now that tokens are saved.
        void this.userMcp().establishConnection(result.serverId);
        return { ok: true, serverId: result.serverId, error: null };
      }
      return { ok: false, serverId: result.serverId ?? null, error: result.authError };
    } catch (err) {
      return { ok: false, serverId: null, error: (err as Error).message };
    }
  }

  // ── Provider/model surface ─────────────────────────────────────────

  /** Which providers does this user have credentials for? Used by the UI's
   *  model picker to know which providers are connected. */
  async listConnectedProviders(caller: UserCaller): Promise<ConnectedProvider[]> {
    const creds = this.credentialSummaries(await this.requireTier(caller, 'credentials.model'));
    const byKey = new Map(creds.map((c) => [c.key, c]));
    const out: ConnectedProvider[] = [];
    // Built-in providers without credentials are listed by the server, not
    // here — UserDO only knows about credential-gated ones.
    if (byKey.has(CLOUDFLARE_OAUTH_CRED_KEY)) {
      out.push({ id: 'workers-ai', label: 'Cloudflare Workers AI', credentialKeys: [CLOUDFLARE_OAUTH_CRED_KEY] });
      if (this.selectedAIGatewayId()) {
        out.push({ id: 'my-gateway', label: 'Your AI Gateway', credentialKeys: [CLOUDFLARE_OAUTH_CRED_KEY] });
      }
    }
    if (byKey.has(CODEX_CRED_KEY)) out.push({ id: 'codex', label: 'ChatGPT Codex', credentialKeys: [CODEX_CRED_KEY] });
    for (const c of creds) {
      // `<providerId>.bearer` — BYO API keys (bespoke trio + any models.dev
      // catalog provider). Display names come from the catalog client-side.
      const bearer = /^([a-z0-9][a-z0-9._-]*)\.bearer$/.exec(c.key);
      if (bearer) {
        out.push({ id: bearer[1], label: bearer[1], credentialKeys: [c.key] });
        continue;
      }
      // openai-compat is keyed by user-chosen suffix: 'openai-compat.<name>'
      if (c.key.startsWith('openai-compat.')) {
        const name = c.key.slice('openai-compat.'.length);
        out.push({ id: `openai-compat:${name}`, label: `OpenAI-compatible (${name})`, credentialKeys: [c.key] });
      }
    }
    return out;
  }
}
