// D65: the tools tarball the Dockerfile's `tools` stage builds installs offline on Debian trixie, every
// tool runs and FUSE mounts through it, and a second install of the same tarball changes nothing.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS_STAMP, toolsInstallCommand } from '../src/tools';
import { DESKTOP_PORT, DESKTOP_START } from '../src/desktop';
import { BROWSER_WINDOW, buildToolsImage, removeBlockImage } from './support/block-image';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const name = `devbox-tools-${process.pid}`;

let scratch = '';

let hash = '';

const sh = (script: string) => {
  const ran = spawnSync('docker', ['exec', name, 'bash', '-c', script], { encoding: 'utf8' });

  return { status: ran.status, stdout: ran.stdout.trim(), stderr: ran.stderr.trim() };
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}tools-`));
  hash = buildToolsImage(name, scratch);

  const started = spawnSync('docker', ['run', '--detach', '--name', name, '--network=none', '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN',
    '--security-opt', 'apparmor=unconfined', name, 'sleep', 'infinity'], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);
});

afterAll(() => {
  spawnSync('docker', ['rm', '-f', name]);
  removeBlockImage(name);
  rmSync(scratch, { recursive: true, force: true });
});

const install = () => {
  spawnSync('docker', ['cp', join(scratch, 'tools.tgz'), `${name}:/tmp/tools.tgz`]);

  return sh(toolsInstallCommand('/tmp/tools.tgz', hash));
};

test('the tarball installs with no network, every tool runs, FUSE mounts through it, and a reinstall changes nothing', () => {
  // node is the managed base's own, not the tarball's.
  const tools = sh('for t in bun git tmux tini s3fs fuse-overlayfs mksquashfs unsquashfs zstd curl python3 devbox-squashfuse devbox-block-lower sandbox-shim '
    + 'Xkasmvnc openbox chromium xdotool scrot; do '
    + 'command -v $t >/dev/null || echo "missing $t"; done');

  const fuse = sh('set -e; d=/var/tmp/ft; rm -rf $d && mkdir -p $d/src $d/m $d/u $d/w $d/o && echo fuse-ok > $d/src/f && '
    + 'mksquashfs $d/src $d/l.sqsh -noappend -quiet >/dev/null && devbox-squashfuse $d/l.sqsh $d/m && '
    + 'fuse-overlayfs -o lowerdir=$d/m,upperdir=$d/u,workdir=$d/w $d/o && cat $d/o/f && fusermount3 -u $d/o && fusermount3 -u $d/m');

  const again = install();

  expect({
    tools: tools.stdout, fuse: fuse.stdout, stamp: sh(`cat ${TOOLS_STAMP}`).stdout,
    again: again.status, changedAgain: /changed=(\d+)/.exec(again.stdout)?.[1],
  }).toEqual({ tools: '', fuse: 'fuse-ok', stamp: hash, again: 0, changedAgain: '0' });
});

test('the desktop starts once however often it is opened, speaks RFB on its port, and the menu\'s browser opens as root', () => {
  const open = () => spawnSync('docker', ['exec', name, '/bin/bash', '-c', DESKTOP_START, 'devbox-desktop'], { encoding: 'utf8' }).status;
  const opens = [open(), open()];

  const handshake = sh(`exec 3<>/dev/tcp/127.0.0.1/${String(DESKTOP_PORT)}; printf 'GET /websockify HTTP/1.1\\r\\nHost: box\\r\\n`
    + `Upgrade: websocket\\r\\nConnection: Upgrade\\r\\nOrigin: http://box\\r\\nSec-WebSocket-Version: 13\\r\\n`
    + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: binary\\r\\n\\r\\n' >&3; `
    + `grep -a -o -m 2 -e '101 Switching Protocols' -e 'RFB 003.008' <&3`);

  const browser = sh(`${BROWSER_WINDOW('about:blank')}; pgrep -af chromium | grep -c disable-component-update`);

  expect({
    opens, servers: sh('pgrep -cx Xkasmvnc').stdout, wm: sh('pgrep -cx openbox').stdout,
    handshake: handshake.stdout.split('\n'), browser: Number(browser.stdout) > 0,
  }).toEqual({ opens: [0, 0], servers: '1', wm: '1', handshake: ['101 Switching Protocols', 'RFB 003.008'], browser: true });
});
