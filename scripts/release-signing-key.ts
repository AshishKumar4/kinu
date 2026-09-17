#!/usr/bin/env bun
/**
 * Generate the release signing key pair, once, on the machine that deploys.
 *
 * The PRIVATE half (PKCS#8, base64) is written to the build lane's key file
 * (`~/.config/kinu/release-signing.key`, mode 0600, or the path in
 * `KINU_RELEASE_SIGNING_KEY_FILE`) and never printed: it is a secret the
 * deployment never holds, read by `scripts/build-cli-dist.sh` at build. The
 * PUBLIC half (hex) is printed, to pin into
 * `packages/core/src/http/release-signing.ts` (`RELEASE_SIGNING_PUBLIC_KEY`)
 * and `packages/pc-agent/src/update.js`; `unit-release-signing.test.ts`
 * holds the two pins equal. Refuses to overwrite a key file that exists.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateReleaseSigningKey } from '../packages/core/src/http/release-signing';

const file = process.env.KINU_RELEASE_SIGNING_KEY_FILE ?? join(homedir(), '.config', 'kinu', 'release-signing.key');

if (existsSync(file)) {
  console.error(`release-signing-key: ${file} exists; a rotation is a deliberate act — move it aside first`);
  process.exit(1);
}

const pair = await generateReleaseSigningKey();

mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

writeFileSync(file, `${pair.privateKeyPkcs8Base64}\n`, { mode: 0o600 });

chmodSync(file, 0o600);

console.log(`private key written to ${file}`);

console.log(`RELEASE_SIGNING_PUBLIC_KEY=${pair.publicKeyHex}`);
