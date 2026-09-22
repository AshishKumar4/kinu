/** Sealed envelope `pce1.<keyId>.<iv>.<ciphertext>` (AES-GCM, AAD binds DO id + record key) around `user_credentials.value`.
 *  No default key or plaintext fallback. Rotation: move current to `_PREVIOUS`, set new, drop old once every UserDO rewraps. */
import { hmacSha256Hex } from '../utils/crypto';

const ENVELOPE_PREFIX = 'pce1.';

const KEY_ID_LENGTH = 16;

const IV_BYTES = 12;

const HKDF_INFO = 'kinu.credential-envelope.v1';

const HKDF_SALT = 'kinu.credential-envelope.salt';

/** A PRF, not a digest: the id is stored in the clear and a digest would be a guess oracle. */
const KEY_ID_LABEL = 'kinu.credential-envelope.key-id';

/** Below this a "secret" is a passphrase. */
const MIN_SECRET_LENGTH = 32;

const CREDENTIAL_ENCRYPTION_KEY_HINT =
  'Set the CREDENTIAL_ENCRYPTION_KEY secret (openssl rand -base64 32 | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY).';

export interface CredentialCipher {
  /** Also the rewrap marker. */
  readonly keyId: string;
  /** The same `aad` (store identity + record key) must be presented to open it again. */
  seal(aad: string, plaintext: string): Promise<string>;
  /** Passes a pre-encryption plaintext row through unchanged. */
  open(aad: string, stored: string): Promise<string>;
}

export interface CredentialEncryptionEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
}

/** Cached by secret: removes an HKDF from every read with no added exposure. */
const derived = new Map<string, Promise<{ keyId: string; key: CryptoKey }>>();

/** Throws when no key is configured. */
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
      if (!isSealedCredential(stored)) return stored;
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
        } catch (error) {
          throw new Error(
            `Record "${aad}" failed to decrypt — the stored envelope does not match its key, or belongs to another store.`,
            { cause: error },
          );
        }
      }

      throw new Error(
        `Record "${aad}" was sealed with encryption key ${keyId}, which this deployment no longer has. `
        + 'Restore it in CREDENTIAL_ENCRYPTION_KEY_PREVIOUS, or reconnect the provider.',
      );
    },
  };
}

function isSealedCredential(stored: string): boolean {
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
