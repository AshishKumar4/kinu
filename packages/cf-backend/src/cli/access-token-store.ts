/**
 * Long-lived CI access tokens (`pta_…`) — the scoped, non-interactive
 * counterpart to the interactive `ptc_…` CLI session tokens. Rows live in the
 * owning UserDO's SQLite, hashed at rest like every other bearer secret. This
 * module is the single home for the token format, the scope vocabulary, and
 * the SQL, kept free of `cloudflare:workers` imports so it unit-tests under
 * plain bun:sqlite.
 *
 * Caller-correctable failures are returned as `{ ok: false, error }` results
 * (never thrown) so they survive the Worker→DO RPC boundary with their
 * meaning intact; thrown errors are real infra failures.
 */
import { nanoid, type SqlExec } from '@proteus/core';
import { sha256Hex } from '../lib/crypto';
import * as v from 'valibot';

// Scopes renamed from agent.read/agent.exec with no back-compat migration by
// design — pre-production, tokens are reissued on redeploy (owner decision
// 2026-06-13).
//
// `ai.proxy` means "spend the owner's inference credentials", and that is now
// ALL of them: the Cloudflare-pinned /api/user/ai/v1 proxy and the general
// provider proxy, which also lets the holder enumerate which providers are
// connected. It stays one scope because it is one capability — running models
// on the owner's account — and the general proxy admits only inference
// endpoints, never a provider's account-management routes.
export const ACCESS_TOKEN_SCOPES = ['workspace.read', 'workspace.exec', 'ai.proxy'] as const;
export type AccessTokenScope = (typeof ACCESS_TOKEN_SCOPES)[number];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AccessTokenRecord {
  tokenHash: string;
  name: string;
  scopes: AccessTokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
}

export type AccessTokenMint =
  | { ok: true; token: string; record: AccessTokenRecord }
  | { ok: false; error: string };

export type AccessTokenVerification =
  | { ok: true; userId: string; tokenHash: string; scopes: AccessTokenScope[] }
  | { ok: false; error: string };

export function initAccessTokenTable(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_access_tokens (
      token_hash   TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      scopes       TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_used_at INTEGER,
      revoked_at   INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_access_tokens_name ON user_access_tokens (name, revoked_at)`);
}

/** Parse the userId embedded in a `pta_…` access token — the routing hint
 *  edge routes use to reach the owning UserDO before verification. */
export function parseAccessTokenUserId(token: string): string | null {
  const match = /^pta_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(token);
  return match?.[1] ?? null;
}

/** Validate and canonicalize a requested scope list: deduped, every entry in
 *  the vocabulary, stable order. */
export function normalizeAccessTokenScopes(
  scopes: readonly string[],
): { ok: true; scopes: AccessTokenScope[] } | { ok: false; error: string } {
  const requested = new Set(scopes.map((s) => s.trim()).filter(Boolean));
  if (requested.size === 0) {
    return { ok: false, error: `At least one scope is required. Valid scopes: ${ACCESS_TOKEN_SCOPES.join(', ')}.` };
  }
  for (const scope of requested) {
    if (!v.is(v.picklist(ACCESS_TOKEN_SCOPES), scope)) {
      return { ok: false, error: `Unknown scope "${scope}". Valid scopes: ${ACCESS_TOKEN_SCOPES.join(', ')}.` };
    }
  }
  return { ok: true, scopes: ACCESS_TOKEN_SCOPES.filter((scope) => requested.has(scope)) };
}

export async function mintAccessToken(
  sql: SqlExec,
  userId: string,
  name: string,
  scopes: readonly string[],
): Promise<AccessTokenMint> {
  if (!/^[a-f0-9]{32}$/.test(userId)) return { ok: false, error: 'invalid user id' };
  const cleanName = name.trim();
  if (!NAME_RE.test(cleanName)) {
    return { ok: false, error: 'Token name must be 1-64 characters: letters, numbers, dots, dashes, or underscores; it must start with a letter or number.' };
  }
  const normalized = normalizeAccessTokenScopes(scopes);
  if (!normalized.ok) return normalized;
  const duplicate = sql.exec(
    `SELECT 1 AS x FROM user_access_tokens WHERE name = ? AND revoked_at IS NULL LIMIT 1`,
    cleanName,
  ).toArray()[0];
  if (duplicate) {
    return { ok: false, error: `An active access token named "${cleanName}" already exists. Revoke it first or choose another name.` };
  }

  const token = `pta_${userId}_${nanoid(44)}`;
  const tokenHash = await sha256Hex(token);
  const createdAt = Date.now();
  sql.exec(
    `INSERT INTO user_access_tokens (token_hash, name, scopes, created_at) VALUES (?, ?, ?, ?)`,
    tokenHash, cleanName, JSON.stringify(normalized.scopes), createdAt,
  );
  return {
    ok: true,
    token,
    record: { tokenHash, name: cleanName, scopes: normalized.scopes, createdAt, lastUsedAt: null },
  };
}

export async function verifyAccessToken(sql: SqlExec, token: string): Promise<AccessTokenVerification> {
  const userId = parseAccessTokenUserId(token);
  if (!userId) return { ok: false, error: 'malformed token' };
  const tokenHash = await sha256Hex(token);
  const row = v.parse(v.optional(v.object({ scopes: v.string(), revoked_at: v.nullable(v.number()) })), sql.exec(
    `SELECT scopes, revoked_at FROM user_access_tokens WHERE token_hash = ? LIMIT 1`,
    tokenHash,
  ).toArray()[0]);
  if (!row || row.revoked_at !== null) return { ok: false, error: 'invalid token' };
  const scopes = parseScopeList(row.scopes);
  if (scopes.length === 0) return { ok: false, error: 'invalid token' };
  sql.exec(`UPDATE user_access_tokens SET last_used_at = ? WHERE token_hash = ?`, Date.now(), tokenHash);
  return { ok: true, userId, tokenHash, scopes };
}

export function listAccessTokens(sql: SqlExec): AccessTokenRecord[] {
  return sql.exec(
    `SELECT token_hash, name, scopes, created_at, last_used_at
       FROM user_access_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`,
  ).toArray().map((row) => ({
    tokenHash: String(row.token_hash),
    name: String(row.name),
    scopes: parseScopeList(String(row.scopes)),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  }));
}

/** Revoke by token name or token hash. Already-revoked or unknown refs report
 *  `revoked: false` so callers can give an honest 404. */
export interface AccessTokenRevocation { ok: true; revoked: boolean }

export function revokeAccessToken(sql: SqlExec, ref: string): AccessTokenRevocation {
  const cleanRef = ref.trim();
  if (!cleanRef) return { ok: true, revoked: false };
  const hit = sql.exec(
    `SELECT 1 AS x FROM user_access_tokens
      WHERE revoked_at IS NULL AND (name = ? OR token_hash = ?) LIMIT 1`,
    cleanRef, cleanRef,
  ).toArray()[0];
  if (!hit) return { ok: true, revoked: false };
  sql.exec(
    `UPDATE user_access_tokens SET revoked_at = ?
      WHERE revoked_at IS NULL AND (name = ? OR token_hash = ?)`,
    Date.now(), cleanRef, cleanRef,
  );
  return { ok: true, revoked: true };
}

/** Scopes of the live (un-revoked) access token behind a bearer hash, or null
 *  when the hash matches no active access token — used by the connect-ticket
 *  validity checks alongside session tokens, and to pin the resulting agent
 *  websocket to the bearer's scopes. */
export function getActiveAccessTokenScopes(sql: SqlExec, tokenHash: string): AccessTokenScope[] | null {
  const row = v.parse(v.optional(v.object({ scopes: v.string() })), sql.exec(
    `SELECT scopes FROM user_access_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    tokenHash,
  ).toArray()[0]);
  if (!row) return null;
  const scopes = parseScopeList(String(row.scopes));
  return scopes.length > 0 ? scopes : null;
}

/** Decode a `scopes` column. This module is the only writer and it writes a
 *  JSON array of the closed vocabulary, so a column that is not one is
 *  corruption rather than a domain value: it throws instead of degrading the
 *  token to zero scopes, which reads identically to a revoked one. Names
 *  outside the current vocabulary are dropped — a retired scope grants
 *  nothing. */
function parseScopeList(value: string): AccessTokenScope[] {
  const granted = v.parse(v.array(v.string()), JSON.parse(value));
  return ACCESS_TOKEN_SCOPES.filter((scope) => granted.includes(scope));
}
