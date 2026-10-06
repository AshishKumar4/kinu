// D50: sizes applied at the one start boundary, and one-call `resize`, over real local processes.
import { TestDevbox } from './support/test-devbox';
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_BOX_SIZE, type BoxSize } from '../src/sizes';
import { devboxFailure } from '../src/errors';
import { HARNESS_IMAGE, harness } from './support/devbox-harness';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { pipeExec as localExec } from './support/native-process';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}box-size-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

class TestBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}


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
  expect(await box.boxSize()).toEqual({ size: 'medium', chosen: undefined, running: 'medium', startRefused: undefined });
  await box.destroy();
});

test('resizing a box that has never started records the size and starts nothing; its first start uses it', async () => {
  const { box, container } = harness(TestBox);

  expect(await box.resize('large')).toEqual({ kind: 'recorded', size: 'large', previous: undefined });
  expect({ starts: container.startOptions.length, running: container.running.running }).toEqual({ starts: 0, running: false });

  // The /sandbox mount's first file call starts the box.
  await box.writeFile('/workspace/first.txt', 'first');

  expect(container.startOptions.map((options) => options?.instance)).toEqual([instance('large')]);
  expect(await box.boxSize()).toEqual({ size: 'large', chosen: 'large', running: 'large', startRefused: undefined });
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
  await box.resize('small');

  const [refused] = await Promise.allSettled([box.resize('huge')]);

  expect(refused.status === 'rejected' ? devboxFailure({ cause: refused.reason }) : refused)
    .toMatchObject({ code: 'invalid-input', message: 'no box size huge; the sizes are small, medium, large' });
  expect(await box.boxSize()).toEqual({ size: 'small', chosen: 'small', running: undefined, startRefused: undefined });
  const [refusedDefault] = await Promise.allSettled([box.useDefaultSize('huge')]);
  expect(refusedDefault.status === 'rejected' ? devboxFailure({ cause: refusedDefault.reason }) : refusedDefault)
    .toMatchObject({ code: 'invalid-input', message: 'no box size huge; the sizes are small, medium, large' });
});

test('a box that chose no size starts at the default its host stored, over the class\'s own default', async () => {
  class DefaultedBox extends TestBox {
    protected override get defaultSize(): BoxSize {
      return 'small';
    }
  }

  const stored = harness(DefaultedBox);
  expect(await stored.box.useDefaultSize('large')).toBe('large');
  await stored.box.start();
  const bare = harness(DefaultedBox);
  await bare.box.start();

  expect({ stored: stored.container.startOptions.map((options) => options?.instance), bare: bare.container.startOptions.map((options) => options?.instance) })
    .toEqual({ stored: [instance('large')], bare: [instance('small')] });
  await stored.box.destroy();
  await bare.box.destroy();
});

test('a box\'s own choice wins over the stored default, and dropping the choice follows the default again', async () => {
  const { box, container } = harness(TestBox);
  await box.useDefaultSize('large');
  await box.resize('small');
  await box.start();

  expect(await box.boxSize()).toEqual({ size: 'small', chosen: 'small', running: 'small', startRefused: undefined });
  expect(await box.resize(null)).toMatchObject({ kind: 'restarted', size: 'large', previous: 'small' });
  expect(await box.boxSize()).toEqual({ size: 'large', chosen: undefined, running: 'large', startRefused: undefined });
  expect(await box.devboxState()).toMatchObject({ size: 'large', runningSize: 'large' });
  expect(container.startOptions.map((options) => options?.instance)).toEqual([instance('small'), instance('large')]);
  await box.destroy();
});

test('a new stored default is recorded and waits for the running container\'s next start', async () => {
  const { box, container } = harness(TestBox);
  await box.start();

  expect(await box.useDefaultSize('small')).toBe('small');
  expect(await box.boxSize()).toEqual({ size: 'small', chosen: undefined, running: 'medium', startRefused: undefined });
  await box.quiesce();
  await box.start();
  expect(await box.useDefaultSize(null)).toBe('medium');
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
  expect(await box.boxSize()).toEqual({ size: 'large', chosen: 'large', running: 'large', startRefused: undefined });
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

/** Names no image until its host deploys one, so the platform refuses each start the same way. */
class LateImageBox extends TestBox {
  image: string | undefined = undefined;

  protected override get containerImage(): string | undefined {
    return this.image;
  }
}

const NO_IMAGE = '[permanent -> refuse] no image to start: name it `devbox` in the container `images` map';

async function refusedStart() {
  const made = harness(LateImageBox);
  await made.box.start();

  return made;
}

async function refusalOf<T>(asked: Promise<T>): Promise<T | string | undefined> {
  const [settled] = await Promise.allSettled([asked]);
  const failure = settled.status === 'rejected' ? devboxFailure({ cause: settled.reason }) : undefined;

  return settled.status === 'rejected' ? `${failure?.code ?? 'uncoded'}: ${failure?.message ?? String(settled.reason)}` : settled.value;
}

const startupRows = (container: { readonly scheduleRows: readonly { readonly callback: string }[] }) =>
  container.scheduleRows.filter((row) => row.callback === 'devboxStartup').length;

// Red on 719c2d1ac: each request started the box again and filed another incident.
test('a start that fails permanently is refused once: later requests and a successor after eviction answer the recorded refusal without starting again', async () => {
  const { box, container, state } = await refusedStart();
  const asked = [await refusalOf(box.resolveReadiness()), await refusalOf(box.resolveReadiness())];
  const successor = new LateImageBox(state, {});
  container.owner = successor;
  await successor.kickStartup();
  const armedByKick = startupRows(container);
  asked.push(await refusalOf(successor.resolveReadiness()));

  expect({
    asked,
    starts: container.startOptions.length,
    incidents: (await successor.devboxIncidentReasons()).map((row) => row.reason),
    armed: [armedByKick, startupRows(container)],
    reported: (await successor.boxSize()).startRefused,
  }).toEqual({
    asked: Array.from({ length: 3 }, () => expect.stringMatching(/^refused: this devbox has no attached work directory: .*no image to start.*nothing retries it\.$/)),
    starts: 1,
    incidents: [expect.stringContaining(NO_IMAGE)],
    armed: [0, 0],
    reported: expect.stringContaining(NO_IMAGE),
  });
});

test('a changed input asks again: an image the host names later, another size, the internet setting, or an explicit attach or start', async () => {
  const imaged = await refusedStart();
  imaged.box.image = HARNESS_IMAGE;
  const ready = await imaged.box.resolveReadiness();
  const cleared = (await imaged.box.boxSize()).startRefused;

  const resized = await refusedStart();
  await resized.box.resize('large');
  await refusalOf(resized.box.resolveReadiness());

  const offline = await refusedStart();
  offline.box.enableInternet = false;
  await refusalOf(offline.box.resolveReadiness());

  const attached = await refusedStart();
  const reattached = await refusalOf(attached.box.attachNow());

  const restarted = await refusedStart();
  await restarted.box.start();

  expect({
    ready,
    cleared,
    resized: resized.container.startOptions.map((options) => options?.instance),
    offline: offline.container.startOptions.map((options) => options?.enableInternet),
    reattached,
    attached: attached.container.startOptions.length,
    incidents: (await attached.box.devboxIncidentReasons()).length,
    restarted: restarted.container.startOptions.length,
  }).toEqual({
    ready: { kind: 'restored' },
    cleared: undefined,
    resized: [instance('medium'), instance('large')],
    offline: [true, false],
    reattached: expect.stringContaining(NO_IMAGE),
    attached: 2,
    incidents: 2,
    restarted: 2,
  });

  for (const { box } of [imaged, resized, offline, attached, restarted]) await box.destroy();
});

// The platform's own words when it has no room (D36; `bench-artifacts/side-by-side/c-before.log`, 2026-09-30).
test('a capacity answer is a retry, never a recorded refusal: a successor starts the box once the platform has room', async () => {
  const { box, container, state, rows } = harness(TestBox);
  const capacity = 'There is no container instance that can be provided to this Durable Object, try again later';
  container.startFaultBeforeRunning = new Error(capacity);

  const refused = await box.resolveReadiness();
  const recorded = { row: rows.get('devbox:start-refused'), reported: (await box.boxSize()).startRefused, armed: startupRows(container) };
  const successor = new TestBox(state, {});
  container.owner = successor;

  expect({ refused, recorded, ready: await successor.resolveReadiness(), starts: container.startOptions.length }).toEqual({
    refused: { kind: 'pending', reason: expect.stringContaining(capacity) },
    recorded: { row: undefined, reported: undefined, armed: 1 },
    ready: { kind: 'restored' },
    starts: 2,
  });
  await successor.destroy();
});
