import type { AuthIdentity } from './session.js';
import type { OAuthProviderId } from './providers.js';
import type { UserDO } from '../user/user-do.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_RETENTION_MS = 10 * 60 * 1000;

const D1_BOOKMARK_COOKIE_NAME = '__Host-proteus_d1_bookmark';

export interface OAuthStateInput {
  provider: OAuthProviderId;
  codeVerifier: string;
  nonce?: string | null;
  returnTo: string;
  redirectUri: string;
}

export interface OAuthStateRecord extends OAuthStateInput {
  createdAt: number;
  expiresAt: number;
}

export interface OAuthProfile {
  provider: OAuthProviderId;
  providerSub: string;
  email: string;
  emailVerified: boolean;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface BrowserSession {
  token: string;
  expiresAt: number;
  identity: AuthIdentity;
  bookmark: string | null;
}

export interface AuthSessionVerification {
  identity: AuthIdentity | null;
  bookmark: string | null;
}

export interface AuthStoreEnv {
  AUTH_DB: D1Database;
  UserDO: DurableObjectNamespace<UserDO>;
}

type OAuthStateRow = {
  provider: string;
  code_verifier: string;
  nonce: string | null;
  return_to: string;
  redirect_uri: string;
  created_at: number;
  expires_at: number;
};

type AccountRow = {
  user_id: string;
  display_name: string | null;
};

type AuthSessionRow = {
  user_id: string;
  email: string;
  display_name: string | null;
  provider: string;
  provider_account_id: string;
  auth_time: number;
};

export async function createOAuthState(
  db: D1Database,
  input: OAuthStateInput,
): Promise<{ state: string; expiresAt: number; bookmark: string | null }> {
  const now = Date.now();
  const state = randomToken(32);
  const stateHash = await sha256Hex(state);
  const expiresAt = now + OAUTH_STATE_TTL_MS;
  const session = primarySession(db);
  await session.prepare(
    `INSERT INTO auth_oauth_states
      (state_hash, provider, code_verifier, nonce, return_to, redirect_uri, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    stateHash,
    input.provider,
    input.codeVerifier,
    input.nonce ?? null,
    sanitizeReturnTo(input.returnTo),
    input.redirectUri,
    now,
    expiresAt,
  ).run();
  return { state, expiresAt, bookmark: session.getBookmark() };
}

export async function consumeOAuthState(
  db: D1Database,
  state: string,
  provider: OAuthProviderId,
): Promise<OAuthStateRecord & { bookmark: string | null }> {
  const stateHash = await sha256Hex(state);
  const session = primarySession(db);
  const row = await session.prepare(
    `DELETE FROM auth_oauth_states
       WHERE state_hash = ?
       RETURNING provider, code_verifier, nonce, return_to, redirect_uri, created_at, expires_at`,
  ).bind(stateHash).first<OAuthStateRow>();

  if (!row) throw new Error('OAuth state is invalid or already used.');
  if (row.provider !== provider) throw new Error('OAuth state provider mismatch.');
  if (row.expires_at <= Date.now()) throw new Error('OAuth state expired. Start sign-in again.');

  return {
    provider,
    codeVerifier: row.code_verifier,
    nonce: row.nonce,
    returnTo: sanitizeReturnTo(row.return_to),
    redirectUri: row.redirect_uri,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    bookmark: session.getBookmark(),
  };
}

export async function createSession(env: AuthStoreEnv, profile: OAuthProfile): Promise<BrowserSession> {
  const now = Date.now();
  const session = primarySession(env.AUTH_DB);
  const identity = await resolveOrCreateIdentity(env, session, profile, now);
  const token = `ps_${randomToken(48)}`;
  const sessionHash = await sha256Hex(token);
  const expiresAt = now + SESSION_TTL_MS;

  await session.prepare(
    `INSERT INTO auth_sessions
      (session_hash, user_id, provider, provider_account_id, auth_time, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    sessionHash,
    identity.userId,
    identity.provider ?? profile.provider,
    identity.sub,
    now,
    now,
    expiresAt,
  ).run();

  return { token, expiresAt, identity: { ...identity, authTime: now }, bookmark: session.getBookmark() };
}

export async function verifySession(
  db: D1Database,
  token: string,
  bookmark?: string | null,
): Promise<AuthSessionVerification> {
  if (!token.startsWith('ps_') || token.length < 48) return { identity: null, bookmark: null };
  const sessionHash = await sha256Hex(token);
  const session = db.withSession(bookmark || 'first-unconstrained');
  const row = await session.prepare(
    `SELECT
       s.user_id,
       u.email,
       u.display_name,
       s.provider,
       s.provider_account_id,
       s.auth_time
     FROM auth_sessions s
     JOIN auth_users u ON u.id = s.user_id
     WHERE s.session_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > ?`,
  ).bind(sessionHash, Date.now()).first<AuthSessionRow>();

  return {
    identity: row ? {
      userId: row.user_id,
      email: row.email,
      sub: row.provider_account_id,
      provider: row.provider,
      displayName: row.display_name,
      authTime: row.auth_time,
      d1Bookmark: session.getBookmark(),
    } : null,
    bookmark: session.getBookmark(),
  };
}

export async function revokeSession(db: D1Database, token: string): Promise<string | null> {
  if (!token.startsWith('ps_')) return null;
  const sessionHash = await sha256Hex(token);
  const session = primarySession(db);
  await session.prepare(
    `UPDATE auth_sessions
       SET revoked_at = ?, updated_at = ?
     WHERE session_hash = ?
       AND revoked_at IS NULL`,
  ).bind(Date.now(), Date.now(), sessionHash).run();
  return session.getBookmark();
}

export async function cleanupExpiredAuthRows(db: D1Database, now = Date.now()): Promise<void> {
  const cutoff = now - CLEANUP_RETENTION_MS;
  const session = primarySession(db);
  await session.batch([
    session.prepare(`DELETE FROM auth_oauth_states WHERE expires_at <= ?`).bind(cutoff),
    session.prepare(
      `DELETE FROM auth_sessions
        WHERE expires_at <= ?
           OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
    ).bind(cutoff, cutoff),
  ]);
}

export function readD1Bookmark(request: Request): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === D1_BOOKMARK_COOKIE_NAME) return decodeURIComponent(rest.join('=') || '');
  }
  return null;
}

export function d1BookmarkCookie(bookmark: string | null): string | null {
  if (!bookmark) return null;
  return `${D1_BOOKMARK_COOKIE_NAME}=${encodeURIComponent(bookmark)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearD1BookmarkCookie(): string {
  return `${D1_BOOKMARK_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function resolveOrCreateIdentity(
  env: AuthStoreEnv,
  session: D1DatabaseSession,
  profile: OAuthProfile,
  now: number,
): Promise<AuthIdentity> {
  const email = normalizeEmail(profile.email);
  if (!email) throw new Error('OAuth provider did not return an email address.');
  if (!profile.providerSub) throw new Error('OAuth provider did not return a stable subject.');

  const existing = await session.prepare(
    `SELECT user_id, display_name
       FROM auth_accounts
      WHERE provider = ?
        AND provider_account_id = ?`,
  ).bind(profile.provider, profile.providerSub).first<AccountRow>();

  let userId = existing?.user_id ?? null;
  if (!userId && profile.emailVerified) {
    const linked = await session.prepare(
      `SELECT user_id FROM auth_email_links WHERE email = ?`,
    ).bind(email).first<{ user_id: string }>();
    userId = linked?.user_id ?? null;
  }
  if (!userId) userId = randomHex(16);

  await upsertUser(session, userId, email, profile, now);

  if (!existing && profile.emailVerified) {
    const linked = await session.prepare(
      `INSERT INTO auth_email_links (email, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at
       RETURNING user_id`,
    ).bind(email, userId, now, now).first<{ user_id: string }>();
    userId = linked?.user_id ?? userId;
  }

  await upsertUser(session, userId, email, profile, now);

  const account = await session.prepare(
    `INSERT INTO auth_accounts
      (provider, provider_account_id, user_id, email, email_verified, display_name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_account_id) DO UPDATE SET
       email = excluded.email,
       email_verified = excluded.email_verified,
       display_name = COALESCE(excluded.display_name, auth_accounts.display_name),
       avatar_url = COALESCE(excluded.avatar_url, auth_accounts.avatar_url),
       updated_at = excluded.updated_at
     RETURNING user_id, display_name`,
  ).bind(
    profile.provider,
    profile.providerSub,
    userId,
    email,
    profile.emailVerified ? 1 : 0,
    profile.displayName ?? null,
    profile.avatarUrl ?? null,
    now,
    now,
  ).first<AccountRow>();

  userId = account?.user_id ?? userId;
  await upsertUser(session, userId, email, profile, now);

  const userDO = env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
  await userDO.ensureProfile(email, profile.displayName ?? undefined);

  return {
    userId,
    email,
    sub: profile.providerSub,
    provider: profile.provider,
    displayName: profile.displayName ?? account?.display_name ?? existing?.display_name ?? null,
    authTime: now,
  };
}

async function upsertUser(
  session: D1DatabaseSession,
  userId: string,
  email: string,
  profile: OAuthProfile,
  now: number,
): Promise<void> {
  await session.prepare(
    `INSERT INTO auth_users
      (id, email, email_verified, display_name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       email_verified = MAX(auth_users.email_verified, excluded.email_verified),
       display_name = COALESCE(excluded.display_name, auth_users.display_name),
       avatar_url = COALESCE(excluded.avatar_url, auth_users.avatar_url),
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    email,
    profile.emailVerified ? 1 : 0,
    profile.displayName ?? null,
    profile.avatarUrl ?? null,
    now,
    now,
  ).run();
}

function primarySession(db: D1Database): D1DatabaseSession {
  return db.withSession('first-primary');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sanitizeReturnTo(input: string): string {
  const raw = input.trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

function randomToken(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
