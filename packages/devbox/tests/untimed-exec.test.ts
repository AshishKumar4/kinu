// D37: an untimed command runs on `ctx.container.exec`, and ending it ends everything it started. Here the
// runtime's exec is a real local process, so the output, the exit code and the process tree are real.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { devboxFailure } from '../src/errors';
import { Devbox, gate, harness } from './support/devbox-harness';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}untimed-exec-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

/** The runtime's `exec`, as a local process with its output on pipes. */
const localExec: Container['exec'] = async (argv, options) => {
  const child = Bun.spawn(argv, { cwd: options?.cwd, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = child.exited;

  return {
    isPty: false,
    resize: async () => { throw new Error("the local pipe test cannot resize a PTY"); },
    stdin: null,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    exitCode,
    output: async () => {
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);

      return { stdout, stderr, exitCode: await exitCode };
    },
    kill: (signal) => { child.kill(signal); },
  };
};

/** Alive: present and not a zombie, as the kill reads it. */
function alive(pid: number): boolean {
  const status = join('/proc', String(pid), 'status');

  return existsSync(status) && !/^State:\s*Z/mu.test(readFileSync(status, 'utf8'));
}

async function readyBox(exec: Container['exec'] = localExec) {
  const { box } = harness(TestBox, undefined, exec);
  await box.devboxStartup();

  return box;
}

describe('an untimed command on the runtime\'s exec', () => {
  test('returns its own output and exit code', async () => {
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'output-'));

    expect(await box.execUntimed('pwd; echo out; echo err >&2; exit 7', { cwd, execId: 'one' }))
      .toEqual({ stdout: `${cwd}\nout\n`, stderr: 'err\n', exitCode: 7 });
  });

  test('ending it ends what it started, and a command already gone is not ended again', async () => {
    const box = await readyBox();
    const cwd = mkdtempSync(join(root, 'kill-'));
    // A FIFO: the read below returns once the command has started its child and written the child's pid.
    const started = join(cwd, 'started');
    Bun.spawnSync(['mkfifo', started]);
    const ran = box.execUntimed(`sleep 60 & echo $! > ${started}; wait`, { cwd, execId: 'held' });
    const child = Number((await Bun.file(started).text()).trim());

    expect(await box.killUntimed('held')).toBe(true);
    expect((await ran).exitCode).not.toBe(0);
    expect(alive(child)).toBe(false);
    expect(await box.killUntimed('held')).toBe(false);
  });

  test('a kill that arrives while the command is still starting ends it once it has started', async () => {
    // The runtime's exec holds its answer until released, so the kill lands before the process has a pid.
    const starting = gate();

    const box = await readyBox(async (argv, options) => {
      starting.enter();
      await starting.promise;

      return await localExec(argv, options);
    });

    const cwd = mkdtempSync(join(root, 'starting-'));
    // Left alone it answers exit 0 a minute later, past the test's own bound.
    const ran = box.execUntimed('exec sleep 60', { cwd, execId: 'starting' });
    await starting.reached;

    const killed = box.killUntimed('starting');
    starting.release();

    expect(await killed).toBe(true);
    expect((await ran).exitCode).not.toBe(0);
  });
  test('a cancellation during readiness prevents the command from ever starting', async () => {
    const { box, container } = harness(TestBox, undefined, localExec);
    const admission = gate();
    container.containerStartGate = admission;
    const cwd = mkdtempSync(join(root, 'pre-admission-'));
    const marker = join(cwd, 'must-not-exist');

    const ran = Promise.allSettled([box.execUntimed(`sleep 10; touch '${marker}'`, { cwd, execId: 'cancel-before-ready' })]);

    try {
      await admission.reached;
      const cancelled = await box.killUntimed('cancel-before-ready');
      admission.release();
      const [outcome] = await ran;
      const kind = outcome.status === 'rejected' ? devboxFailure({ cause: outcome.reason })?.code : 'completed';

      expect({ cancelled, outcome: kind, wrote: existsSync(marker) })
        .toEqual({ cancelled: true, outcome: 'cancelled', wrote: false });
      expect(await box.killUntimed('cancel-before-ready')).toBe(false);
    } finally {
      admission.release();
      await ran;
      await box.destroy();
    }
  });
});
