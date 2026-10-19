/**
 * What a release signature covers, the key it is checked against, and whether it holds (SECURITY-devices C1).
 * Dependency-free, Effect too: core's signer (release-signing.ts), the CLI, and the device daemon's CommonJS updater
 * (pc-agent/src/update.js) read this one module.
 */
import { base64ToBytes } from '../utils/base64';
import { compareCodeUnits } from '../utils/text';

/** Hex. A rotation must ship under the old key first: older machines verify with the key they carry. */
export const RELEASE_SIGNING_PUBLIC_KEY = 'b132a9d50c26f6fbce4109ef335919ee050f6ea664620af57cd2fe8a7493b33c';

/** A machine's own operator may pin another key through the environment (the test harness signs with its own); never a wire input. */
export const RELEASE_SIGNING_PUBLIC_KEY_ENV = 'KINU_RELEASE_SIGNING_PUBLIC_KEY';

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
