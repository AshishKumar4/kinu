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
// probes run against it. The negative arm asserts the two failures by name, so
// the positive arm's greens are known to be answers rather than defaults.
//
// DOCKER-GATED. No docker, no evidence: the suite skips rather than passing
// vacuously. `--privileged --device /dev/fuse` is what a FUSE mount inside a
// container needs, which is the same reason the deployed container has it.
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const FIXTURE_DIR = join(import.meta.dir, 'support', 'workspace-mount-contract');
/** PER PROCESS, because the tag is machine-global while the fixture is not.
 *  `FIXTURE_DIR` is `import.meta.dir`-relative, so every worktree carries its
 *  own copy of the probe sources, and every agent here works in a worktree by
 *  mandate. One shared tag therefore means a lane's build of ITS fixture is
 *  what this tree's container starts from. Docker caches layers by content
 *  rather than by tag, so identical sources still reuse the apt and gcc steps
 *  and a re-run costs the COPY and the two compiles. */
const IMAGE = `kinu-workspace-mount-contract:${String(process.pid)}`;

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

  test('on a direct-io FUSE mount the same case reports ENODEV and SQLITE_IOERR_SHMMAP', () => {
    const verdicts = probe('direct-io');
    // THE NAMES ARE THE POINT. ENODEV is what the kernel answers for an mmap of
    // a direct-io FUSE file — not EACCES (a read-only mount) and not ENOSYS (no
    // such call) — and SQLITE_IOERR_SHMMAP is SQLite's own name for failing to
    // map the WAL index. Those two together are the shape a workspace upper
    // without this capability would take, and the positive case above is what
    // says the shipped one has it.
    expect(verdicts).toEqual({ mmap: 'ENODEV', wal: 'SQLITE_IOERR_SHMMAP' });
  }, 300_000);

  // The tag this process minted, released with it. The image LAYERS stay in the
  // cache — that is what keeps a re-run cheap — and only the name goes, so a
  // machine running this suite for weeks does not accumulate one tag per run.
  afterAll(() => {
    const removed = spawnSync('docker', ['rmi', '-f', IMAGE], { encoding: 'utf8', timeout: 60_000 });
    if (removed.status !== 0) {
      throw new Error(`the fixture tag ${IMAGE} could not be released: ${removed.stderr.trim() || 'docker printed nothing'}`);
    }
  });
});
