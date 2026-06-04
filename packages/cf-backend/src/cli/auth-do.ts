import { Agent } from 'agents';
import type { AccessIdentity } from '../auth/access.js';
import type { UserDO } from '../user/user-do.js';

const AUTH_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 2;

interface SqlRow extends Record<string, unknown> {}

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

export class CLIAuthDO extends Agent<Env> {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cli_auth_requests (
        device_hash  TEXT PRIMARY KEY,
        user_code    TEXT NOT NULL UNIQUE,
        device_name  TEXT NOT NULL,
        status       TEXT NOT NULL,
        origin       TEXT NOT NULL,
        user_id      TEXT,
        user_email   TEXT,
        token        TEXT,
        token_exp    TEXT,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        approved_at  INTEGER
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_cli_auth_code ON cli_auth_requests(user_code)`);
    this.initialized = true;
  }

  private sqlx<T = SqlRow>(query: string, ...bindings: unknown[]): T[] {
    this.ensureInit();
    return this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  async start(origin: string, deviceName?: string): Promise<CliAuthStartResult> {
    const now = Date.now();
    const expiresAt = now + AUTH_TTL_MS;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const deviceToken = randomToken(32);
      const userCode = createUserCode();
      try {
        this.sqlx(
          `INSERT INTO cli_auth_requests
             (device_hash, user_code, device_name, status, origin, created_at, expires_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
          await sha256Hex(deviceToken),
          userCode,
          cleanDeviceName(deviceName),
          origin,
          now,
          expiresAt,
        );
        return {
          deviceToken,
          userCode,
          verificationUrl: `${origin}/cli/auth?code=${encodeURIComponent(userCode)}`,
          expiresAt: new Date(expiresAt).toISOString(),
          intervalSeconds: POLL_INTERVAL_SECONDS,
        };
      } catch {
        // Code collision; retry with a new code.
      }
    }
    throw new Error('Could not allocate a CLI auth code.');
  }

  async poll(deviceToken: string): Promise<CliAuthPollResult> {
    const hash = await sha256Hex(deviceToken);
    const row = this.sqlx<{
      status: string; origin: string; user_id: string | null; user_email: string | null;
      token: string | null; token_exp: string | null; expires_at: number;
    }>(`SELECT status, origin, user_id, user_email, token, token_exp, expires_at
       FROM cli_auth_requests WHERE device_hash = ?`, hash)[0];
    if (!row) return { status: 'expired', message: 'Unknown CLI auth request.' };
    if (Date.now() > row.expires_at && row.status !== 'approved') {
      this.sqlx(`UPDATE cli_auth_requests SET status = 'expired' WHERE device_hash = ?`, hash);
      return { status: 'expired', message: 'CLI auth request expired.' };
    }
    if (row.status !== 'approved') return { status: 'pending' };
    if (row.token) {
      this.sqlx(`UPDATE cli_auth_requests SET token = NULL WHERE device_hash = ?`, hash);
    }
    return {
      status: 'approved',
      origin: row.origin,
      token: row.token ?? undefined,
      expiresAt: row.token_exp ?? undefined,
      user: row.user_id && row.user_email ? { id: row.user_id, email: row.user_email } : undefined,
    };
  }

  async approve(userCode: string, identity: AccessIdentity): Promise<{ ok: true; status: 'approved'; user: { id: string; email: string } }> {
    const code = normalizeUserCode(userCode);
    const row = this.sqlx<{
      device_hash: string; device_name: string; status: string; expires_at: number;
      user_id: string | null; user_email: string | null;
    }>(
      `SELECT device_hash, device_name, status, expires_at, user_id, user_email
       FROM cli_auth_requests WHERE user_code = ?`,
      code,
    )[0];
    if (!row) throw new Error('Unknown CLI auth code.');
    if (row.status === 'approved') {
      return {
        ok: true,
        status: 'approved',
        user: { id: row.user_id ?? identity.userId, email: row.user_email ?? identity.email },
      };
    }
    if (row.status !== 'pending' || Date.now() > row.expires_at) {
      this.sqlx(`UPDATE cli_auth_requests SET status = 'expired' WHERE device_hash = ?`, row.device_hash);
      throw new Error('CLI auth code expired. Run proteus auth again.');
    }

    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(identity.userId)) as DurableObjectStub<UserDO>;
    await userDO.ensureProfile(identity.email);
    const minted = await userDO.mintCliToken(identity.userId, row.device_name);
    const tokenExpiresAt = new Date(minted.expiresAt).toISOString();
    this.sqlx(
      `UPDATE cli_auth_requests
          SET status = 'approved', user_id = ?, user_email = ?, token = ?, token_exp = ?, approved_at = ?
        WHERE device_hash = ?`,
      identity.userId,
      identity.email,
      minted.token,
      tokenExpiresAt,
      Date.now(),
      row.device_hash,
    );
    return { ok: true, status: 'approved', user: { id: identity.userId, email: identity.email } };
  }
}

function cleanDeviceName(input?: string): string {
  const s = (input ?? 'terminal').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, 80) : 'terminal';
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
