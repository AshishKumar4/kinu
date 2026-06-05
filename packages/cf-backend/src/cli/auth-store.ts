import type { AuthIdentity } from '../auth/session.js';
import type { UserDO } from '../user/user-do.js';

const AUTH_TTL_MS = 10 * 60 * 1000;
const CLEANUP_RETENTION_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 2;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export interface CliAuthStartResult {
  deviceToken: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface CliAuthPollResult {
  status: 'pending' | 'approved' | 'expired';
  message?: string;
  origin?: string;
  token?: string;
  expiresAt?: string;
  user?: { id: string; email: string };
}

export interface CliAuthRequestInfo {
  userCode: string;
  deviceName: string;
  status: 'pending' | 'approved' | 'expired' | 'consumed';
  expiresAt: string;
  approvedAt?: string;
  user?: { id: string; email: string };
}

type CliAuthRow = {
  user_code: string;
  device_name: string;
  status: string;
  origin: string;
  user_id: string | null;
  user_email: string | null;
  token_exp: string | null;
  expires_at: number;
  approved_at: number | null;
};

type CliAuthEnv = {
  AUTH_DB: D1Database;
  UserDO: DurableObjectNamespace<UserDO>;
};

export async function startCliAuth(
  env: CliAuthEnv,
  origin: string,
  approvalOrigin: string,
  deviceName?: string,
  clientKey?: string,
): Promise<CliAuthStartResult> {
  const now = Date.now();
  await cleanupExpiredCliAuthRows(env.AUTH_DB, now);
  await rateLimit(env.AUTH_DB, `start:${cleanRateKey(clientKey)}`, 20, RATE_WINDOW_MS, now);

  const expiresAt = now + AUTH_TTL_MS;
  const session = primarySession(env.AUTH_DB);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const deviceToken = randomToken(32);
    const userCode = createUserCode();
    try {
      await session.prepare(
        `INSERT INTO cli_auth_requests
           (device_hash, user_code, device_name, status, origin, created_at, expires_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      ).bind(
        await sha256Hex(deviceToken),
        userCode,
        cleanDeviceName(deviceName),
        cleanOrigin(origin),
        now,
        expiresAt,
      ).run();
      return {
        deviceToken,
        userCode,
        verificationUrl: `${cleanOrigin(approvalOrigin)}/cli/auth?code=${encodeURIComponent(userCode)}`,
        expiresAt: new Date(expiresAt).toISOString(),
        intervalSeconds: POLL_INTERVAL_SECONDS,
      };
    } catch {
      // Code collision; retry with a new code.
    }
  }
  throw new Error('Could not allocate a CLI auth code.');
}

export async function inspectCliAuth(db: D1Database, userCode: string): Promise<CliAuthRequestInfo | null> {
  const code = normalizeUserCode(userCode);
  const session = primarySession(db);
  const row = await session.prepare(
    `SELECT user_code, device_name, status, origin, user_id, user_email, token_exp, expires_at, approved_at
       FROM cli_auth_requests WHERE user_code = ?`,
  ).bind(code).first<CliAuthRow>();
  if (!row) return null;
  const status = currentStatus(row.status, row.expires_at);
  if (status === 'expired' && row.status !== 'expired') {
    await session.prepare(`UPDATE cli_auth_requests SET status = 'expired' WHERE user_code = ?`).bind(code).run();
  }
  return {
    userCode: row.user_code,
    deviceName: row.device_name,
    status,
    expiresAt: new Date(row.expires_at).toISOString(),
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : undefined,
    user: row.user_id && row.user_email ? { id: row.user_id, email: row.user_email } : undefined,
  };
}

export async function pollCliAuth(env: CliAuthEnv, deviceToken: string, clientKey?: string): Promise<CliAuthPollResult> {
  const now = Date.now();
  await cleanupExpiredCliAuthRows(env.AUTH_DB, now);
  await rateLimit(env.AUTH_DB, `poll-ip:${cleanRateKey(clientKey)}`, 300, RATE_WINDOW_MS, now);

  const hash = await sha256Hex(deviceToken);
  await rateLimit(env.AUTH_DB, `poll-device:${hash}`, 180, RATE_WINDOW_MS, now);

  const session = primarySession(env.AUTH_DB);
  const row = await session.prepare(
    `SELECT user_code, device_name, status, origin, user_id, user_email, token_exp, expires_at, approved_at
       FROM cli_auth_requests WHERE device_hash = ?`,
  ).bind(hash).first<CliAuthRow>();
  if (!row) return { status: 'expired', message: 'Unknown CLI auth request.' };

  const status = currentStatus(row.status, row.expires_at);
  if (status === 'expired') {
    await session.prepare(`UPDATE cli_auth_requests SET status = 'expired', token_exp = NULL WHERE device_hash = ?`).bind(hash).run();
    return { status: 'expired', message: 'CLI auth request expired.' };
  }
  if (status === 'pending') return { status: 'pending' };
  if (status === 'consumed') {
    return { status: 'expired', message: 'CLI auth token was already delivered. Run proteus auth again if it was not saved.' };
  }
  if (!row.user_id || !row.user_email) {
    await session.prepare(`UPDATE cli_auth_requests SET status = 'expired', token_exp = NULL WHERE device_hash = ?`).bind(hash).run();
    return { status: 'expired', message: 'CLI auth approval is incomplete. Run proteus auth again.' };
  }

  const consumed = await session.prepare(
    `UPDATE cli_auth_requests
        SET status = 'consumed'
      WHERE device_hash = ? AND status = 'approved'
      RETURNING origin, device_name, user_id, user_email`,
  ).bind(hash).first<{ origin: string; device_name: string; user_id: string; user_email: string }>();
  if (!consumed) {
    return { status: 'expired', message: 'CLI auth token was already delivered. Run proteus auth again if it was not saved.' };
  }

  const userDO = env.UserDO.get(env.UserDO.idFromName(consumed.user_id)) as DurableObjectStub<UserDO>;
  const minted = await userDO.mintCliToken(consumed.user_id, consumed.device_name);
  const tokenExpiresAt = new Date(minted.expiresAt).toISOString();
  await session.prepare(
    `UPDATE cli_auth_requests
        SET token_exp = ?
      WHERE device_hash = ? AND status = 'consumed'`,
  ).bind(tokenExpiresAt, hash).run();
  return {
    status: 'approved',
    origin: consumed.origin,
    token: minted.token,
    expiresAt: tokenExpiresAt,
    user: { id: consumed.user_id, email: consumed.user_email },
  };
}

export async function approveCliAuth(
  env: CliAuthEnv,
  userCode: string,
  identity: AuthIdentity,
  clientKey?: string,
): Promise<{ ok: true; status: 'approved'; user: { id: string; email: string } }> {
  const now = Date.now();
  await cleanupExpiredCliAuthRows(env.AUTH_DB, now);
  await rateLimit(env.AUTH_DB, `approve:${identity.userId}:${cleanRateKey(clientKey)}`, 30, RATE_WINDOW_MS, now);

  const code = normalizeUserCode(userCode);
  const session = primarySession(env.AUTH_DB);
  const row = await session.prepare(
    `SELECT user_code, device_name, status, origin, user_id, user_email, token_exp, expires_at, approved_at
       FROM cli_auth_requests WHERE user_code = ?`,
  ).bind(code).first<CliAuthRow>();
  if (!row) throw new Error('Unknown CLI auth code.');

  const status = currentStatus(row.status, row.expires_at);
  if (status === 'approved' || status === 'consumed') {
    return {
      ok: true,
      status: 'approved',
      user: { id: row.user_id ?? identity.userId, email: row.user_email ?? identity.email },
    };
  }
  if (status !== 'pending') {
    await session.prepare(`UPDATE cli_auth_requests SET status = 'expired', token_exp = NULL WHERE user_code = ?`).bind(code).run();
    throw new Error('CLI auth code expired. Run proteus auth again.');
  }

  const userDO = env.UserDO.get(env.UserDO.idFromName(identity.userId)) as DurableObjectStub<UserDO>;
  await userDO.ensureProfile(identity.email);
  await session.prepare(
    `UPDATE cli_auth_requests
        SET status = 'approved', user_id = ?, user_email = ?, approved_at = ?
      WHERE user_code = ?`,
  ).bind(identity.userId, identity.email, now, code).run();
  return { ok: true, status: 'approved', user: { id: identity.userId, email: identity.email } };
}

export async function cleanupExpiredCliAuthRows(db: D1Database, now = Date.now()): Promise<void> {
  const cutoff = now - CLEANUP_RETENTION_MS;
  const session = primarySession(db);
  await session.batch([
    session.prepare(
      `UPDATE cli_auth_requests
          SET status = 'expired', token_exp = NULL
        WHERE status IN ('pending', 'approved') AND expires_at <= ?`,
    ).bind(now),
    session.prepare(
      `DELETE FROM cli_auth_requests
        WHERE (status = 'expired' AND expires_at <= ?)
           OR (status = 'consumed' AND COALESCE(approved_at, expires_at) <= ?)`,
    ).bind(cutoff, cutoff),
    session.prepare(`DELETE FROM cli_auth_rate WHERE reset_at <= ?`).bind(now),
  ]);
}

async function rateLimit(db: D1Database, key: string, limit: number, windowMs: number, now: number): Promise<void> {
  const session = primarySession(db);
  const row = await session.prepare(
    `SELECT count, reset_at FROM cli_auth_rate WHERE key = ?`,
  ).bind(key).first<{ count: number; reset_at: number }>();
  if (!row || row.reset_at <= now) {
    await session.prepare(
      `INSERT INTO cli_auth_rate (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
    ).bind(key, now + windowMs).run();
    return;
  }
  if (row.count >= limit) throw new Error('Too many CLI auth attempts. Try again later.');
  await session.prepare(`UPDATE cli_auth_rate SET count = count + 1 WHERE key = ?`).bind(key).run();
}

function primarySession(db: D1Database): D1DatabaseSession {
  return db.withSession('first-primary');
}

function currentStatus(status: string, expiresAt: number): CliAuthRequestInfo['status'] {
  if ((status === 'pending' || status === 'approved') && Date.now() > expiresAt) return 'expired';
  return status === 'pending' || status === 'approved' || status === 'consumed' ? status : 'expired';
}

function cleanDeviceName(input?: string): string {
  const s = (input ?? 'terminal').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, 80) : 'terminal';
}

function cleanOrigin(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

function cleanRateKey(input?: string): string {
  const s = (input ?? 'unknown').trim();
  return s ? s.slice(0, 160) : 'unknown';
}

function normalizeUserCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
}

function createUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function randomToken(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
