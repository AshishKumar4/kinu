// What the workspace mount owes a process running in it, asked of the real
// image.
//
// THE CONTRACT. The chain attaches `/workspace` as a fuse-overlayfs with a
// fresh writable upper, and everything an agent runs writes into that upper. A
// mapping is not a nicety there: SQLite's WAL mode keeps its shared-memory
// index in a `-shm` file that it mmaps MAP_SHARED and writable, so an upper
// that refuses such a mapping turns every WAL database in the workspace into
// SQLITE_IOERR_SHMMAP — and a WAL database is what almost every agent tool
// (bun:sqlite, better-sqlite3, Prisma, litestream) opens by default.
//
// WHY IT IS A TEST AND NOT A COMMENT. The capability belongs to the mount, not
// to any code in this package, so no unit test can observe it: the only honest
// question is whether the shipped image's fuse-overlayfs honours it. This suite
// asks exactly that, in the image the product runs, through the same mount
// command `src/snapshot-chain.ts` issues.
//
// AND IT IS PROVEN ABLE TO GO RED. A green assertion over a property nothing
// can break is not evidence. `tests/support/workspace-mount-contract/` holds a
// minimal FUSE filesystem that refuses ONE capability — its files are
// direct-io, so the kernel answers every mmap with ENODEV — and the same two
// probes run against it. The mapping half asserts the one name; the WAL half
// asserts a closed set of two mapping-caused IOERRs, documented at the test.
//
// DOCKER-GATED. No docker, no evidence: the suite skips rather than passing
// vacuously. `--privileged --device /dev/fuse` is what a FUSE mount inside a
// container needs, which is the same reason the deployed container has it.
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const FIXTURE_DIR = join(import.meta.dir, 'support', 'workspace-mount-contract');
/** One tag, rebuilt per run: docker layer-caches the apt and gcc steps, so a
 *  re-run costs the COPY and the two compiles. */
const IMAGE = 'kinu-workspace-mount-contract:test';

function dockerUsable(): boolean {
  const version = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8', timeout: 30_000,
  });
  return version.status === 0;
}

const usable = dockerUsable();

/** What one run of the fixture answered. `undefined` is a probe that never
 *  printed a verdict, which is a failure rather than a pass — an assertion
 *  against a name that is absent says so instead of matching loosely. */
interface MountVerdicts {
  readonly mmap: string | undefined;
  readonly wal: string | undefined;
}

function probe(kind: 'overlay' | 'direct-io'): MountVerdicts {
  const ran = spawnSync('docker', [
    'run', '--rm', '--privileged', '--device', '/dev/fuse',
    '--entrypoint', '/probe/run.sh', IMAGE, kind,
  ], { encoding: 'utf8', timeout: 180_000 });
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
      encoding: 'utf8', timeout: 900_000,
    });
    expect(built.stderr + built.stdout).not.toContain('error:');
    expect(built.status).toBe(0);
  }, 900_000);

  test('on the shipped fuse-overlayfs upper, a writable MAP_SHARED mmap and a WAL database both work', () => {
    const verdicts = probe('overlay');
    // ONE ASSERTION OVER BOTH, so a failure names which half broke: the mapping
    // itself, or the WAL that needs it. `wal OK` means a writer and a reader
    // connection agreed through the shared-memory index AND the rows were still
    // there after both connections closed and the database was reopened.
    expect(verdicts).toEqual({ mmap: 'OK', wal: 'OK' });
  }, 300_000);

  test('on a direct-io FUSE mount the same case fails its WAL with a mapping-caused IOERR', () => {
    const verdicts = probe('direct-io');
    // THE NAMES ARE THE POINT, and there are two of them. ENODEV is what the
    // kernel answers for an mmap of a direct-io FUSE file — not EACCES (a
    // read-only mount) and not ENOSYS (no such call) — and it never varies:
    // the mapping is what this mount refuses, on every run.
    expect(verdicts.mmap).toBe('ENODEV');
    // THE WAL HALF IS A CLOSED SET OF TWO, and the set is the evidence. The
    // common case is SQLITE_IOERR_SHMMAP: SQLite mapping the WAL shm index
    // onto the unmappable file. The rare case — observed live under host
    // contention and reproduced locally the same way — is SQLITE_IOERR_DELETE:
    // SQLite's journal-mode-transition cleanup unlinking app.db-journal while
    // the kernel answers that unlink with ENOSYS. Captured once with the
    // failing call: `unlink /mnt/app.db-journal -> -1 errno=38` at the PRAGMA
    // step. The fixture's own unlink op is wired — succeeding unlinks are
    // observed in the same runs — and returns only success or ENOENT, so the
    // ENOSYS came from below the fixture's code, not from a second capability
    // it refuses. Either name is the missing mapping failing the WAL; what
    // must never appear is OK (the mapping worked) or a permission class
    // (EACCES, EPERM, EROFS — a different defect about writability, which this
    // mount has). A future SQLite that fails this probe under a third name
    // fails here loudly, and adding it means settling the same question again.
    expect(
      verdicts.wal === 'SQLITE_IOERR_SHMMAP' || verdicts.wal === 'SQLITE_IOERR_DELETE',
    ).toBe(true);
  }, 300_000);
});
