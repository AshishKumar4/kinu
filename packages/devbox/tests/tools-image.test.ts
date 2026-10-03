// D65: the tools tarball the Dockerfile's `tools` stage builds installs offline on Debian trixie, every
// tool runs and FUSE mounts through it, and a second install of the same tarball changes nothing.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS_STAMP, toolsInstallCommand } from '../src/tools';
import { buildToolsArchive } from './support/block-image';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const TRIXIE = 'docker.io/library/debian@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c';

const name = `devbox-tools-${process.pid}`;

let scratch = '';

let hash = '';

const sh = (script: string) => {
  const ran = spawnSync('docker', ['exec', name, 'bash', '-c', script], { encoding: 'utf8' });

  return { status: ran.status, stdout: ran.stdout.trim(), stderr: ran.stderr.trim() };
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}tools-`));
  buildToolsArchive(scratch);
  hash = createHash('sha256').update(readFileSync(join(scratch, 'tools.tgz'))).digest('hex');

  const started = spawnSync('docker', ['run', '--detach', '--name', name, '--network=none', '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN',
    '--security-opt', 'apparmor=unconfined', TRIXIE, 'sleep', 'infinity'], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);
});

afterAll(() => {
  spawnSync('docker', ['rm', '-f', name]);
  rmSync(scratch, { recursive: true, force: true });
});

const install = () => {
  spawnSync('docker', ['cp', join(scratch, 'tools.tgz'), `${name}:/tmp/tools.tgz`]);

  return sh(toolsInstallCommand('/tmp/tools.tgz', hash));
};

test('the tarball installs with no network, every tool runs, FUSE mounts through it, and a reinstall changes nothing', () => {
  const first = install();

  // node is the managed base's own, not the tarball's.
  const tools = sh('for t in bun git tmux tini s3fs fuse-overlayfs mksquashfs unsquashfs zstd curl python3 devbox-squashfuse devbox-block-lower sandbox-shim; do '
    + 'command -v $t >/dev/null || echo "missing $t"; done');

  const fuse = sh('set -e; d=/var/tmp/ft; rm -rf $d && mkdir -p $d/src $d/m $d/u $d/w $d/o && echo fuse-ok > $d/src/f && '
    + 'mksquashfs $d/src $d/l.sqsh -noappend -quiet >/dev/null && devbox-squashfuse $d/l.sqsh $d/m && '
    + 'fuse-overlayfs -o lowerdir=$d/m,upperdir=$d/u,workdir=$d/w $d/o && cat $d/o/f && fusermount3 -u $d/o && fusermount3 -u $d/m');

  const again = install();

  expect({
    first: first.status, tools: tools.stdout, fuse: fuse.stdout, stamp: sh(`cat ${TOOLS_STAMP}`).stdout,
    again: again.status, changedAgain: /changed=(\d+)/.exec(again.stdout)?.[1],
  }).toEqual({ first: 0, tools: '', fuse: 'fuse-ok', stamp: hash, again: 0, changedAgain: '0' });
});
