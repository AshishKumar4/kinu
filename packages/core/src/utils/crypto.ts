/** Web-Crypto primitives shared by every path that mints or checks a secret. */

/** URL-safe base64, padding trimmed. The only encoder: PKCE (RFC 7636) compares the challenge as a string. */
export function base64Url(bytes: Uint8Array): string {
  let bin = '';

  for (const byte of bytes) bin += String.fromCharCode(byte);

  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function randomToken(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** SHA-256 digests live in `safety/argument-digest.ts` (`sha256Hex`). */

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;

  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;
}

/** Lowercase-hex HMAC-SHA256 of `message` under `secret`. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));

  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

