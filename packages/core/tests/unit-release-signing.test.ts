/** Release signature (SECURITY-devices C1): canonical text over (version, checksums); core's and the daemon's pins are one key. */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { RELEASE_SIGNING_PUBLIC_KEY, generateReleaseSigningKey, signRelease, verifyRelease } from '../src/http/release-signing';

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

test('the daemon pins the same public key core does, and it is a real key', () => {
  // The daemon cannot import core; its pin is read off the module `kinu connect` installs.
  const daemon = v.parse(v.object({ RELEASE_SIGNING_PUBLIC_KEY: v.string() }), require('../../pc-agent/src/update.js'));

  expect(daemon.RELEASE_SIGNING_PUBLIC_KEY).toBe(RELEASE_SIGNING_PUBLIC_KEY);
  expect(RELEASE_SIGNING_PUBLIC_KEY).toMatch(/^[0-9a-f]{64}$/);
});
