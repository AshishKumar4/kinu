/** Web-Crypto primitives shared by every path that mints or checks a secret. */
import { pkceChallenge, randomBase64Url } from '@nimbus-sh/sdk/oauth';

export { base64Url, randomBase64Url as randomToken } from '@nimbus-sh/sdk/oauth';

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomBase64Url(32);

  return { verifier, challenge: await pkceChallenge(verifier) };
}

/** SHA-256 digests live in `safety/argument-digest.ts` (`sha256Hex`). */

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;

  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;
}

export async function hmacSha256Signer(secret: string): Promise<(message: string) => Promise<string>> {
  const encoder = new TextEncoder();
  const encode = encoder.encode.bind(encoder);
  const sign = crypto.subtle.sign.bind(crypto.subtle);

  const key = await crypto.subtle.importKey(
    'raw',
    encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return async (message) => {
    const sig = await sign('HMAC', key, encode(message));

    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  };
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const sign = await hmacSha256Signer(secret);

  return sign(message);
}

