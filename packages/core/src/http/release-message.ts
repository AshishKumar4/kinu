/**
 * What a release signature covers, and the key it is checked against (SECURITY-devices C1). Dependency-free: core's
 * signer and verifier (release-signing.ts) and the device daemon's updater (pc-agent/src/update.js) read this one module.
 */
import { compareCodeUnits } from '../utils/text';

/** Hex. A rotation must ship under the old key first: older machines verify with the key they carry. */
export const RELEASE_SIGNING_PUBLIC_KEY = '232098b9f5cc9b300b903bb9f3347ecb2b62115b2711438ab7fab12d30bfbaef';

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
