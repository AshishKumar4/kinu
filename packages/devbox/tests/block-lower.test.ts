// Docker, 2026-09-13: indexed composition and opaque directory replacement;
// the same probe image is built from the source pinned in block-lower/upstream.json.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { buildDeltaIndex, DELTA_BLOCK_BYTES, type DeltaOverride } from '../src/delta-index';
import { buildDeltaAttachOps, buildDeltaStageOps, deltaBaseStatCommand, deltaBlockHashCommand, deltaProbeCommand, parseDeltaBaseStat, parseDeltaBlockHashes, parseDeltaProbe, planDeltaPublication, type DeltaManifest } from '../src/chunked-delta';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { buildBlockImage, removeBlockImage } from './support/block-image';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}block-conformance-`));

const image = `kinu-block-lower:${process.pid}`;

let built = false;

/** One phase of a probe script in the image: privileged with `/dev/fuse`, the
 *  fixture writable and the script read-only. The shell differs per probe —
 *  the reseat probe needs bash. */
function probeRunner(fixture: string, script: string, shell: string): (phase: string) => SpawnSyncReturns<string> {
  return (phase) => spawnSync('docker', ['run', '--rm', '--network=none', '--privileged', '--device', '/dev/fuse',
    '-v', `${fixture}:/fixture`, '-v', `${script}:/probe.sh:ro`, '--entrypoint', shell, image, '/probe.sh', phase], { encoding: 'utf8' });
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });

  if (built) removeBlockImage(image);
});

test('real squashfuse and overlay compose indexed bytes with zero payload read at attach', () => {
  buildBlockImage(image);
  built = true;
  const base = Buffer.alloc(4 * DELTA_BLOCK_BYTES, 65);
  const expected = Buffer.alloc(6 * DELTA_BLOCK_BYTES + 17);
  base.copy(expected);
  expected.fill(66, DELTA_BLOCK_BYTES, 2 * DELTA_BLOCK_BYTES);
  expected.fill(0, 2 * DELTA_BLOCK_BYTES, 3 * DELTA_BLOCK_BYTES);
  expected.fill(67, 6 * DELTA_BLOCK_BYTES);
  mkdirSync(`${root}/base/dir`, { recursive: true });
  mkdirSync(`${root}/base/gone/sub`, { recursive: true });
  mkdirSync(`${root}/base/replace`, { recursive: true });
  mkdirSync(`${root}/pkg/.devbox-delta/chunks`, { recursive: true });
  mkdirSync(`${root}/pkg/.devbox-delta/tree`, { recursive: true });
  mkdirSync(`${root}/pkg/.devbox-delta/tree/dir`, { recursive: true });
  writeFileSync(`${root}/base/dir/file`, base);
  writeFileSync(`${root}/base/dir/stale`, 'hidden by directory opacity');
  writeFileSync(`${root}/pkg/.devbox-delta/tree/dir/whole`, 'both');
  writeFileSync(`${root}/pkg/.devbox-delta/tree/dir/.wh..wh..opq`, '');
  writeFileSync(`${root}/base/gone/sub/file`, 'deleted');
  writeFileSync(`${root}/base/replace/child`, 'old directory child');
  writeFileSync(`${root}/pkg/.devbox-delta/tree/replace`, 'replacement');
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
      { kind: 'whole', p: 'whole', s: 13 }, { kind: 'whole', p: 'hardlink', s: 13 }, { kind: 'whole', p: 'link', s: 5 },
      { kind: 'whole', p: 'dir/whole', s: 4 },
      { kind: 'whole', p: 'replace', s: 11 }],
    dirs: [{ p: 'dir', mode: 493, uid: 0, gid: 0, opaque: true }], deleted: ['gone/sub/file'], treplace: ['replace'], links: [['whole', 'hardlink']] };

  writeFileSync(`${root}/pkg/.devbox-delta/manifest.json`, JSON.stringify(manifest));
  writeFileSync(`${root}/namespace.sh`, ['set -e', ...buildDeltaAttachOps(manifest, '/var/tmp/devbox/upper')].join('\n'));

  const result = spawnSync('docker', ['run', '--rm', '--network=none', '--privileged', '--device', '/dev/fuse',
    '-v', `${root}:/fixture:ro`, '-v', `${join(import.meta.dir, 'support/block-lower-probe.sh')}:/probe.sh:ro`,
    '--entrypoint', '/bin/sh', image, '/probe.sh'], { encoding: 'utf8' });

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('attach-payload-bytes=0');
  expect(result.stdout).toContain('matrix-composed-witness=marker-readable,upper-absent,sidecar-mounted,block-mounted');
  expect(result.stdout).toContain('composed-read=exact copyup=file-local');
});

test('a renamed replacement directory checkpoints and restores without the old lower children', () => {
  const fixture = `${root}/opaque`;
  mkdirSync(`${fixture}/base/source`, { recursive: true });
  mkdirSync(`${fixture}/base/target`, { recursive: true });
  mkdirSync(`${fixture}/upper`, { recursive: true });
  writeFileSync(`${fixture}/base/source/new.txt`, 'renamed bytes');
  writeFileSync(`${fixture}/base/target/stale.txt`, 'must stay hidden');
  writeFileSync(`${fixture}/base/keep`, 'unchanged sibling');
  writeFileSync(`${fixture}/probe.sh`, deltaProbeCommand('/fixture/upper', []));
  const script = join(import.meta.dir, 'support/opaque-namespace-probe.sh');

  const run = probeRunner(fixture, script, '/bin/sh');

  const prepared = run('prepare');
  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  const probe = parseDeltaProbe(prepared.stdout);

  const plan = planDeltaPublication({ probe, baseFacts: new Map(), hashFiles: [], hashes: new Map(),
    whiteouts: new Set(probe.filter(entry => entry.type === 'c').map(entry => entry.path)) });

  expect(plan.manifest.dirs).toContainEqual(expect.objectContaining({ p: 'target', opaque: true }));
  writeFileSync(`${fixture}/stage.sh`, ['set -e', ...buildDeltaStageOps(plan, { upperDir: '/fixture/upper', pkgDir: '/fixture/pkg' })].join('\n'));
  writeFileSync(`${fixture}/namespace.sh`, ['set -e', ...buildDeltaAttachOps(plan.manifest, '/var/tmp/devbox/upper')].join('\n'));
  const restored = run('restore');
  expect(restored.status, restored.stdout + restored.stderr).toBe(0);
  expect(restored.stdout).toContain('namespace=keep,target/new.txt attach-payload-bytes=0 index-pages=0');
  const missing = run('missing-marker');
  expect(missing.status).not.toBe(0);
  expect(missing.stdout + missing.stderr).toContain('missing delta source');
});

test('moving the checkpoint session out of the workspace reseats the base and publishes only the overwrite', () => {
  const fixture = `${root}/reseat`;
  mkdirSync(`${fixture}/upper`, { recursive: true });
  const path = 'vol/dense.bin';
  writeFileSync(`${fixture}/probe.sh`, deltaProbeCommand('/fixture/upper', []));
  writeFileSync(`${fixture}/stat.sh`, deltaBaseStatCommand([path], '/fixture/lower-base'));
  writeFileSync(`${fixture}/hash.sh`, deltaBlockHashCommand({ workDir: '/fixture/hash', files: [{ index: 0,
    upperPath: `/fixture/upper/${path}`, basePath: `/fixture/lower-base/${path}` }] }));
  const script = join(import.meta.dir, 'support/reseat-cwd-probe.sh');

  const run = probeRunner(fixture, script, '/bin/bash');

  const prepared = run('prepare');
  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  expect(prepared.stdout).toContain('cwd-control=EBUSY');
  const probe = parseDeltaProbe(readFileSync(`${fixture}/probe.out`, 'utf8'));
  const baseFacts = parseDeltaBaseStat(readFileSync(`${fixture}/stat.out`, 'utf8'), [path]);
  const hashes = parseDeltaBlockHashes(readFileSync(`${fixture}/hash.out`, 'utf8'), new Map([[0, { upperBlocks: 4096, baseBlocks: 4096 }]]));
  const plan = planDeltaPublication({ probe, baseFacts, hashes, hashFiles: [path], whiteouts: new Set() });
  expect(plan.chunks.size).toBe(4);
  writeFileSync(`${fixture}/stage.sh`, ['set -e', ...buildDeltaStageOps(plan, { upperDir: '/fixture/upper', pkgDir: '/fixture/pkg' })].join('\n'));
  writeFileSync(`${fixture}/namespace.sh`, ['set -e', ...buildDeltaAttachOps(plan.manifest, '/var/tmp/devbox/upper')].join('\n'));
  const restored = run('restore');
  expect(restored.status, restored.stdout + restored.stderr).toBe(0);
  expect(Number(readFileSync(`${fixture}/delta-bytes`, 'utf8'))).toBeLessThan(196608);
  expect(restored.stdout).toContain('reseat=outside-workspace delta=small restored=exact payload=0 index-pages=0');
});
