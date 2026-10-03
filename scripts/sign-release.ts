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
import { RELEASE_SIGNING_PUBLIC_KEY, signRelease, verifyRelease, type ReleaseChecksums, type SignedRelease } from '../packages/core/src/http/release-signing';

if (process.argv.length === 3 && process.argv[2] === '--check') {
  await signConfiguredRelease('signing-key-check', {});
  console.log('sign-release: signing key matches the public pin');
  process.exit(0);
}

const [outDir, version, sha] = process.argv.slice(2);

if (!outDir || !version || !sha) {
  console.error('usage: bun scripts/sign-release.ts --check | <out dir> <version> <sha>');
  process.exit(2);
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

const signed = await signConfiguredRelease(version, checksums);

const stamp = { version, sha, builtAt: new Date().toISOString(), checksums: signed.checksums, signature: signed.signature };

writeFileSync(join(outDir, 'kinu-version.json'), `${JSON.stringify(stamp)}\n`);

console.log(`sign-release: signed ${String(Object.keys(checksums).length)} artifact(s) for ${version}`);

async function signConfiguredRelease(buildVersion: string, artifactChecksums: ReleaseChecksums): Promise<SignedRelease> {
  const keyFile = process.env.KINU_RELEASE_SIGNING_KEY_FILE ?? join(homedir(), '.config', 'kinu', 'release-signing.key');
  const privateKey = process.env.KINU_RELEASE_SIGNING_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf-8').trim() : '');

  if (privateKey === '') refuseSigning(`no signing key — set KINU_RELEASE_SIGNING_KEY or create ${keyFile}`);
  const publicKey = process.env.KINU_RELEASE_SIGNING_PUBLIC_KEY ?? RELEASE_SIGNING_PUBLIC_KEY;

  if (!/^[0-9a-f]{64}$/i.test(publicKey)) refuseSigning('no valid public pin — an Ed25519 public key is 64 hex characters');
  const release = await signRelease(buildVersion, artifactChecksums, privateKey);

  if (!await verifyRelease(release, publicKey)) refuseSigning('the signing key does not match the pinned public key');

  return release;
}

function refuseSigning(reason: string): never {
  console.error(`sign-release: ${reason}\n` +
    '  Generate a private key with: bun scripts/release-signing-key.ts\n' +
    '  Pin its printed public key in packages/core/src/http/release-signing.ts and packages/pc-agent/src/update.js.\n' +
    '  See docs/SELF-HOSTING.md#release-signing for the complete bootstrap.');
  process.exit(1);
}
