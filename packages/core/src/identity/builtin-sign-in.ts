import { base64Url, hmacSha256Hex, randomToken, timingSafeEqual } from '../utils/crypto';
import { sha256Hex } from '../safety/argument-digest';
import type { AttemptBucket, Grant, PasswordAccount, PasswordHash } from './builtin-accounts';

const PASSWORD_ITERATIONS = 100_000;

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const attemptBuckets = {
  passwordEmail: (email: string): AttemptBucket => ({ key: `password-email:${email}`, free: 5 }),
  passwordAddress: (address: string): AttemptBucket => ({ key: `password-address:${address}`, free: 20 }),
  passkey: (address: string): AttemptBucket => ({ key: `passkey-address:${address}`, free: 20 }),
  register: (address: string): AttemptBucket => ({ key: `register-address:${address}`, free: 10 }),
  challenge: (address: string): AttemptBucket => ({ key: `challenge-address:${address}`, free: 30 }),
};

const pepper = (root: string): Promise<string> => hmacSha256Hex(root, 'kinu.builtin-password-pepper.v1');

async function derive(password: string, salt: string, root: string): Promise<string> {
  const peppered = await hmacSha256Hex(await pepper(root), password);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(peppered), 'PBKDF2', false, ['deriveBits']);

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PASSWORD_ITERATIONS }, key, 256,
  );

  return base64Url(new Uint8Array(bits));
}

export async function hashPassword(root: string, password: string): Promise<PasswordHash> {
  const salt = randomToken(16);

  return { hash: await derive(password, salt, root), salt, iterations: PASSWORD_ITERATIONS };
}

export interface PasswordCheck {
  readonly matched: boolean;
  readonly rehash: PasswordHash | null;
}

export async function checkPassword(roots: { current: string; previous: readonly string[] }, password: string, stored: PasswordAccount | null): Promise<PasswordCheck> {
  // Unknown emails cost the same hash.
  const current = await derive(password, stored?.salt ?? 'no-such-account', roots.current);

  if (stored === null) return { matched: false, rehash: null };

  if (timingSafeEqual(current, stored.hash)) return { matched: true, rehash: null };

  for (const key of roots.previous) {
    if (timingSafeEqual(await derive(password, stored.salt, key), stored.hash)) return { matched: true, rehash: await hashPassword(roots.current, password) };
  }

  return { matched: false, rehash: null };
}

function setupTokenMatches(secret: string | undefined, presented: string | null): boolean {
  const configured = (secret ?? '').trim();

  if (configured === '' || presented === null) return false;

  return timingSafeEqual(sha256Hex(presented), sha256Hex(configured));
}

export function grantOf(tokens: { invite?: string | null; reset?: string | null; setup?: string | null }, setupSecret: string | undefined): Grant {
  if (tokens.reset) return { kind: 'reset', hash: sha256Hex(tokens.reset) };

  if (tokens.invite) return { kind: 'invite', hash: sha256Hex(tokens.invite) };

  return setupTokenMatches(setupSecret, tokens.setup ?? null) ? { kind: 'setup' } : { kind: 'none' };
}
