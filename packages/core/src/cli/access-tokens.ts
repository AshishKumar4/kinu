/** CI access tokens (`pta_…`), hashed at rest in UserDO SQLite; free of `cloudflare:workers` for bun:sqlite tests.
 *  Caller-correctable failures return `{ ok: false }` so they survive Worker→DO RPC; throws are infra failures. */
import { nanoid } from '../utils/nanoid';
import { type SqlExec } from '../types/primitives';
import { sha256Hex } from '../safety/argument-digest';
import * as v from 'valibot';

// No back-compat aliases: tokens are reminted on redeploy (owner decision 2026-06-13).
// `ai.proxy` covers all of the owner's inference credentials, but never account-management routes.
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

/** Routing hint for reaching the owning UserDO before verification. */
export function parseAccessTokenUserId(token: string): string | null {
  const match = /^pta_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(token);

  return match?.[1] ?? null;
}

/** Deduped, vocabulary-checked, stable order. */
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
  const tokenHash = sha256Hex(token);
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
  const tokenHash = sha256Hex(token);

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

const ListedTokenSchema = v.object({
  token_hash: v.string(),
  name: v.string(),
  scopes: v.string(),
  created_at: v.number(),
  last_used_at: v.nullable(v.number()),
});

export function listAccessTokens(sql: SqlExec): AccessTokenRecord[] {
  return sql.exec(
    `SELECT token_hash, name, scopes, created_at, last_used_at
       FROM user_access_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`,
  ).toArray().map((row) => {
    const stored = v.parse(ListedTokenSchema, row);

    return {
      tokenHash: stored.token_hash,
      name: stored.name,
      scopes: parseScopeList(stored.scopes),
      createdAt: stored.created_at,
      lastUsedAt: stored.last_used_at,
    };
  });
}

/** Unknown or already-revoked refs report `revoked: false` so callers can 404. */
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

/** Null when no active token matches; also pins the agent websocket to the bearer's scopes. */
export function getActiveAccessTokenScopes(sql: SqlExec, tokenHash: string): AccessTokenScope[] | null {
  const row = v.parse(v.optional(v.object({ scopes: v.string() })), sql.exec(
    `SELECT scopes FROM user_access_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    tokenHash,
  ).toArray()[0]);

  if (!row) return null;
  const scopes = parseScopeList(String(row.scopes));

  return scopes.length > 0 ? scopes : null;
}

/** A non-array column is corruption and throws (zero scopes would read as revoked); retired names are dropped. */
function parseScopeList(value: string): AccessTokenScope[] {
  const granted = v.parse(v.array(v.string()), JSON.parse(value));

  return ACCESS_TOKEN_SCOPES.filter((scope) => granted.includes(scope));
}
