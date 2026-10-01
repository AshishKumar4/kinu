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
  /** Only a request with the setup token takes the owner seat. */
  readonly setupProven: boolean;
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
  readonly setupProven: boolean;
  readonly resetHash: string | null;
}

export interface AttemptBucket {
  readonly key: string;
  readonly free: number;
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
    purpose TEXT NOT NULL CHECK (purpose IN ('join', 'reset')),
    email TEXT NOT NULL,
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
    reset_hash TEXT,
    setup_proven INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`;
  void sql`CREATE TABLE IF NOT EXISTS builtin_attempts (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    locked_until INTEGER NOT NULL
  )`;
}

export function hasBuiltinOwner(sql: BuiltinSql): boolean {
  return sql`SELECT 1 FROM builtin_accounts WHERE role = 'owner' LIMIT 1`.length > 0;
}

export function isBuiltinOwner(sql: BuiltinSql, userId: string): boolean {
  return sql`SELECT 1 FROM builtin_accounts WHERE user_id = ${userId} AND role = 'owner'`.length > 0;
}

export const NOT_ADMITTED = 'This sign-up link is not valid. Ask the owner of this deployment for an invite.';

/** No email lookup until a seat or invite admits. */
export function builtinAdmission(sql: BuiltinSql, request: Pick<NewBuiltinAccount, 'email' | 'inviteHash' | 'setupProven'>, now: number): Admission {
  if (!hasBuiltinOwner(sql)) return request.setupProven ? { admitted: true, role: 'owner' } : { admitted: false, reason: NOT_ADMITTED };

  const invited = request.inviteHash === null ? null : invitedEmail(sql, request.inviteHash, now);

  if (invited === null) return { admitted: false, reason: NOT_ADMITTED };

  if (invited !== request.email) return { admitted: false, reason: 'This invite is for a different email address.' };

  if (sql`SELECT 1 FROM builtin_accounts WHERE email = ${request.email}`.length > 0) {
    return { admitted: false, reason: 'An account with this email already exists. Sign in instead.' };
  }

  return { admitted: true, role: 'member' };
}

const InviteRowSchema = v.object({ email: v.string() });

export type InvitePurpose = 'join' | 'reset';

export function invitedEmail(sql: BuiltinSql, inviteHash: string, now: number, purpose: InvitePurpose = 'join'): string | null {
  const parsed = v.safeParse(InviteRowSchema, sql`SELECT email FROM builtin_invites
    WHERE token_hash = ${inviteHash} AND purpose = ${purpose} AND used_by IS NULL AND expires_at > ${now}`[0]);

  return parsed.success ? parsed.output.email : null;
}

/** One step: the owner seat or the invite goes to exactly this account, or nothing is written. */
export function registerBuiltinAccount(sql: BuiltinSql, account: NewBuiltinAccount, now: number): Admission {
  const admission = builtinAdmission(sql, account, now);

  if (!admission.admitted) return admission;

  if (admission.role === 'member') {
    void sql`UPDATE builtin_invites SET used_by = ${account.userId}, used_at = ${now}
      WHERE token_hash = ${account.inviteHash} AND purpose = 'join'`;
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
  void sql`INSERT INTO builtin_challenges (challenge, purpose, user_id, email, invite_hash, reset_hash, setup_proven, expires_at)
      VALUES (${challenge}, ${pending.purpose}, ${pending.userId}, ${pending.email}, ${pending.inviteHash}, ${pending.resetHash},
              ${pending.setupProven ? 1 : 0}, ${expiresAt})`;
}

const ChallengeRowSchema = v.object({
  purpose: v.picklist(['register', 'authenticate']), user_id: v.nullable(v.string()), email: v.nullable(v.string()),
  invite_hash: v.nullable(v.string()), reset_hash: v.nullable(v.string()), setup_proven: v.number(), expires_at: v.number(),
});

/** Deleted as it is read: a challenge answers one ceremony. */
export function spendPasskeyChallenge(sql: BuiltinSql, challenge: string, purpose: ChallengePurpose, now: number): PendingChallenge | null {
  const parsed = v.safeParse(ChallengeRowSchema, sql`DELETE FROM builtin_challenges WHERE challenge = ${challenge}
    RETURNING purpose, user_id, email, invite_hash, reset_hash, setup_proven, expires_at`[0]);

  if (!parsed.success || parsed.output.purpose !== purpose || parsed.output.expires_at <= now) return null;
  const row = parsed.output;

  return { purpose, userId: row.user_id, email: row.email, inviteHash: row.invite_hash, resetHash: row.reset_hash, setupProven: row.setup_proven === 1 };
}

export interface NewInvite {
  readonly ownerUserId: string;
  readonly purpose: InvitePurpose;
  readonly email: string;
  readonly tokenHash: string;
  readonly expiresAt: number;
}

export function createBuiltinInvite(sql: BuiltinSql, invite: NewInvite, now: number): boolean {
  if (!isBuiltinOwner(sql, invite.ownerUserId)) return false;
  const exists = sql`SELECT 1 FROM builtin_accounts WHERE email = ${invite.email}`.length > 0;

  if (exists !== (invite.purpose === 'reset')) return false;
  void sql`INSERT INTO builtin_invites (token_hash, purpose, email, created_by, created_at, expires_at)
      VALUES (${invite.tokenHash}, ${invite.purpose}, ${invite.email}, ${invite.ownerUserId}, ${now}, ${invite.expiresAt})`;

  return true;
}

const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const MAX_WAIT_MS = 15 * 60 * 1000;

const AttemptRowSchema = v.object({ count: v.number(), window_start: v.number(), locked_until: v.number() });

/** Counted before the work: 0, or ms to wait (doubling past `free`). */
export function reserveAttempt(sql: BuiltinSql, buckets: readonly AttemptBucket[], now: number): number {
  const rows = buckets.map((bucket) => {
    const parsed = v.safeParse(AttemptRowSchema, sql`SELECT count, window_start, locked_until FROM builtin_attempts WHERE bucket = ${bucket.key}`[0]);
    const live = parsed.success && now - parsed.output.window_start < FAILURE_WINDOW_MS ? parsed.output : null;

    return { bucket, count: live?.count ?? 0, windowStart: live?.window_start ?? now, lockedUntil: live?.locked_until ?? 0 };
  });

  const wait = Math.max(0, ...rows.map((row) => row.lockedUntil - now));

  if (wait > 0) return wait;

  for (const { bucket, count, windowStart } of rows) {
    const next = count + 1;
    const lockedUntil = next <= bucket.free ? 0 : now + Math.min(MAX_WAIT_MS, 1000 * 2 ** (next - bucket.free));

    void sql`INSERT INTO builtin_attempts (bucket, count, window_start, locked_until) VALUES (${bucket.key}, ${next}, ${windowStart}, ${lockedUntil})
      ON CONFLICT (bucket) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, locked_until = excluded.locked_until`;
  }

  return 0;
}

export function clearAttempts(sql: BuiltinSql, keys: readonly string[]): void {
  for (const key of keys) void sql`DELETE FROM builtin_attempts WHERE bucket = ${key}`;
}

export function replacePassword(sql: BuiltinSql, userId: string, password: PasswordHash): void {
  void sql`UPDATE builtin_accounts SET password_hash = ${password.hash}, password_salt = ${password.salt},
    password_iterations = ${password.iterations} WHERE user_id = ${userId}`;
}

export interface ResetAccount {
  readonly userId: string;
  readonly email: string;
}

const AccountRowSchema = v.object({ user_id: v.string(), email: v.string() });

export function resetAccount(sql: BuiltinSql, resetHash: string, now: number): ResetAccount | null {
  const email = invitedEmail(sql, resetHash, now, 'reset');
  const parsed = v.safeParse(AccountRowSchema, email === null ? undefined : sql`SELECT user_id, email FROM builtin_accounts WHERE email = ${email}`[0]);

  return parsed.success ? { userId: parsed.output.user_id, email: parsed.output.email } : null;
}

export interface Reset {
  readonly resetHash: string;
  readonly password?: PasswordHash;
  readonly passkey?: StoredPasskey;
}

export function applyReset(sql: BuiltinSql, reset: Reset, now: number): ResetAccount | null {
  const account = resetAccount(sql, reset.resetHash, now);

  if (account === null) return null;
  void sql`UPDATE builtin_invites SET used_by = ${account.userId}, used_at = ${now} WHERE token_hash = ${reset.resetHash}`;
  void sql`DELETE FROM builtin_passkeys WHERE user_id = ${account.userId}`;
  void sql`UPDATE builtin_accounts SET password_hash = ${reset.password?.hash ?? null}, password_salt = ${reset.password?.salt ?? null},
    password_iterations = ${reset.password?.iterations ?? null} WHERE user_id = ${account.userId}`;

  if (reset.passkey) {
    const { credentialId, publicKey, counter, transports } = reset.passkey;

    void sql`INSERT INTO builtin_passkeys (credential_id, user_id, public_key, counter, transports, created_at)
        VALUES (${credentialId}, ${account.userId}, ${publicKey}, ${counter}, ${JSON.stringify(transports)}, ${now})`;
  }

  return account;
}

export interface ListedAccount {
  readonly email: string;
  readonly role: BuiltinRole;
  readonly createdAt: number;
}

const ListedRowSchema = v.object({ email: v.string(), role: v.picklist(['owner', 'member']), created_at: v.number() });

export function listBuiltinAccounts(sql: BuiltinSql): ListedAccount[] {
  return v.parse(v.array(ListedRowSchema), sql`SELECT email, role, created_at FROM builtin_accounts ORDER BY created_at`)
    .map((row) => ({ email: row.email, role: row.role, createdAt: row.created_at }));
}
