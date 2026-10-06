// eval-site-preview-1-2ypddc, staging f75f06932, 2026-10-01: a server run as a plain command outran its call's
// window and its job read as running forever. Kinu stamps a job's command with the job's id; this read names the
// stamp on whatever holds a port's listening socket. The runtime's exec is a real local process here, so the
// sockets, the process tree and /proc are real.
import { TestDevbox } from './support/test-devbox';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PortListener } from '../src/devbox';
import { harness } from './support/devbox-harness';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { pipeExec as localExec } from './support/native-process';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}port-listeners-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const STAMP = 'KINU_JOB_ID';

class TestBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}


/** The read of a box that is running, which answers rows, never null. */
function read(listeners: readonly PortListener[] | null): readonly PortListener[] {
  if (listeners === null) throw new Error('the box is running, yet its listener read answered as if it were down');

  return listeners;
}

/** A server on a free port that writes its port to `fifo` once it listens. */
function server(fifo: string): string {
  return `python3 -c 'import socket, sys, time; s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(); `
    + `open(sys.argv[1], "w").write(str(s.getsockname()[1])); time.sleep(600)' ${fifo}`;
}

describe("a port's listener", () => {
  test('reads as the stamp on the command that started it, or on its nearest ancestor', async () => {
    const { box } = harness(TestBox, undefined, localExec);
    await box.devboxStartup();
    const cwd = mkdtempSync(join(root, 'serve-'));
    const fifos = ['direct', 'parent', 'none'].map((name) => join(cwd, name));

    for (const fifo of fifos) Bun.spawnSync(['mkfifo', fifo]);
    const [direct = '', parent = '', none = ''] = fifos;

    const served = [
      box.execUntimed(`exec ${server(direct)}`, { cwd, execId: 'direct', env: { [STAMP]: 'bgjob-direct' } }),
      // The server drops the variable; the shell that started it still carries it.
      box.execUntimed(`sh -c 'env -u ${STAMP} ${server(parent).replaceAll("'", "'\\''")}; true'`, { cwd, execId: 'parent', env: { [STAMP]: 'bgjob-parent' } }),
      box.execUntimed(`exec ${server(none)}`, { cwd, execId: 'none' }),
    ];

    const [directPort, parentPort, nonePort] = await Promise.all(fifos.map(async (fifo) => Number((await Bun.file(fifo).text()).trim())));

    try {
      const listeners = read(await box.portListeners(STAMP, [directPort ?? 0, parentPort ?? 0, nonePort ?? 0]));

      expect(listeners.map(({ port, stamp }) => ({ port, stamp })).sort((a, b) => a.port - b.port)).toEqual([
        { port: directPort, stamp: 'bgjob-direct' },
        { port: parentPort, stamp: 'bgjob-parent' },
        { port: nonePort, stamp: null },
      ].sort((a, b) => (a.port ?? 0) - (b.port ?? 0)));
      expect(listeners.every((listener) => listener.command.startsWith('python3 -c'))).toBe(true);

      // Asked for no port in particular, the read names every listener, these among them.
      expect(read(await box.portListeners(STAMP)).map(({ port, stamp }) => ({ port, stamp }))).toEqual(expect.arrayContaining([
        { port: directPort, stamp: 'bgjob-direct' }, { port: parentPort, stamp: 'bgjob-parent' }, { port: nonePort, stamp: null },
      ]));
    } finally {
      for (const execId of ['direct', 'parent', 'none']) await box.killUntimed(execId);
      await Promise.allSettled(served);
    }
  });

  test('a port nothing holds has no listener', async () => {
    const { box } = harness(TestBox, undefined, localExec);
    await box.devboxStartup();
    const unheld = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
    const port = unheld.port;
    unheld.stop(true);

    expect(await box.portListeners(STAMP, [port])).toEqual([]);
    expect(await box.portListeners(STAMP, [])).toEqual([]);
  });

  test('a box that is not running answers null, and the read does not start it', async () => {
    const { box, container } = harness(TestBox, undefined, localExec);
    await box.devboxStartup();
    await container.stop();
    const starts = container.startOptions.length;

    expect(await box.portListeners(STAMP)).toBeNull();
    expect(container.startOptions.length).toBe(starts);
  });
});
