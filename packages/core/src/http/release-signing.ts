/**
 * Release signing (SECURITY-devices C1): builds are signed with a key the deployment never holds, and daemon,
 * launcher and CLI verify against {@link RELEASE_SIGNING_PUBLIC_KEY} before any byte reaches a live path.
 * The signed message is the canonical text {@link releaseMessage} builds, never JSON.
 */
import * as v from 'valibot';

/** Hex. A rotation must ship under the old key first: older machines verify with the key they carry. */
export const RELEASE_SIGNING_PUBLIC_KEY = '232098b9f5cc9b300b903bb9f3347ecb2b62115b2711438ab7fab12d30bfbaef';

/** Operator-only override (test harness); never a wire input. */
export const RELEASE_SIGNING_PUBLIC_KEY_ENV = 'KINU_RELEASE_SIGNING_PUBLIC_KEY';

const MESSAGE_PREFIX = 'kinu-release-v1';

const ReleaseChecksumsSchema = v.record(
  v.pipe(v.string(), v.startsWith('/')),
  v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
);

export type ReleaseChecksums = v.InferOutput<typeof ReleaseChecksumsSchema>;

export const SignedReleaseSchema = v.object({
  version: v.pipe(v.string(), v.trim(), v.minLength(1)),
  checksums: ReleaseChecksumsSchema,
  signature: v.pipe(v.string(), v.regex(/^[A-Za-z0-9+/]+=*$/)),
});

export type SignedRelease = v.InferOutput<typeof SignedReleaseSchema>;

/** Codepoint order, never locale order: it is part of the signed bytes. */
function comparePaths(a: string, b: string): number {
  if (a < b) return -1;

  return a > b ? 1 : 0;
}

function releaseMessage(version: string, checksums: ReleaseChecksums): Uint8Array<ArrayBuffer> {
  const lines = Object.entries(checksums)
    .sort(([a], [b]) => comparePaths(a, b))
    .map(([path, sha256]) => `${path} ${sha256.toLowerCase()}`);

  return new TextEncoder().encode([MESSAGE_PREFIX, version, ...lines, ''].join('\n'));
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim().toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('an Ed25519 public key is 32 bytes of hex');

  return Uint8Array.from(clean.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

/** A malformed signature is false, never a throw. */
export async function verifyRelease(release: SignedRelease, publicKeyHex: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
  const signature = base64ToBytes(release.signature);

  if (signature.byteLength !== 64) return false;

  return crypto.subtle.verify('Ed25519', key, signature, releaseMessage(release.version, release.checksums));
}

/** Private key is PKCS#8 base64. */
export async function signRelease(version: string, checksums: ReleaseChecksums, privateKeyPkcs8Base64: string): Promise<SignedRelease> {
  const key = await crypto.subtle.importKey('pkcs8', base64ToBytes(privateKeyPkcs8Base64), { name: 'Ed25519' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, releaseMessage(version, checksums)));

  return { version, checksums, signature: bytesToBase64(signature) };
}

function isKeyPair(generated: CryptoKey | CryptoKeyPair): generated is CryptoKeyPair {
  return 'privateKey' in generated && 'publicKey' in generated;
}

export async function generateReleaseSigningKey(): Promise<{ publicKeyHex: string; privateKeyPkcs8Base64: string }> {
  // The Workers type union includes symmetric keys; Ed25519 must yield a pair.
  const generated: CryptoKey | CryptoKeyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);

  if (!isKeyPair(generated)) throw new Error('the runtime answered an Ed25519 key generation with no pair');
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', generated.publicKey));
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', generated.privateKey));

  return {
    publicKeyHex: [...publicKey].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    privateKeyPkcs8Base64: bytesToBase64(privateKey),
  };
}
