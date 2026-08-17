/**
 * Encryption at rest for the credential store.
 *
 * Every token Proteus MINTS is stored as a SHA-256 hash — cli tokens, device
 * tokens, workspace capabilities, connect tickets. The third-party secrets
 * Proteus holds on the owner's behalf cannot be hashed, because they have to
 * be replayed outbound, so they were the one thing in the DO written in the
 * clear. This module is the missing half: a sealed envelope around
 * `user_credentials.value`, keyed from a Worker secret rather than from the
 * database it protects.
 *
 * Envelope format, chosen so a reader can tell at a glance what a row is:
 *
 *   pce1.<keyId>.<iv>.<ciphertext>      AES-256-GCM, base64url, no padding
 *
 * A value that does not carry that prefix is a row written before encryption
 * existed; `open` returns it unchanged so nothing is lost, and `rewrap` in
 * user-do.ts converts it. The caller's `aad` — which composes the owning
 * Durable Object's id with the record's own key — is the AEAD's additional
 * data, so a ciphertext moved to a different row, or into a different user's
 * store, fails to open rather than silently authenticating one provider with
 * another's secret.
 *
 * Keys and rotation. `CREDENTIAL_ENCRYPTION_KEY` is the current key; every
 * write uses it. `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` is a comma-separated
 * list of retired keys, used for reading only. `keyId` is a PRF of the secret
 * (never a digest of it), so a row names the key that sealed it without
 * carrying anything a guess could be checked against, and a rotation is:
 *
 *   1. move the current value into CREDENTIAL_ENCRYPTION_KEY_PREVIOUS
 *   2. put the new value in CREDENTIAL_ENCRYPTION_KEY
 *   3. the next credential access re-wraps every row under the new key
 *   4. drop the retired key from PREVIOUS once every UserDO has been touched
 *
 * There is no default key and no plaintext fallback: a deployment without the
 * secret cannot store a credential at all. A secret store whose key is
 * optional is a plaintext store with extra steps.
 */
import { hmacSha256Hex } from '../lib/crypto.js';

const ENVELOPE_PREFIX = 'pce1.';
const KEY_ID_LENGTH = 16;
const IV_BYTES = 12;
const HKDF_INFO = 'proteus.credential-envelope.v1';
const HKDF_SALT = 'proteus.credential-envelope.salt';
/** The key id is a PRF of the secret, not a hash of it: every stored row
 *  carries the id in the clear, and a truncated digest of the secret itself
 *  would be an offline oracle for checking guesses against it. */
const KEY_ID_LABEL = 'proteus.credential-envelope.key-id';
/** Below this a "secret" is a passphrase, and the envelope would be theatre.
 *  32 base64 characters is 24 bytes of a `openssl rand -base64 32` value. */
const MIN_SECRET_LENGTH = 32;

export const CREDENTIAL_ENCRYPTION_KEY_HINT =
  'Set the CREDENTIAL_ENCRYPTION_KEY secret (openssl rand -base64 32 | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY).';

export interface CredentialCipher {
  /** Key id every new write seals under — also the rewrap marker. */
  readonly keyId: string;
  /** `aad` names the record: the caller composes it from whatever the value
   *  must stay bound to (its store's identity and its own key), and the same
   *  string must be presented to open it again. */
  seal(aad: string, plaintext: string): Promise<string>;
  /** Decrypt, or pass a pre-encryption plaintext row through unchanged. */
  open(aad: string, stored: string): Promise<string>;
}

export interface CredentialEncryptionEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
}

/** Derived keys, cached by secret. Derivation is a KDF over material the
 *  process already holds, so caching adds no exposure and removes an HKDF from
 *  every credential read. */
const derived = new Map<string, Promise<{ keyId: string; key: CryptoKey }>>();

/**
 * The cipher for this deployment. Throws when no key is configured — callers
 * are credential reads and writes, and failing there is the point.
 */
export async function createCredentialCipher(env: CredentialEncryptionEnv): Promise<CredentialCipher> {
  const current = (env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim();
  if (!current) {
    throw new Error(`Credentials cannot be stored or read: no encryption key is configured. ${CREDENTIAL_ENCRYPTION_KEY_HINT}`);
  }
  if (current.length < MIN_SECRET_LENGTH) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY is too short to be a key (${current.length} chars). ${CREDENTIAL_ENCRYPTION_KEY_HINT}`);
  }
  const retired = (env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',').map((s) => s.trim()).filter((s) => s.length > 0);

  return {
    keyId: (await deriveKey(current)).keyId,

    async seal(aad, plaintext) {
      const { keyId, key } = await deriveKey(current);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: utf8(aad) },
        key,
        utf8(plaintext),
      );
      return `${ENVELOPE_PREFIX}${keyId}.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
    },

    async open(aad, stored) {
      if (!stored.startsWith(ENVELOPE_PREFIX)) return stored;
      const [keyId, ivPart, ctPart] = stored.slice(ENVELOPE_PREFIX.length).split('.');
      if (!keyId || !ivPart || !ctPart) {
        throw new Error(`Record "${aad}" is stored in an envelope this build cannot parse.`);
      }
      for (const secret of [current, ...retired]) {
        const candidate = await deriveKey(secret);
        if (candidate.keyId !== keyId) continue;
        try {
          const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: unbase64url(ivPart), additionalData: utf8(aad) },
            candidate.key,
            unbase64url(ctPart),
          );
          return new TextDecoder().decode(plaintext);
        } catch {
          throw new Error(`Record "${aad}" failed to decrypt — the stored envelope does not match its key, or belongs to another store.`);
        }
      }
      throw new Error(
        `Record "${aad}" was sealed with encryption key ${keyId}, which this deployment no longer has. `
        + 'Restore it in CREDENTIAL_ENCRYPTION_KEY_PREVIOUS, or reconnect the provider.',
      );
    },
  };
}

/** True for a value this module wrote — the reader's test for "already sealed". */
export function isSealedCredential(stored: string): boolean {
  return stored.startsWith(ENVELOPE_PREFIX);
}

function deriveKey(secret: string): Promise<{ keyId: string; key: CryptoKey }> {
  let pending = derived.get(secret);
  if (!pending) {
    pending = (async () => {
      const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8(HKDF_SALT), info: utf8(HKDF_INFO) },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      return { keyId: (await hmacSha256Hex(secret, KEY_ID_LABEL)).slice(0, KEY_ID_LENGTH), key };
    })();
    derived.set(secret, pending);
  }
  return pending;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
