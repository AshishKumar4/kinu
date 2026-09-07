// Token/hash primitives that cf-backend owns because they are Workers-runtime
// shaped: `randomToken` mints URL-safe secrets, `sha256Hex` digests request
// bodies and tokens. Constant-time comparison and HMAC are NOT here — they are
// `@kinu.run/core`'s, shared with the core ingress paths that verify the same
// signatures.

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
