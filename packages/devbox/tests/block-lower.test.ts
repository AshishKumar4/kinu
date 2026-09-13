import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { buildDeltaIndex, DELTA_BLOCK_BYTES, type DeltaOverride } from '../src/delta-index';
import type { DeltaManifest } from '../src/chunked-delta';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}block-conformance-`));

const image = `kinu-block-lower:${process.pid}`;

let built = false;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });

  if (built) {
    const result = spawnSync('docker', ['rmi', image], { encoding: 'utf8' });

    if (result.status !== 0) throw new Error(result.stderr);
  }
});

test('real squashfuse and overlay compose indexed bytes with zero payload read at attach', () => {
  const build = spawnSync('docker', ['build', '-t', image, join(import.meta.dir, '../block-lower')], { encoding: 'utf8', timeout: 300_000 });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  built = true;
  const base = Buffer.alloc(4 * DELTA_BLOCK_BYTES, 65);
  const expected = Buffer.alloc(6 * DELTA_BLOCK_BYTES + 17);
  base.copy(expected);
  expected.fill(66, DELTA_BLOCK_BYTES, 2 * DELTA_BLOCK_BYTES);
  expected.fill(0, 2 * DELTA_BLOCK_BYTES, 3 * DELTA_BLOCK_BYTES);
  expected.fill(67, 6 * DELTA_BLOCK_BYTES);
  mkdirSync(`${root}/base/dir`, { recursive: true });
  mkdirSync(`${root}/pkg/.devbox-delta/chunks`, { recursive: true });
  mkdirSync(`${root}/pkg/.devbox-delta/tree`, { recursive: true });
  writeFileSync(`${root}/base/dir/file`, base);
  writeFileSync(`${root}/expected`, expected);
  writeFileSync(`${root}/whole`, 'whole record\n');
  writeFileSync(`${root}/pkg/.devbox-delta/tree/whole`, 'whole record\n');
  linkSync(`${root}/pkg/.devbox-delta/tree/whole`, `${root}/pkg/.devbox-delta/tree/hardlink`);
  symlinkSync('whole', `${root}/pkg/.devbox-delta/tree/link`);
  const entries: DeltaOverride[] = [];

  for (const block of [1, 2, 6]) {
    if (block === 2) { entries.push({ o: block * DELTA_BLOCK_BYTES, src: 'hole' }); continue; }

    const bytes = expected.subarray(block * DELTA_BLOCK_BYTES, (block + 1) * DELTA_BLOCK_BYTES);
    const d = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(`${root}/pkg/.devbox-delta/chunks/${d}`, bytes);
    entries.push({ o: block * DELTA_BLOCK_BYTES, src: 'chunk', d });
  }

  const index = buildDeltaIndex(entries, expected.length);
  writeFileSync(`${root}/pkg/.devbox-delta/${index.ref.index}`, index.bytes);

  const manifest: DeltaManifest = { v: 2,
    files: [{ kind: 'chunked', p: 'dir/file', s: expected.length, mode: 420, uid: 0, gid: 0, over: index.ref },
      { kind: 'whole', p: 'whole', s: 13 }, { kind: 'whole', p: 'hardlink', s: 13 }, { kind: 'whole', p: 'link', s: 5 }],
    dirs: [{ p: 'dir', mode: 493, uid: 0, gid: 0 }], deleted: [], treplace: [], links: [['whole', 'hardlink']] };

  writeFileSync(`${root}/pkg/.devbox-delta/manifest.json`, JSON.stringify(manifest));

  const result = spawnSync('docker', ['run', '--rm', '--privileged', '--device', '/dev/fuse',
    '-v', `${root}:/fixture:ro`, '-v', `${join(import.meta.dir, 'support/block-lower-probe.sh')}:/probe.sh:ro`,
    '--entrypoint', '/bin/sh', image, '/probe.sh'], { encoding: 'utf8', timeout: 60_000 });

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('attach-payload-bytes=0');
  expect(result.stdout).toContain('composed-read=exact copyup=file-local');
}, 360_000);
