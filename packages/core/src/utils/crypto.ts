/** Web-Crypto primitives shared by every path that checks a secret — core's
 *  webhook ingress, and the cf-backend session, capability and preview edges. */

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
