/** Release signature (SECURITY-devices C1): canonical text over (version, checksums), under the one pinned key. */
import { expect, test } from 'bun:test';
import { RELEASE_SIGNING_PUBLIC_KEY, RELEASE_SIGNING_PUBLIC_KEY_ENV, artifactRefusal, releasePublicKey, verifyRelease } from '../src/http/release-message';
import { generateReleaseSigningKey, signRelease } from '../src/http/release-signing';

const CHECKSUMS = { '/downloads/kinu-cli-linux-x64.tar.gz': 'a'.repeat(64), '/downloads/kinu-runtime-cpython.tar.gz': 'b'.repeat(64) };

test('a signature verifies under its key and under nothing else', async () => {
  const key = await generateReleaseSigningKey();
  const other = await generateReleaseSigningKey();
  const signed = await signRelease('1.0.0+abc', CHECKSUMS, key.privateKeyPkcs8Base64);

  expect(await verifyRelease(signed, key.publicKeyHex)).toBe(true);
  expect(await verifyRelease(signed, other.publicKeyHex)).toBe(false);
  expect(await verifyRelease({ ...signed, version: '1.0.1+abc' }, key.publicKeyHex)).toBe(false);
  expect(await verifyRelease({ ...signed, checksums: { ...CHECKSUMS, '/downloads/kinu-cli-linux-x64.tar.gz': 'c'.repeat(64) } }, key.publicKeyHex)).toBe(false);
  expect(await verifyRelease({ ...signed, checksums: { ...CHECKSUMS, '/downloads/extra.tar.gz': 'd'.repeat(64) } }, key.publicKeyHex)).toBe(false);
  expect(await verifyRelease({ ...signed, signature: 'AAAA' }, key.publicKeyHex)).toBe(false);
});

test('the message is canonical: the order the checksums arrive in does not change it', async () => {
  const key = await generateReleaseSigningKey();
  const signed = await signRelease('1.0.0', CHECKSUMS, key.privateKeyPkcs8Base64);
  const reversed = Object.fromEntries(Object.entries(CHECKSUMS).reverse());

  expect(await verifyRelease({ ...signed, checksums: reversed }, key.publicKeyHex)).toBe(true);
  const upper = Object.fromEntries(Object.entries(CHECKSUMS).map(([path, digest]) => [path, digest.toUpperCase()]));
  expect(await verifyRelease({ ...signed, checksums: upper }, key.publicKeyHex)).toBe(true);
});

// The device daemon refused a key or signature it could not read, where the CLI read past them; both verify here now.
test('a key or a signature that is not well formed verifies nothing, and never throws', async () => {
  const key = await generateReleaseSigningKey();
  const signed = await signRelease('1.0.0', CHECKSUMS, key.privateKeyPkcs8Base64);

  const verdicts = await Promise.all([
    verifyRelease(signed, ` ${key.publicKeyHex}\n`),
    verifyRelease(signed, key.publicKeyHex.slice(2)),
    verifyRelease(signed, 'z'.repeat(64)),
    verifyRelease({ ...signed, signature: `${signed.signature}=` }, key.publicKeyHex),
    verifyRelease({ ...signed, signature: signed.signature.replace(/==$/u, '') }, key.publicKeyHex),
  ]);

  expect(verdicts).toEqual([false, false, false, false, false]);
});

test('the pinned public key is a real Ed25519 key', async () => {
  // A signature of the right length, so the key itself is imported.
  const signature = `${'A'.repeat(86)}==`;

  await expect(verifyRelease({ version: '1.0.0', checksums: CHECKSUMS, signature }, RELEASE_SIGNING_PUBLIC_KEY)).resolves.toBe(false);
});

// The CLI verified against an empty pin and refused; the daemon and the installer read empty as no pin. One decision now.
test('an empty pin in the environment names no key: every updater falls back to the built-in one', () => {
  const ours = 'ab'.repeat(32);

  expect([{}, { [RELEASE_SIGNING_PUBLIC_KEY_ENV]: '' }, { [RELEASE_SIGNING_PUBLIC_KEY_ENV]: '  ' }, { [RELEASE_SIGNING_PUBLIC_KEY_ENV]: ours }].map(releasePublicKey))
    .toEqual([RELEASE_SIGNING_PUBLIC_KEY, RELEASE_SIGNING_PUBLIC_KEY, RELEASE_SIGNING_PUBLIC_KEY, ours]);
});

test('an artifact is admitted by the signed checksum alone: a path it names, and the bytes it names', async () => {
  const bytes = new TextEncoder().encode('the archive');
  const signed = { '/downloads/a.tar.gz': [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('') };

  expect(await Promise.all([
    artifactRefusal(signed, '/downloads/a.tar.gz', bytes),
    artifactRefusal(signed, '/downloads/a.tar.gz', new TextEncoder().encode('other bytes')),
    artifactRefusal(signed, '/downloads/b.tar.gz', bytes),
  ])).toEqual([null, 'checksum mismatch for /downloads/a.tar.gz', 'the signed release names no /downloads/b.tar.gz']);
});
