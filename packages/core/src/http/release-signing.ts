/**
 * Release signing: what makes a published build KINU'S bytes and not merely
 * the hub's.
 *
 * A daemon's UPDATE frame and the CLI's refresh used to prove one thing — the
 * archive hashes to the checksum the origin published — and the origin chose
 * both. A hostile or compromised deployment therefore had silent, persistent
 * code execution on every connected machine (SECURITY-devices C1, proven end
 * to end with a trojaned tarball on 2026-09-16). So every release is signed
 * at build with a key the deployment never holds: the build lane signs the
 * artifact checksums with `KINU_RELEASE_SIGNING_KEY`, publishes the signature
 * beside them in `kinu-version.json`, and the daemon, the launcher and the
 * CLI verify it against {@link RELEASE_SIGNING_PUBLIC_KEY}, pinned into their
 * bundles at build, BEFORE any byte reaches a live path. A checksum the
 * signature does not cover is refused; a frame whose signature fails is
 * logged and refused.
 *
 * Ed25519 over WebCrypto, so one implementation runs under Bun, Node and the
 * Workers runtime. The message is the canonical text {@link releaseMessage}
 * builds, never a JSON encoding, so a reordered or re-serialized manifest
 * still verifies.
 */
import * as v from 'valibot';

/**
 * The public half of the release signing key, hex. Generated once with
 * `bun scripts/release-signing-key.ts`; the private half is the build lane's
 * secret and never a deployment binding. Rotating it is a build that ships
 * the new key: a machine on an older build verifies the next release with
 * the key it carries, so a rotation lands under the old key first.
 */
export const RELEASE_SIGNING_PUBLIC_KEY = '232098b9f5cc9b300b903bb9f3347ecb2b62115b2711438ab7fab12d30bfbaef';

/** The environment variable a machine's OWN operator may set to pin another
 *  public key — the test harness signs with a key of its own. Never a wire
 *  input: a hub cannot reach a daemon's environment. */
export const RELEASE_SIGNING_PUBLIC_KEY_ENV = 'KINU_RELEASE_SIGNING_PUBLIC_KEY';

const MESSAGE_PREFIX = 'kinu-release-v1';

const ReleaseChecksumsSchema = v.record(
  v.pipe(v.string(), v.startsWith('/')),
  v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
);

export type ReleaseChecksums = v.InferOutput<typeof ReleaseChecksumsSchema>;

/** What a signed release manifest carries beside the build stamp. */
export const SignedReleaseSchema = v.object({
  version: v.pipe(v.string(), v.trim(), v.minLength(1)),
  checksums: ReleaseChecksumsSchema,
  signature: v.pipe(v.string(), v.regex(/^[A-Za-z0-9+/]+=*$/)),
});

export type SignedRelease = v.InferOutput<typeof SignedReleaseSchema>;

/** The canonical bytes a release signature covers: the prefix, the version,
 *  then every artifact path with its checksum, sorted by path, one per line. */
/** Codepoint order, never locale order: this order is part of the bytes the
 *  signature covers, so it must be the same on every machine. */
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

/** Verify a release's signature against a public key. False for a
 *  signature that does not cover exactly this version and these checksums;
 *  a malformed signature is false too, never a throw — the caller refuses
 *  either way and logs which. */
export async function verifyRelease(release: SignedRelease, publicKeyHex: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
  const signature = base64ToBytes(release.signature);

  if (signature.byteLength !== 64) return false;

  return crypto.subtle.verify('Ed25519', key, signature, releaseMessage(release.version, release.checksums));
}

/** Sign a release with the private key (PKCS#8, base64) — the build lane's
 *  call, and the test harness's with a key of its own. */
export async function signRelease(version: string, checksums: ReleaseChecksums, privateKeyPkcs8Base64: string): Promise<SignedRelease> {
  const key = await crypto.subtle.importKey('pkcs8', base64ToBytes(privateKeyPkcs8Base64), { name: 'Ed25519' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, releaseMessage(version, checksums)));

  return { version, checksums, signature: bytesToBase64(signature) };
}

function isKeyPair(generated: CryptoKey | CryptoKeyPair): generated is CryptoKeyPair {
  return 'privateKey' in generated && 'publicKey' in generated;
}

/** A fresh Ed25519 pair: the public half as hex for pinning, the private
 *  half as PKCS#8 base64 for the build lane's secret. */
export async function generateReleaseSigningKey(): Promise<{ publicKeyHex: string; privateKeyPkcs8Base64: string }> {
  // Ed25519 is a pair; the union the Workers types declare for this call
  // covers the symmetric algorithms too, and a single key here would be a
  // runtime that did not do what was asked.
  const generated: CryptoKey | CryptoKeyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);

  if (!isKeyPair(generated)) throw new Error('the runtime answered an Ed25519 key generation with no pair');
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', generated.publicKey));
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', generated.privateKey));

  return {
    publicKeyHex: [...publicKey].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    privateKeyPkcs8Base64: bytesToBase64(privateKey),
  };
}
