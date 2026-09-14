/**
 * A short signature over a public label, checked at the edge before anything
 * touches a Durable Object: a preview hostname, a blueprint address.
 *
 * WHY A SUBKEY. `CREDENTIAL_ENCRYPTION_KEY` also seals every credential the
 * owner stores (`user/credential-envelope.ts`), and a signature keyed by the
 * raw secret shares key material with that cipher, so a weakness in either
 * construction would implicate the other. HKDF with the caller's own salt and
 * info diverges a key nothing else holds; two signers with different labels
 * never verify each other's tokens. The secret's rotation list still applies,
 * because the subkey is derived from whichever secret is being tried.
 */

import { timingSafeEqual } from './crypto';

/** The two vars a signer reads: the live secret and its retired predecessors. */
export interface LabelSignerEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
}

export interface LabelSigner {
  /** The secrets a token may verify under: the current one first, then the retired list. */
  secrets(env: LabelSignerEnv): string[];
  /** The token for `message` under one secret. */
  token(secret: string, message: string): Promise<string>;
  /** Whether `token` was minted for `message` under any secret this deployment still honours. */
  verify(env: LabelSignerEnv, message: string, token: string): Promise<boolean>;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase RFC-4648 base32 without padding — the alphabet a DNS label admits. */
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

/**
 * One signer per (salt, info) pair. `length` is the token's base32 length;
 * 15 characters carry 75 bits, which is what a DNS label budget allows and
 * more than a guess can enumerate.
 */
export function labelSigner(salt: string, info: string, length = 15): LabelSigner {
  /** Signing keys, cached by secret. The derivation is deterministic over
   *  material the isolate already holds, so the cache adds no exposure and
   *  removes an HKDF from every request. */
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
    secrets(env) {
      const current = env.CREDENTIAL_ENCRYPTION_KEY?.trim();

      if (!current) return [];

      const retired = (env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      return [current, ...retired];
    },
    async token(secret, message) {
      const digest = await crypto.subtle.sign('HMAC', await signingKey(secret), utf8(message));

      return base32(new Uint8Array(digest)).slice(0, length);
    },
    async verify(env, message, token) {
      const expected = await Promise.all(signer.secrets(env).map((secret) => signer.token(secret, message)));

      return expected.some((candidate) => timingSafeEqual(token, candidate));
    },
  };

  return signer;
}
