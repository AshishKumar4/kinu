/**
 * Release signing (SECURITY-devices C1): builds are signed with a key the deployment never holds, and daemon,
 * launcher and CLI verify against `RELEASE_SIGNING_PUBLIC_KEY` before any byte reaches a live path. The signed
 * message is the canonical text `releaseMessage` builds, never JSON (release-message.ts, which the daemon reads too).
 */
import { Effect } from 'effect';
import { settle } from '../obs/effect';
import * as v from 'valibot';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { releaseMessage } from './release-message';

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

/** Private key is PKCS#8 base64. */
export async function signRelease(version: string, checksums: ReleaseChecksums, privateKeyPkcs8Base64: string): Promise<SignedRelease> {
  const key = await crypto.subtle.importKey('pkcs8', base64ToBytes(privateKeyPkcs8Base64), { name: 'Ed25519' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, releaseMessage(version, checksums)));

  return { version, checksums, signature: bytesToBase64(signature) };
}

function isKeyPair(generated: CryptoKey | CryptoKeyPair): generated is CryptoKeyPair {
  return 'privateKey' in generated && 'publicKey' in generated;
}

export function generateReleaseSigningKey(): Promise<{ publicKeyHex: string; privateKeyPkcs8Base64: string }> {
  return settle(Effect.gen(function* () {
    // The Workers type union includes symmetric keys; Ed25519 must yield a pair.
    const generated: CryptoKey | CryptoKeyPair = yield* Effect.promise(() => crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']));

    if (!isKeyPair(generated)) return yield* Effect.die(new Error('the runtime answered an Ed25519 key generation with no pair'));
    const publicKey = new Uint8Array(yield* Effect.promise(() => crypto.subtle.exportKey('raw', generated.publicKey)));
    const privateKey = new Uint8Array(yield* Effect.promise(() => crypto.subtle.exportKey('pkcs8', generated.privateKey)));

    return {
      publicKeyHex: [...publicKey].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      privateKeyPkcs8Base64: bytesToBase64(privateKey),
    };
  }));
}
