// Contract: the `/workspace` fuse-overlayfs upper must allow writable MAP_SHARED mmap,
// or SQLite WAL `-shm` fails; checked in the real image, docker-gated, vs a refusing fixture.
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const FIXTURE_DIR = join(import.meta.dir, 'support', 'workspace-mount-contract');

/** Per-process tag: the tag is machine-global but each worktree has its own fixture sources,
 *  so a shared tag could start this tree's container from another tree's build. */
const IMAGE = `kinu-workspace-mount-contract:${String(process.pid)}`;

function dockerUsable(): boolean {
  const version = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });

  return version.status === 0;
}

const usable = dockerUsable();

/** `undefined` is a probe that printed no verdict: a failure, not a pass, so assertions
 *  compare exact values rather than matching loosely. */
interface MountVerdicts {
  readonly mmap: string | undefined;
  readonly wal: string | undefined;
}

function probe(kind: 'overlay' | 'direct-io'): MountVerdicts {
  const ran = spawnSync('docker', [
    'run', '--rm', '--network=none', '--privileged', '--device', '/dev/fuse',
    '--entrypoint', '/probe/run.sh', IMAGE, kind,
  ], { encoding: 'utf8' });

  if (ran.status !== 0) {
    throw new Error(`the ${kind} probe exited ${String(ran.status)}: ${ran.stderr || ran.stdout}`);
  }

  const printed = new Map(ran.stdout.split('\n')
    .map((line) => line.trim().split(' '))
    .filter((parts): parts is [string, string] => parts.length === 2));

  return { mmap: printed.get('mmap'), wal: printed.get('wal') };
}

describe.skipIf(!usable)('the workspace mount honours writable MAP_SHARED mappings', () => {
  test('the fixture image builds both probes inside the shipped image', () => {
    const built = spawnSync('docker', ['build', '-t', IMAGE, FIXTURE_DIR], {
      encoding: 'utf8',
    });

    expect(built.stderr + built.stdout).not.toContain('error:');
    expect(built.status).toBe(0);
  });

  test('on the shipped fuse-overlayfs upper, a writable MAP_SHARED mmap and a WAL database both work', () => {
    const verdicts = probe('overlay');
    // One assertion over both, so a failure names which half broke: the mapping or the WAL.
    // `wal OK` means writer and reader agreed via the shm index and rows survived a reopen.
    expect(verdicts).toEqual({ mmap: 'OK', wal: 'OK' });
  });

  test('on a direct-io FUSE mount the same case fails its WAL with a mapping-caused IOERR', () => {
    const verdicts = probe('direct-io');
    // The kernel answers an mmap of a direct-io FUSE file with ENODEV, never EACCES (read-only)
    // or ENOSYS; the mapping is what this mount refuses.
    expect(verdicts.mmap).toBe('ENODEV');
    // Both names are the unmappable file failing the WAL (IOERR_DELETE is a rare ENOSYS unlink);
    // OK or a permission class (EACCES, EPERM, EROFS) would be a different defect.
    expect(
      verdicts.wal === 'SQLITE_IOERR_SHMMAP' || verdicts.wal === 'SQLITE_IOERR_DELETE',
    ).toBe(true);
  });

  // Removes only this run's tag; image layers stay cached so re-runs stay cheap
  // and repeated runs do not accumulate one tag each.
  afterAll(() => {
    const removed = spawnSync('docker', ['rmi', '-f', IMAGE], { encoding: 'utf8' });

    if (removed.status !== 0) {
      throw new Error(`the fixture tag ${IMAGE} could not be released: ${removed.stderr.trim() || 'docker printed nothing'}`);
    }
  });
});
