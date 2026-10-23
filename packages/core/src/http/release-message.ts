/**
 * What a release signature covers, the key it is checked against, and whether it holds (SECURITY-devices C1).
 * Dependency-free, Effect too: core's signer (release-signing.ts), the CLI, and the device daemon's CommonJS updater
 * (pc-agent/src/update.js) read this one module.
 */
import { base64ToBytes } from '../utils/base64';
import { compareCodeUnits } from '../utils/text';
import type { JsonObject, JsonValue } from '../utils/json';

/** Hex. A rotation must ship under the old key first: older machines verify with the key they carry. */
export const RELEASE_SIGNING_PUBLIC_KEY = '232098b9f5cc9b300b903bb9f3347ecb2b62115b2711438ab7fab12d30bfbaef';

/** A machine's own operator may pin another key through the environment (the test harness signs with its own); never a wire input. */
export const RELEASE_SIGNING_PUBLIC_KEY_ENV = 'KINU_RELEASE_SIGNING_PUBLIC_KEY';

/** The key a release is verified against: the operator's pin when the environment names one, else the built-in one. An
 *  empty value names none, as the installer reads it (`\${KINU_RELEASE_SIGNING_PUBLIC_KEY:-…}`), so every updater
 *  decides alike. */
export function releasePublicKey(env: Readonly<Record<string, string | undefined>>): string {
  const pinned = env[RELEASE_SIGNING_PUBLIC_KEY_ENV]?.trim() ?? '';

  return pinned === '' ? RELEASE_SIGNING_PUBLIC_KEY : pinned;
}

const MESSAGE_PREFIX = 'kinu-release-v1';

/** The canonical bytes a signature covers: prefix, version, then each artifact and its checksum by path, one per line. */
export function releaseMessage(version: string, checksums: Readonly<Record<string, string>>): Uint8Array<ArrayBuffer> {
  const lines = Object.entries(checksums)
    // Never locale order: the order is part of the signed bytes.
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([path, sha256]) => `${path} ${sha256.toLowerCase()}`);

  return new TextEncoder().encode([MESSAGE_PREFIX, version, ...lines, ''].join('\n'));
}

/** An Ed25519 public key as 64 hex digits, and a signature as the 88 base64 characters of its 64 bytes. */
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/iu;

const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/u;

/** A release as its signer wrote it: the version, each artifact's checksum by same-origin path, the signature. */
export interface SignedReleaseFields {
  readonly version: string;
  readonly checksums: Readonly<Record<string, string>>;
  readonly signature: string;
}

const DIGEST_HEX = /^[0-9a-f]{64}$/iu;

/** `value` as the string it is, or null: a frame from the wire is any JSON. */
const stringOf = (value: JsonValue | undefined): string | null => (typeof value === 'string' ? value : null);

/** `value` as the object it is, or an empty one. */
const objectOf = (value: JsonValue | undefined): JsonObject => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {});

/**
 * A signed release's fields read off the wire, as every updater reads them: a version, each artifact a same-origin
 * path with a SHA-256 in either case (kept lowercase, as `releaseMessage` signs it), and a base64 signature; otherwise
 * why not. Plain code, so the device daemon's CommonJS reads it too.
 */
export function readSignedRelease(raw: JsonValue): SignedReleaseFields | { readonly error: string } {
  const frame = objectOf(raw);
  const version = (stringOf(frame['version']) ?? '').trim();

  if (version === '') return { error: 'no version' };
  const signature = stringOf(frame['signature']);
  const listed = frame['checksums'];

  if (signature === null || typeof listed !== 'object' || listed === null || Array.isArray(listed) || !/^[A-Za-z0-9+/]+=*$/u.test(signature)) {
    return { error: 'no signature' };
  }

  const checksums: Record<string, string> = {};

  for (const [artifact, digest] of Object.entries(listed)) {
    const hex = stringOf(digest);

    if (!artifact.startsWith('/') || hex === null || !DIGEST_HEX.test(hex)) return { error: 'malformed checksums' };
    checksums[artifact] = hex.toLowerCase();
  }

  return { version, checksums, signature };
}

/** Why `bytes` are not the artifact a signed release names at `path`; null when they are. The signed map is the one
 *  authority: no checksum fetched beside it decides. */
export async function artifactRefusal(checksums: Readonly<Record<string, string>>, path: string, bytes: Uint8Array<ArrayBuffer>): Promise<string | null> {
  const signed = checksums[path];

  if (signed === undefined) return `the signed release names no ${path}`;
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return digest === signed.toLowerCase() ? null : `checksum mismatch for ${path}`;
}

/** Whether `release` is signed by the key `publicKeyHex` names. A key or a signature that is not well formed is false,
 *  never a throw; WebCrypto's own refusal propagates. */
export async function verifyRelease(
  release: { readonly version: string; readonly checksums: Readonly<Record<string, string>>; readonly signature: string },
  publicKeyHex: string,
): Promise<boolean> {
  if (!PUBLIC_KEY_HEX.test(publicKeyHex) || !SIGNATURE_BASE64.test(release.signature)) return false;
  const publicKey = Uint8Array.from(publicKeyHex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);

  return await crypto.subtle.verify('Ed25519', key, base64ToBytes(release.signature), releaseMessage(release.version, release.checksums));
}
