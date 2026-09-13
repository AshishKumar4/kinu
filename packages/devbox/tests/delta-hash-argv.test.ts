/** Live b20260913105359: the 2GiB cell returned 0/131072 hashes. Exercise
 * the same generated shell above ARG_MAX with a smaller file and long paths. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deltaBlockHashCommand, parseDeltaBlockHashes } from '../src/chunked-delta';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

test('block hashes do not expand the changed file into one unbounded argv', () => {
  const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}hash-argv-`));
  const workDir = join(root, 'hash-'.repeat(45));
  mkdirSync(workDir);
  const input = join(root, 'input');
  const blocks = 32000;
  const fd = openSync(input, 'w');
  ftruncateSync(fd, blocks * 16384);
  closeSync(fd);

  try {
    const command = deltaBlockHashCommand({ workDir, files: [{ index: 0, upperPath: input, basePath: null }] });
    const result = spawnSync('bash', ['-c', command.replaceAll(' 2>/dev/null', '')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseDeltaBlockHashes(result.stdout, new Map([[0, { upperBlocks: blocks, baseBlocks: null }]])).get(0)?.upper.size).toBe(blocks);
  } finally {
    rmSync(root, { recursive: true });
  }
});
