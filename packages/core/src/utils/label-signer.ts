/**
 * Short signature over a public label (preview hostname, blueprint address), checked at the edge.
 * Signs with an HKDF subkey, never raw `CREDENTIAL_ENCRYPTION_KEY`, which also seals stored credentials.
 */

import { timingSafeEqual } from './crypto';

export interface LabelSignerEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

export interface LabelSigner {
  secret(env: LabelSignerEnv): string | undefined;
  token(secret: string, message: string): Promise<string>;
  /** Whether `token` was minted for `message` under this deployment's current secret. */
  verify(env: LabelSignerEnv, message: string, token: string): Promise<boolean>;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase RFC-4648 base32 without padding: the alphabet a DNS label admits. */
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let encoded = '';

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }

  if (bits > 0) encoded += BASE32[(buffer << (5 - bits)) & 31];

  return encoded;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

/** One signer per (salt, info) pair; `length` is the base32 token length (15 chars = 75 bits). */
export function labelSigner(salt: string, info: string, length = 15): LabelSigner {
  const signingKeys = new Map<string, Promise<CryptoKey>>();

  const signingKey = (secret: string): Promise<CryptoKey> => {
    let pending = signingKeys.get(secret);

    if (!pending) {
      pending = (async () => {
        const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']);

        return crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: utf8(salt), info: utf8(info) },
          material,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
      })();
      signingKeys.set(secret, pending);
    }

    return pending;
  };

  const signer: LabelSigner = {
    secret(env) {
      const current = env.CREDENTIAL_ENCRYPTION_KEY?.trim();

      return current === '' ? undefined : current;
    },
    async token(secret, message) {
      const digest = await crypto.subtle.sign('HMAC', await signingKey(secret), utf8(message));

      return base32(new Uint8Array(digest)).slice(0, length);
    },
    async verify(env, message, token) {
      const secret = signer.secret(env);

      return secret !== undefined && timingSafeEqual(token, await signer.token(secret, message));
    },
  };

  return signer;
}
