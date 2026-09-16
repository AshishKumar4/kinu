#!/usr/bin/env bun
/**
 * Sign one build's published artifacts and write the release manifest.
 *
 * `bun scripts/sign-release.ts <out dir> <version> <sha>` reads every
 * `<artifact>.sha256` in the directory, signs the (version, checksums) set
 * with the build lane's private key and writes `kinu-version.json` carrying
 * the stamp, the checksums and the signature — the one manifest the daemon,
 * the launcher and the CLI verify against their pinned public key. The key
 * comes from `KINU_RELEASE_SIGNING_KEY` or the key file
 * `scripts/release-signing-key.ts` wrote; a build with neither is refused,
 * because an unsigned release is one every machine refuses.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_SIGNING_PUBLIC_KEY, signRelease, verifyRelease, type ReleaseChecksums } from '../packages/core/src/http/release-signing';

const [outDir, version, sha] = process.argv.slice(2);

if (!outDir || !version || !sha) {
  console.error('usage: bun scripts/sign-release.ts <out dir> <version> <sha>');
  process.exit(2);
}

const keyFile = process.env.KINU_RELEASE_SIGNING_KEY_FILE ?? join(homedir(), '.config', 'kinu', 'release-signing.key');

const privateKey = process.env.KINU_RELEASE_SIGNING_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf-8').trim() : '');

if (privateKey === '') {
  console.error(`sign-release: no signing key — set KINU_RELEASE_SIGNING_KEY or run scripts/release-signing-key.ts (${keyFile})`);
  process.exit(1);
}

const checksums: ReleaseChecksums = {};

for (const name of readdirSync(outDir)) {
  if (!name.endsWith('.sha256')) continue;
  const digest = readFileSync(join(outDir, name), 'utf-8').trim().split(/\s+/)[0] ?? '';

  if (!/^[0-9a-f]{64}$/i.test(digest)) {
    console.error(`sign-release: ${name} holds no sha256`);
    process.exit(1);
  }

  checksums[`/downloads/${name.slice(0, -'.sha256'.length)}`] = digest.toLowerCase();
}

if (Object.keys(checksums).length === 0) {
  console.error(`sign-release: no artifact checksums under ${outDir}`);
  process.exit(1);
}

const signed = await signRelease(version, checksums, privateKey);

const publicKey = process.env.KINU_RELEASE_SIGNING_PUBLIC_KEY ?? RELEASE_SIGNING_PUBLIC_KEY;

// The key that signed must be the key the shipped bundles pin, or every
// machine refuses this release: proven here, before the manifest is written.
if (!await verifyRelease(signed, publicKey)) {
  console.error('sign-release: the signing key does not match the pinned public key — rotate the pin with the key');
  process.exit(1);
}

const stamp = { version, sha, builtAt: new Date().toISOString(), checksums: signed.checksums, signature: signed.signature };

writeFileSync(join(outDir, 'kinu-version.json'), `${JSON.stringify(stamp)}\n`);

console.log(`sign-release: signed ${String(Object.keys(checksums).length)} artifact(s) for ${version}`);
