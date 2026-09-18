/** Web-Crypto primitives shared by every path that mints or checks a secret —
 *  core's webhook ingress, and the session, capability and preview edges on
 *  either backend. */

/** URL-safe base64 of arbitrary bytes, padding trimmed. The one spelling: the
 *  run key, the run id and the PKCE verifier and challenge are all this
 *  encoding, and RFC 7636 makes it load-bearing — the authorization server
 *  compares the challenge as a STRING, so a second encoder that differed by a
 *  character would fail only against the live Cloudflare. */
export function base64Url(bytes: Uint8Array): string {
  let bin = '';

  for (const byte of bytes) bin += String.fromCharCode(byte);

  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** URL-safe base64 token from `bytes` of CSPRNG output. */
export function randomToken(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Lowercase-hex HMAC-SHA256 is below; SHA-256 digests live in
 *  `safety/argument-digest.ts` (`sha256Hex`), sync over node:crypto, shared by
 *  every backend under `nodejs_compat`. */

/** Constant-time string comparison — guards secret checks against
 *  timing-side-channel enumeration. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;

  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;
}

/** Lowercase-hex HMAC-SHA256 of `message` under `secret`. Derives values that
 *  must be unforgeable without the secret: webhook signatures, the owner
 *  capability, a credential envelope's key id. */
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

