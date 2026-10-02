// D61, 2026-10-02: a quiesce releases what holds the work directory before its commit reseats the
// overlay, or the reseat and the detach fail busy. Here, in the image with a real fuse-overlayfs at
// /workspace, each kind of holder a user's process can be: a cwd (a dev server, a terminal shell), an
// executable run from the workspace, and a file mapped from it.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { releaseWorkdirHoldersCommand } from '../src/lifecycle';
import { DEVBOX_RUNTIME_DIR, DEVBOX_WORKDIR } from '../src/storage';
import { buildBlockImage, removeBlockImage } from './support/block-image';
import { inContainer } from './support/docker-container';

const image = `devbox-holders-${process.pid}`;

const name = `devbox-holders-${process.pid}`;

function run(script: string): string {
  const ran = inContainer(name, ['bash', '-c', script]);

  if (ran.status !== 0) throw new Error(`${script} exited ${String(ran.status)}: ${ran.stderr}`);

  return ran.stdout;
}

beforeAll(() => {
  buildBlockImage(image);

  const started = spawnSync('docker', [
    'run', '--detach', '--name', name, '--network=none',
    '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined', image,
  ], { encoding: 'utf8' });

  if (started.status !== 0) throw new Error(started.stderr);

  // The fresh attach's overlay: an empty lower, the upper and work directory on the disk.
  run(`mkdir -p ${DEVBOX_RUNTIME_DIR}/lower-empty ${DEVBOX_RUNTIME_DIR}/upper ${DEVBOX_RUNTIME_DIR}/work ${DEVBOX_WORKDIR} && `
    + `/usr/bin/fuse-overlayfs -o lowerdir=${DEVBOX_RUNTIME_DIR}/lower-empty,upperdir=${DEVBOX_RUNTIME_DIR}/upper,`
    + `workdir=${DEVBOX_RUNTIME_DIR}/work ${DEVBOX_WORKDIR} 2>/dev/null; grep -q ' ${DEVBOX_WORKDIR} fuse' /proc/mounts`);
});

afterAll(() => {
  spawnSync('docker', ['rm', '-f', name]);
  removeBlockImage(image);
});

/** Starts `command` detached with cwd `cwd`, and returns its pid once `ready` holds. */
function holder(cwd: string, command: string, ready: string): string {
  return run(`cd ${cwd} && { setsid ${command} </dev/null >/dev/null 2>&1 & p=$!; }; `
    + `for _ in $(seq 1 100); do ${ready} && break; sleep 0.1; done; ${ready} && echo $p`).trim();
}

test('the release leaves nothing holding the work directory, whatever a process holds it by', () => {
  run(`cp /bin/sleep ${DEVBOX_WORKDIR}/devserver; cp "$(ldconfig -p | awk '/libz.so.1 / {print $NF; exit}')" ${DEVBOX_WORKDIR}/libaddon.so`);

  const holders = {
    devServer: holder(DEVBOX_WORKDIR, 'python3 -m http.server 8000', '(exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null'),
    // As `terminal.ts` opens it: the pane's shell, under a tmux server started outside the workspace.
    terminalShell: run(`cd / && tmux new-session -d -s devbox -c ${DEVBOX_WORKDIR} /bin/bash && tmux display -p -t devbox '#{pane_pid}'`).trim(),
    executable: holder('/', `${DEVBOX_WORKDIR}/devserver 601`, '[ -e /proc/$p/exe ]'),
    // A native addon: the loader maps the library and closes its descriptor.
    mapped: holder('/', `env LD_PRELOAD=${DEVBOX_WORKDIR}/libaddon.so sleep 602`, `grep -q libaddon /proc/$p/maps 2>/dev/null`),
  };

  const released = inContainer(name, ['bash', '-c', `cd ${DEVBOX_RUNTIME_DIR} && ${releaseWorkdirHoldersCommand(DEVBOX_WORKDIR)}`]);
  const alive = Object.fromEntries(Object.entries(holders).map(([kind, pid]) => [kind, inContainer(name, ['kill', '-0', pid]).status === 0]));
  const unmounted = inContainer(name, ['/usr/bin/fusermount3', '-u', DEVBOX_WORKDIR]);

  expect({ released: released.stdout.trim().split('\n').at(-1), alive, unmount: unmounted.status === 0 ? 'ok' : unmounted.stderr.trim() }).toEqual({
    released: 'none',
    alive: { devServer: false, terminalShell: false, executable: false, mapped: false },
    unmount: 'ok',
  });
});
