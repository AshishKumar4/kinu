/**
 * The desktop's web client (D70): KasmVNC's own, vendored from the release `.deb` the devbox image installs,
 * because its server speaks a PointerEvent standard noVNC does not. Only the files the client loads are kept,
 * as listed in its `upstream.json`; the cf-backend drift test holds them to it.
 *
 *   bun scripts/kasmvnc-client.ts <path to the pinned .deb>   rewrites public/kasmvnc and the pin's digests from it
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

const CF = join(import.meta.dir, '..', 'packages/cf-backend');

export const KASMVNC_CLIENT = join(CF, 'public/kasmvnc');

export const KASMVNC_PIN = join(KASMVNC_CLIENT, 'upstream.json');

export const KasmvncPin = v.object({
  $comment: v.string(),
  deb: v.object({ url: v.string(), sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)) }),
  root: v.string(),
  files: v.record(v.string(), v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
});

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The pinned `.deb` extracted to `dir`, which the caller removes, and its client root in it. */
function extractClient(deb: string) {
  const pin = v.parse(KasmvncPin, JSON.parse(readFileSync(KASMVNC_PIN, 'utf8')));

  if (sha256(readFileSync(deb)) !== pin.deb.sha256) throw new Error(`${deb} is not the pinned KasmVNC release (${pin.deb.url})`);
  const out = mkdtempSync(join(tmpdir(), 'kinu-kasmvnc-'));
  const extracted = spawnSync('dpkg-deb', ['-x', deb, out], { encoding: 'utf8' });

  if (extracted.status !== 0) throw new Error(`dpkg-deb -x failed: ${extracted.stderr}`);

  return { dir: out, root: join(out, pin.root) };
}

if (import.meta.main) {
  const deb = process.argv[2];

  if (deb === undefined) throw new Error('usage: bun scripts/kasmvnc-client.ts <path to the pinned .deb>');
  const pin = v.parse(KasmvncPin, JSON.parse(readFileSync(KASMVNC_PIN, 'utf8')));
  const { dir, root } = extractClient(deb);

  try {
    rmSync(KASMVNC_CLIENT, { recursive: true, force: true });
    mkdirSync(KASMVNC_CLIENT);
    const files: Record<string, string> = {};

    for (const path of Object.keys(pin.files).sort()) {
      mkdirSync(dirname(join(KASMVNC_CLIENT, path)), { recursive: true });
      copyFileSync(join(root, path), join(KASMVNC_CLIENT, path));
      files[path] = sha256(readFileSync(join(root, path)));
    }

    writeFileSync(KASMVNC_PIN, `${JSON.stringify({ ...pin, files }, null, 2)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
