// D50: sizes applied at the one start boundary, and one-call `resize`, over real local processes.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_BOX_SIZE } from '../src/sizes';
import { devboxFailure } from '../src/errors';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, HARNESS_IMAGE, harness } from './support/devbox-harness';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}box-size-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

const localExec: Container['exec'] = async (argv, options) => {
  const child = Bun.spawn(argv, { cwd: options?.cwd, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = child.exited;

  return {
    isPty: false,
    resize: async () => { throw new Error('the local pipe test cannot resize a PTY'); },
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

const INSTANCES = {
  small: { vcpu: 1, memoryMib: 4_096, diskMb: 20_000 },
  medium: { vcpu: 2, memoryMib: 8_192, diskMb: 20_000 },
  large: { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 },
};

const instance = (size: keyof typeof INSTANCES) => INSTANCES[size];

test('a box with no size chosen starts at the default size, on the image the host named `devbox`', async () => {
  const { box, container } = harness(TestBox);
  await box.start();

  expect(DEFAULT_BOX_SIZE).toBe('medium');
  expect(container.startOptions).toEqual([{ image: HARNESS_IMAGE, instance: instance('medium'), enableInternet: true }]);
  expect(await box.boxSize()).toEqual({ size: 'medium', running: 'medium' });
  await box.destroy();
});

test('resizing a box that has never started records the size and starts nothing; its first start uses it', async () => {
  const { box, container } = harness(TestBox);

  expect(await box.resize('large')).toEqual({ kind: 'recorded', size: 'large', previous: undefined });
  expect({ starts: container.startOptions.length, running: container.running.running }).toEqual({ starts: 0, running: false });

  // The /sandbox mount's first file call starts the box.
  await box.writeFile('/workspace/first.txt', 'first');

  expect(container.startOptions.map((options) => options?.instance)).toEqual([instance('large')]);
  expect(await box.boxSize()).toEqual({ size: 'large', running: 'large' });
  await box.destroy();
});

test('resizing to the size a box runs at changes nothing', async () => {
  const { box, container } = harness(TestBox);
  await box.start();

  expect(await box.resize('medium')).toEqual({ kind: 'unchanged', size: 'medium', previous: 'medium' });
  expect({ starts: container.startOptions.length, stops: container.stops, destroys: container.destroys })
    .toEqual({ starts: 1, stops: 0, destroys: 0 });
  await box.destroy();
});

test('an unknown size is refused and the recorded size stays', async () => {
  const { box } = harness(TestBox);
  await box.setSize('small');

  const [refused] = await Promise.allSettled([box.resize('huge')]);

  expect(refused.status === 'rejected' ? devboxFailure({ cause: refused.reason }) : refused)
    .toMatchObject({ code: 'invalid-input', message: 'no box size huge; the sizes are small, medium, large' });
  expect(await box.boxSize()).toEqual({ size: 'small', running: undefined });
});

test('setting a size records it for the next start and leaves the running container alone', async () => {
  const { box, container } = harness(TestBox);
  await box.start();

  expect(await box.setSize('small')).toBe('small');
  expect(await box.boxSize()).toEqual({ size: 'small', running: 'medium' });
  expect((await box.devboxState())).toMatchObject({ size: 'small', runningSize: 'medium' });

  await box.quiesce();
  await box.start();

  expect(container.startOptions.map((options) => options?.instance)).toEqual([instance('medium'), instance('small')]);
  await box.destroy();
});

test('resizing a running box commits and starts it again at the new size; a running command ends and a supervised process comes back', async () => {
  const { box, container } = harness(TestBox, undefined, localExec);
  await box.start();
  const cwd = join(root, 'resize');
  mkdirSync(cwd, { recursive: true });
  const supervised = await box.startSupervised('node server.js');
  // A FIFO: the read returns once the command runs, so the resize lands on a live command.
  const started = join(cwd, 'started');
  Bun.spawnSync(['mkfifo', started]);
  const running = box.execUntimed(`echo up > ${started}; exec sleep 60`, { cwd, execId: 'held' });
  await Bun.file(started).text();

  const resized = await box.resize('large');
  const ended = await running;

  expect(resized).toMatchObject({ kind: 'restarted', size: 'large', previous: 'medium', endedCommands: 1 });
  expect(ended.exitCode).not.toBe(0);
  expect(container.startOptions.map((options) => options?.instance)).toEqual([instance('medium'), instance('large')]);
  expect(container.starts.filter((start) => start.processId === supervised.processId)).toHaveLength(2);
  expect(await box.boxSize()).toEqual({ size: 'large', running: 'large' });
  expect((await box.devboxState()).ready).toBe(true);
  await box.destroy();
});

test('a resize goes ahead over an unmanaged command, which a rest would refuse to stop (D35)', async () => {
  const { box, container } = harness(TestBox);
  await box.start();
  const process = await box.startProcess('detached-work');

  expect((await box.quiesce()).kind).toBe('failed');
  expect(await box.resize('small')).toMatchObject({ kind: 'restarted', size: 'small', previous: 'medium' });
  expect(await box.getProcess(process.id)).toBeNull();
  expect(container.startOptions.map((options) => options?.instance)).toEqual([instance('medium'), instance('small')]);
  await box.destroy();
});

test('a host that names no image is refused its start as a permanent configuration error that names the image, and arms no retry', async () => {
  class NoImageBox extends TestBox {
    protected override get containerImage(): string | undefined {
      return undefined;
    }
  }

  const { box, container } = harness(NoImageBox);
  await box.start();
  const [ready] = await Promise.allSettled([box.resolveReadiness()]);
  const reason = expect.stringContaining('[permanent -> refuse] no image to start: name it `devbox` in the container `images` map');

  const incidents = (await box.devboxIncidentReasons()).map((row) => row.reason);

  expect({ ready, named: incidents.length > 0 && incidents.every((incident) => incident.includes('no image to start')), armed: container.scheduleRows.filter((row) => row.callback === 'devboxStartup').length })
    .toEqual({ ready: { status: 'rejected', reason: expect.objectContaining({ message: reason }) }, named: true, armed: 0 });
});
