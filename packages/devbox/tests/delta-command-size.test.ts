/** A checkpoint's stage commands each reach the shell as one argument, which Linux caps at 128 KiB. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDeltaStageOps, deltaOpCommands, DELTA_MANIFEST_NAME } from '../src/chunked-delta';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const MAX_ARG_STRLEN = 128 * 1024;

test('a large delta index stages in commands that each fit one argument, and lands byte-exact', () => {
  const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}stage-size-`));
  // 2 MiB: the index a ~64 MiB new file's overrides produce; 12 MiB of file already broke the one-argument stage.
  const index = new Uint8Array(2 * 1024 * 1024).map((_, at) => (at * 31 + 7) % 251);
  const manifest = { v: 2 as const, files: [], dirs: [], deleted: [], treplace: [], links: [] };
  const plan = { manifest, chunks: new Map(), indexes: new Map([['digest', index]]) };

  try {
    const commands = deltaOpCommands(buildDeltaStageOps(plan, { upperDir: join(root, 'upper'), pkgDir: join(root, 'pkg') }));

    for (const command of commands) {
      expect(Buffer.byteLength(command)).toBeLessThan(MAX_ARG_STRLEN);
      expect(spawnSync('bash', ['-c', command], { encoding: 'utf8' }).status).toBe(0);
    }

    expect(new Uint8Array(readFileSync(join(root, 'pkg/.devbox-delta/digest')))).toEqual(index);
    expect(JSON.parse(readFileSync(join(root, 'pkg', DELTA_MANIFEST_NAME), 'utf8'))).toEqual(manifest);
  } finally {
    rmSync(root, { recursive: true });
  }
});
