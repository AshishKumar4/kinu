/**
 * UserDO — per-user Durable Object. Keyed by `userId` = sha256(email) truncated.
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
 */
import { Agent, callable } from "agents";
import type { Credential } from '@proteus/core';
import { initUserTables } from './schema.js';
import { credentialToHeaders, accessTokenExpiring } from './credential-headers.js';
import { validateCredential, validateCredentialKey, validateAgentName } from './validate.js';
import {
  createCodexOAuthClient, tokensToCredential, CODEX_DEVICE_PORTAL,
  type DeviceCodeStart,
} from './codex-oauth.js';

const CODEX_CRED_KEY = 'codex.oauth';

interface SqlRow extends Record<string, unknown> {}

export interface UserProfile {
  email: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface AgentEntry {
  name: string;
  displayName: string;
  purpose: string;
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

export class UserDO extends Agent<Env> {
  private _initialized = false;

  private ensureInit(): void {
    if (this._initialized) return;
    initUserTables(this.ctx.storage.sql);
    this._initialized = true;
  }

  private sqlx<T = SqlRow>(query: string, ...bindings: unknown[]): T[] {
    this.ensureInit();
    return this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  // ── Profile ────────────────────────────────────────────────────────

  @callable()
  async ensureProfile(email: string, displayName?: string): Promise<UserProfile> {
    this.ensureInit();
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

  @callable()
  async getProfile(): Promise<UserProfile | null> {
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

  // ── Agent registry ─────────────────────────────────────────────────

  @callable()
  async listAgents(): Promise<AgentEntry[]> {
    return this.sqlx<{ name: string; display_name: string; purpose: string | null; created_at: number; last_visited: number; archived_at: number | null }>(
      `SELECT name, display_name, purpose, created_at, last_visited, archived_at
       FROM user_agents WHERE archived_at IS NULL ORDER BY last_visited DESC`,
    ).map((r) => ({
      name: r.name,
      displayName: r.display_name,
      purpose: r.purpose ?? '',
      createdAt: r.created_at,
      lastVisited: r.last_visited,
      archivedAt: r.archived_at,
    }));
  }

  @callable()
  async registerAgent(name: string, displayName: string, purpose?: string): Promise<AgentEntry> {
    validateAgentName(name);
    const now = Date.now();
    this.sqlx(
      `INSERT INTO user_agents (name, display_name, purpose, created_at, last_visited)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         display_name = excluded.display_name,
         purpose      = COALESCE(excluded.purpose, user_agents.purpose),
         last_visited = excluded.last_visited,
         archived_at  = NULL`,
      name, displayName, purpose ?? null, now, now,
    );
    return { name, displayName, purpose: purpose ?? '', createdAt: now, lastVisited: now, archivedAt: null };
  }

  @callable()
  async touchAgent(name: string): Promise<void> {
    validateAgentName(name);
    this.sqlx(`UPDATE user_agents SET last_visited = ? WHERE name = ?`, Date.now(), name);
  }

  @callable()
  async removeAgent(name: string): Promise<void> {
    validateAgentName(name);
    this.sqlx(`DELETE FROM user_agents WHERE name = ?`, name);
  }

  @callable()
  async hasAgent(name: string): Promise<boolean> {
    validateAgentName(name);
    const row = this.sqlx(`SELECT 1 AS x FROM user_agents WHERE name = ? AND archived_at IS NULL`, name)[0];
    return !!row;
  }

  // ── Credentials ────────────────────────────────────────────────────

  @callable()
  async listCredentials(): Promise<CredentialSummary[]> {
    return this.sqlx<{ key: string; kind: string; created_at: number; updated_at: number }>(
      `SELECT key, kind, created_at, updated_at FROM user_credentials ORDER BY key`,
    ).map((r) => ({
      key: r.key,
      kind: r.kind as CredentialSummary['kind'],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  @callable()
  async setCredential(key: string, credentialJson: unknown): Promise<void> {
    validateCredentialKey(key);
    const cred = validateCredential(credentialJson);
    const now = Date.now();
    this.sqlx(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value = excluded.value, updated_at = excluded.updated_at`,
      key, cred.kind, JSON.stringify(cred), now, now,
    );
  }

  @callable()
  async deleteCredential(key: string): Promise<void> {
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
  @callable()
  async getCredentialBaseURL(key: string): Promise<string | null> {
    validateCredentialKey(key);
    const cred = this.getCredentialRow(key);
    if (cred?.kind === 'openai-compat') return cred.baseURL;
    return null;
  }

  /** Returns headers ready to inject into a fetch. Handles Codex OAuth
   *  refresh atomically (DO event loop serializes concurrent calls). */
  @callable()
  async getAuthHeaders(key: string, opts?: { forceRefresh?: boolean }): Promise<Record<string, string> | null> {
    validateCredentialKey(key);
    let cred = this.getCredentialRow(key);
    if (!cred) return null;

    // Codex OAuth — auto-refresh if expiring or forced.
    if (key === CODEX_CRED_KEY && cred.kind === 'oauth') {
      const needRefresh = opts?.forceRefresh || accessTokenExpiring(cred.accessToken);
      if (needRefresh) {
        const refreshed = await this.refreshCodexInternal(cred);
        if (refreshed) cred = refreshed;
        // If refresh failed we keep using the old (possibly-expired) creds —
        // the caller may still succeed, and if not it gets 401 and a clear
        // signal that re-auth is needed.
      }
    }

    try { return credentialToHeaders(key, cred); }
    catch { return null; }
  }

  private async refreshCodexInternal(current: Credential & { kind: 'oauth' }): Promise<(Credential & { kind: 'oauth' }) | null> {
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

  @callable()
  async startCodexDeviceFlow(): Promise<DeviceCodeStart> {
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

  @callable()
  async pollCodexDeviceFlow(): Promise<{ connected: boolean; accountId?: string; error?: string }> {
    const row = this.sqlx<{ device_auth_id: string; user_code: string }>(
      `SELECT device_auth_id, user_code FROM codex_device_flow WHERE id = 1`,
    )[0];
    if (!row) return { connected: false, error: 'No device flow in progress — call startCodexDeviceFlow first.' };

    const client = createCodexOAuthClient();
    try {
      const tokens = await client.pollDeviceFlow(row.device_auth_id, row.user_code);
      if (!tokens) return { connected: false }; // still pending
      const cred = tokensToCredential(tokens);
      const now = Date.now();
      this.sqlx(
        `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value = excluded.value, updated_at = excluded.updated_at`,
        CODEX_CRED_KEY, cred.kind, JSON.stringify(cred), now, now,
      );
      this.sqlx(`DELETE FROM codex_device_flow`);
      const accountId = this.decodeCodexAccountId(cred.accessToken);
      return { connected: true, accountId: accountId ?? undefined };
    } catch (err) {
      return { connected: false, error: (err as Error).message };
    }
  }

  @callable()
  async disconnectCodex(): Promise<void> {
    this.sqlx(`DELETE FROM user_credentials WHERE key = ?`, CODEX_CRED_KEY);
    this.sqlx(`DELETE FROM codex_device_flow`);
  }

  @callable()
  async getCodexStatus(): Promise<CodexStatus> {
    const cred = this.getCredentialRow(CODEX_CRED_KEY);
    const flow = this.sqlx<{ user_code: string; portal_url: string; poll_interval: number }>(
      `SELECT user_code, portal_url, poll_interval FROM codex_device_flow WHERE id = 1`,
    )[0];
    if (cred?.kind === 'oauth') {
      return {
        connected: true,
        accountId: this.decodeCodexAccountId(cred.accessToken),
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

  private decodeCodexAccountId(accessToken: string): string | null {
    try {
      const parts = accessToken.split('.');
      if (parts.length < 2) return null;
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
      const json = JSON.parse(atob(padded));
      const id = json?.['https://api.openai.com/auth']?.chatgpt_account_id;
      return typeof id === 'string' && id ? id : null;
    } catch { return null; }
  }

  // ── User-level config (defaults) ───────────────────────────────────

  @callable()
  async getConfig(key: string): Promise<string | null> {
    const row = this.sqlx<{ value: string }>(`SELECT value FROM user_config WHERE key = ?`, key)[0];
    return row?.value ?? null;
  }

  @callable()
  async setConfig(key: string, value: string): Promise<void> {
    this.sqlx(
      `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, value, Date.now(),
    );
  }

  @callable()
  async listConfig(): Promise<Record<string, string>> {
    const rows = this.sqlx<{ key: string; value: string }>(`SELECT key, value FROM user_config`);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ── Provider/model surface ─────────────────────────────────────────

  /** Which providers does this user have credentials for? Used by the UI's
   *  model picker to know which providers are connected. */
  @callable()
  async listConnectedProviders(): Promise<ConnectedProvider[]> {
    const creds = await this.listCredentials();
    const byKey = new Map(creds.map((c) => [c.key, c]));
    const out: ConnectedProvider[] = [];
    // Built-in providers without credentials are listed by the server, not
    // here — UserDO only knows about credential-gated ones.
    if (byKey.has(CODEX_CRED_KEY)) out.push({ id: 'codex', label: 'ChatGPT Codex', credentialKeys: [CODEX_CRED_KEY] });
    if (byKey.has('openai.bearer')) out.push({ id: 'openai', label: 'OpenAI', credentialKeys: ['openai.bearer'] });
    if (byKey.has('anthropic.bearer')) out.push({ id: 'anthropic', label: 'Anthropic', credentialKeys: ['anthropic.bearer'] });
    if (byKey.has('openrouter.bearer')) out.push({ id: 'openrouter', label: 'OpenRouter', credentialKeys: ['openrouter.bearer'] });
    // openai-compat is keyed by user-chosen suffix: 'openai-compat.<name>'
    for (const c of creds) {
      if (c.key.startsWith('openai-compat.')) {
        const name = c.key.slice('openai-compat.'.length);
        out.push({ id: `openai-compat:${name}`, label: `OpenAI-compatible (${name})`, credentialKeys: [c.key] });
      }
    }
    return out;
  }
}
