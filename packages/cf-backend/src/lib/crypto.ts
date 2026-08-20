// Shared token/hash primitives for cf-backend — one home instead of per-file
// copies in the auth, CLI, and route modules.

/** URL-safe base64 token from `bytes` of CSPRNG output. */
export function randomToken(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const bytes = input instanceof ArrayBuffer ? input : new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase-hex HMAC-SHA256. Used to derive values that must be
 *  unforgeable without the secret (webhook signatures, the owner capability). */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison — guards secret checks against
 *  timing-side-channel enumeration. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
