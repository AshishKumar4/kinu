/** Built-in accounts, all in one object so what must happen once does: the owner seat, an invite, a challenge. */
import * as v from 'valibot';

/** The one object every built-in account lives in; a UserDO name no derived userId (32 hex) can equal. */
export const BUILTIN_ACCOUNTS_OBJECT = 'kinu:builtin-accounts';

/** A tagged-template executor over scalars: an Agent's own `sql` is one. */
export type BuiltinSql = <T = unknown>(query: TemplateStringsArray, ...values: (string | number | null)[]) => T[];

export type BuiltinRole = 'owner' | 'member';

export interface PasswordHash {
  readonly hash: string;
  readonly salt: string;
  readonly iterations: number;
}

export interface StoredPasskey {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly transports: readonly string[];
}

export interface NewBuiltinAccount {
  readonly userId: string;
  readonly email: string;
  readonly inviteHash: string | null;
  readonly password?: PasswordHash;
  readonly passkey?: StoredPasskey;
}

export type Admission = { readonly admitted: true; readonly role: BuiltinRole } | { readonly admitted: false; readonly reason: string };

export type ChallengePurpose = 'register' | 'authenticate';

export interface PendingChallenge {
  readonly purpose: ChallengePurpose;
  readonly userId: string | null;
  readonly email: string | null;
  readonly inviteHash: string | null;
}

export function initBuiltinAccounts(sql: BuiltinSql): void {
  void sql`CREATE TABLE IF NOT EXISTS builtin_accounts (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    password_hash TEXT,
    password_salt TEXT,
    password_iterations INTEGER,
    created_at INTEGER NOT NULL
  )`;
  void sql`CREATE UNIQUE INDEX IF NOT EXISTS builtin_accounts_one_owner ON builtin_accounts (role) WHERE role = 'owner'`;
  void sql`CREATE TABLE IF NOT EXISTS builtin_passkeys (
    credential_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`;
  void sql`CREATE TABLE IF NOT EXISTS builtin_invites (
    token_hash TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by TEXT,
    used_at INTEGER
  )`;
  void sql`CREATE TABLE IF NOT EXISTS builtin_challenges (
    challenge TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),
    user_id TEXT,
    email TEXT,
    invite_hash TEXT,
    expires_at INTEGER NOT NULL
  )`;
}

export function hasBuiltinOwner(sql: BuiltinSql): boolean {
  return sql`SELECT 1 FROM builtin_accounts WHERE role = 'owner' LIMIT 1`.length > 0;
}

export function isBuiltinOwner(sql: BuiltinSql, userId: string): boolean {
  return sql`SELECT 1 FROM builtin_accounts WHERE user_id = ${userId} AND role = 'owner'`.length > 0;
}

/** Reads only; `registerBuiltinAccount` decides. */
export function builtinAdmission(sql: BuiltinSql, email: string, inviteHash: string | null, now: number): Admission {
  if (sql`SELECT 1 FROM builtin_accounts WHERE email = ${email}`.length > 0) {
    return { admitted: false, reason: 'An account with this email already exists. Sign in instead.' };
  }

  if (!hasBuiltinOwner(sql)) return { admitted: true, role: 'owner' };

  if (inviteHash === null) return { admitted: false, reason: 'This deployment already has an owner. Ask them for an invite link.' };

  const live = sql`SELECT 1 FROM builtin_invites WHERE token_hash = ${inviteHash} AND used_by IS NULL AND expires_at > ${now}`.length > 0;

  return live ? { admitted: true, role: 'member' } : { admitted: false, reason: 'This invite link was already used or has expired. Ask for a new one.' };
}

/** One step: the owner seat or the invite goes to exactly this account, or nothing is written. */
export function registerBuiltinAccount(sql: BuiltinSql, account: NewBuiltinAccount, now: number): Admission {
  const admission = builtinAdmission(sql, account.email, account.inviteHash, now);

  if (!admission.admitted) return admission;

  if (admission.role === 'member') {
    void sql`UPDATE builtin_invites SET used_by = ${account.userId}, used_at = ${now} WHERE token_hash = ${account.inviteHash}`;
  }

  void sql`INSERT INTO builtin_accounts (user_id, email, role, password_hash, password_salt, password_iterations, created_at)
      VALUES (${account.userId}, ${account.email}, ${admission.role}, ${account.password?.hash ?? null},
              ${account.password?.salt ?? null}, ${account.password?.iterations ?? null}, ${now})`;

  if (account.passkey) {
    const { credentialId, publicKey, counter, transports } = account.passkey;

    void sql`INSERT INTO builtin_passkeys (credential_id, user_id, public_key, counter, transports, created_at)
        VALUES (${credentialId}, ${account.userId}, ${publicKey}, ${counter}, ${JSON.stringify(transports)}, ${now})`;
  }

  return admission;
}

export interface PasswordAccount extends PasswordHash {
  readonly userId: string;
  readonly email: string;
}

const PasswordRowSchema = v.object({
  user_id: v.string(), email: v.string(), password_hash: v.string(), password_salt: v.string(), password_iterations: v.number(),
});

/** Null when no account has this email, or it signs in only with a passkey. */
export function findPasswordAccount(sql: BuiltinSql, email: string): PasswordAccount | null {
  const parsed = v.safeParse(PasswordRowSchema, sql`SELECT user_id, email, password_hash, password_salt, password_iterations
    FROM builtin_accounts WHERE email = ${email} AND password_hash IS NOT NULL`[0]);

  if (!parsed.success) return null;
  const row = parsed.output;

  return { userId: row.user_id, email: row.email, hash: row.password_hash, salt: row.password_salt, iterations: row.password_iterations };
}

export interface PasskeyAccount extends StoredPasskey {
  readonly userId: string;
  readonly email: string;
}

const PasskeyRowSchema = v.object({
  user_id: v.string(), email: v.string(), public_key: v.string(), counter: v.number(),
  transports: v.pipe(v.string(), v.parseJson(), v.array(v.string())),
});

export function findPasskeyAccount(sql: BuiltinSql, credentialId: string): PasskeyAccount | null {
  const parsed = v.safeParse(PasskeyRowSchema, sql`SELECT p.user_id, a.email, p.public_key, p.counter, p.transports
    FROM builtin_passkeys p JOIN builtin_accounts a ON a.user_id = p.user_id WHERE p.credential_id = ${credentialId}`[0]);

  if (!parsed.success) return null;
  const row = parsed.output;

  return { userId: row.user_id, email: row.email, credentialId, publicKey: row.public_key, counter: row.counter, transports: row.transports };
}

export function recordPasskeyUse(sql: BuiltinSql, credentialId: string, counter: number): void {
  void sql`UPDATE builtin_passkeys SET counter = ${counter} WHERE credential_id = ${credentialId}`;
}

export function issuePasskeyChallenge(sql: BuiltinSql, challenge: string, pending: PendingChallenge, expiresAt: number): void {
  void sql`DELETE FROM builtin_challenges WHERE expires_at <= ${Date.now()}`;
  void sql`INSERT INTO builtin_challenges (challenge, purpose, user_id, email, invite_hash, expires_at)
      VALUES (${challenge}, ${pending.purpose}, ${pending.userId}, ${pending.email}, ${pending.inviteHash}, ${expiresAt})`;
}

const ChallengeRowSchema = v.object({
  purpose: v.picklist(['register', 'authenticate']), user_id: v.nullable(v.string()), email: v.nullable(v.string()),
  invite_hash: v.nullable(v.string()), expires_at: v.number(),
});

/** Deleted as it is read: a challenge answers one ceremony. */
export function spendPasskeyChallenge(sql: BuiltinSql, challenge: string, purpose: ChallengePurpose, now: number): PendingChallenge | null {
  const parsed = v.safeParse(ChallengeRowSchema, sql`DELETE FROM builtin_challenges WHERE challenge = ${challenge}
    RETURNING purpose, user_id, email, invite_hash, expires_at`[0]);

  if (!parsed.success || parsed.output.purpose !== purpose || parsed.output.expires_at <= now) return null;
  const row = parsed.output;

  return { purpose, userId: row.user_id, email: row.email, inviteHash: row.invite_hash };
}

export interface NewInvite {
  readonly ownerUserId: string;
  readonly tokenHash: string;
  readonly expiresAt: number;
}

export function createBuiltinInvite(sql: BuiltinSql, invite: NewInvite, now: number): boolean {
  if (!isBuiltinOwner(sql, invite.ownerUserId)) return false;
  void sql`INSERT INTO builtin_invites (token_hash, created_by, created_at, expires_at)
      VALUES (${invite.tokenHash}, ${invite.ownerUserId}, ${now}, ${invite.expiresAt})`;

  return true;
}
