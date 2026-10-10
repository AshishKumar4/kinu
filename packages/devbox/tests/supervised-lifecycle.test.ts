// Supervised process lifecycle through the real Devbox: start records the row before the
// process; stop keeps the row unless the kill is confirmed, so the row names a live process.
import { beforeEach, describe, expect, test } from 'bun:test';

import { Devbox, gate, harness, SandboxFailure, type FakeSandbox } from './support/devbox-harness';
import { handClock } from '../../test-utils/src/hand-clock';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy, type StartClock } from '../src/lifecycle';

const COMMAND = 'bun run server.ts';

/** The transient the caller retries on, and the one that can strike between
 *  the reservation and the process. */
const LOST = 'network connection lost';

const REPAIR_ID = 'owed-server';

class InterleavingBox extends Devbox {
  readonly clock = handClock(1_000_000);

  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, attachBudgetMs: 1_000 };
  }

  protected override get startClock(): StartClock {
    return this.clock;
  }
}

/** The real startup records a refused native start; the still-running work directory stays operable for repair. */
async function missingService() {
  const made = harness(InterleavingBox);

  made.rows.set(`devbox:proc:${REPAIR_ID}`, { processId: REPAIR_ID, command: COMMAND, cwd: '/workspace', createdAt: 1 });
  made.container.startFaults.push({ error: new Error('native server start refused'), created: false });
  await made.box.devboxStartup();
  expect((await made.box.devboxState()).restoration).toBe('repair');

  return made;
}

/** The specs the box would restore after a recycle: its own public answer, so
 *  no test needs to know a storage key. */
async function reservations(box: InstanceType<typeof Devbox>): Promise<readonly string[]> {
  return (await box.devboxState()).supervised.map(spec => spec.processId);
}

describe('starting a supervised process reserves its id before the process exists', () => {
  test('concurrent starts reserve one process identity for the same command and cwd', async () => {
    const { box, container } = harness(Devbox);

    const [first, second] = await Promise.all([
      box.startSupervised(COMMAND, '/workspace'),
      box.startSupervised(COMMAND, '/workspace'),
    ]);

    expect(second.processId).toBe(first.processId);
    expect(container.starts.map(({ processId }) => processId)).toEqual([first.processId]);
    expect(await reservations(box)).toEqual([first.processId]);
  });

  for (const entry of ['public start', 'same-container repair', 'late startup'] as const) {
    test(`${entry} / stop / successor keeps one supervised generation and fences abandoned work`, async () => {
      const { box, container, rows } = entry === 'same-container repair' ? await missingService() : harness(InterleavingBox);
      let processId = REPAIR_ID;

      if (entry === 'public start') {
        processId = (await box.startSupervised(COMMAND)).processId;
        container.processes.clear();
      } else if (entry === 'late startup') {
        rows.set(`devbox:proc:${processId}`, { processId, command: COMMAND, cwd: '/workspace', createdAt: 1 });
      }

      const nativeGet = container.getProcess.bind(container);
      const paused = gate();
      let held = true;

      container.getProcess = async (id) => {
        if (id === processId && held) {
          held = false;
          paused.enter();
          await paused.promise;
        }

        return nativeGet(id);
      };

      let launching: Promise<unknown>;

      if (entry === 'public start') launching = box.startSupervised(COMMAND);
      else if (entry === 'same-container repair') launching = box.attachNow();
      else launching = box.devboxStartup();

      await paused.reached;

      if (entry === 'late startup') {
        expect(box.clock.armed()).toBeGreaterThan(0);
        box.clock.tick();
        await launching;
        expect((await box.devboxState()).restoration).toBe('repair');
      }

      const stopping = box.stopSupervised(processId);

      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = box.startSupervised(COMMAND);
      let whileHeld: readonly string[] = [];

      try {
        whileHeld = await reservations(box);
      } finally {
        paused.release();
        await Promise.all([launching, stopping, next]);
      }

      const last = await next;

      expect(last.processId).not.toBe(processId);
      expect({ whileHeld, stopped: (await stopping).stopped, supervised: await reservations(box), live: [...container.processes.keys()] })
        .toEqual({ whileHeld: [processId], stopped: true, supervised: [last.processId], live: [last.processId] });

      if (entry === 'late startup') expect(container.starts.every((started) => started.processId !== processId)).toBe(true);
    });
  }

  test('repair rechecks a reservation withdrawn after its plan snapshot before native launch', async () => {
    const { box, container, storage } = await missingService();
    const deleting = gate();

    storage.gateDeleteOn(`devbox:proc:${REPAIR_ID}`, deleting);
    const stopping = box.stopSupervised(REPAIR_ID);

    await deleting.reached;
    const repairing = box.attachNow();

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      deleting.release();
      await Promise.all([stopping, repairing]);
    }

    expect(await stopping).toEqual({ stopped: true });
    expect({ supervised: await reservations(box), live: [...container.processes.keys()] }).toEqual({ supervised: [], live: [] });
    expect((await box.devboxState()).ready).toBe(true);

    const last = await box.startSupervised(COMMAND);

    expect(last.processId).not.toBe(REPAIR_ID);
    expect({ supervised: await reservations(box), live: [...container.processes.keys()] })
      .toEqual({ supervised: [last.processId], live: [last.processId] });
  });

  test('cwd is part of the supervised command identity', async () => {
    const { box, container } = harness(Devbox);

    await box.mkdir('/workspace/other', { recursive: true });

    const [first, second] = await Promise.all([
      box.startSupervised(COMMAND, '/workspace'),
      box.startSupervised(COMMAND, '/workspace/other'),
    ]);

    expect(second.processId).not.toBe(first.processId);
    expect(new Set(container.starts.map(({ cwd }) => cwd))).toEqual(new Set(['/workspace', '/workspace/other']));
    expect(new Set(await reservations(box))).toEqual(new Set([first.processId, second.processId]));
  });

  test('the durable spec names the process the container was asked to create', async () => {
    const { box, container } = harness(Devbox);

    const { processId } = await box.startSupervised(COMMAND);

    expect(container.starts).toEqual([
      { command: COMMAND, cwd: '/workspace', processId },
    ]);
    expect(await reservations(box)).toEqual([processId]);
  });

  test('a reset between the reservation and the start never creates a second process',
    async () => {
      // The caller retries on errors that strike between the row write and the process start;
      // the row must come first so the retry reuses its id instead of starting a second copy.
      const first = harness(Devbox);
      first.container.startFaults.push({ error: new Error(LOST), created: false });
      await expect(first.box.startSupervised(COMMAND)).rejects.toThrow(LOST);
      const [reserved] = await reservations(first.box);
      expect(reserved).toBeString();

      // A NEW isolate on the same durable rows and a replaced container: the
      // reset the caller is retrying through.
      const second = harness(Devbox);

      for (const [key, value] of first.rows) second.rows.set(key, value);

      const retried = await second.box.startSupervised(COMMAND);

      expect(retried.processId).toBe(reserved);
      expect(await reservations(second.box)).toEqual([retried.processId]);
      expect([...second.container.processes.keys()]).toEqual([retried.processId]);
    });

  test('a start whose answer was lost is adopted, not repeated', async () => {
    const { box, container } = harness(Devbox);
    container.startFaults.push({ error: new Error(LOST), created: true });
    await expect(box.startSupervised(COMMAND)).rejects.toThrow(LOST);

    const retried = await box.startSupervised(COMMAND);

    expect(container.starts.map(start => start.processId)).toEqual([retried.processId]);
    expect(container.processes.size).toBe(1);
    expect(await reservations(box)).toEqual([retried.processId]);
  });

  test('a container that cannot answer refuses rather than starting a second copy', async () => {
    // Absence must be positive: a failed query says nothing about whether the process exists,
    // so starting on it would duplicate; the call refuses and the reservation stands.
    const { box, container } = harness(Devbox);
    await box.startSupervised(COMMAND);
    const reserved = await reservations(box);
    container.getFaults.push(new Error('container transport reset'));

    await expect(box.startSupervised(COMMAND)).rejects.toThrow('container transport reset');

    expect(container.starts).toHaveLength(1);
    expect(container.processes.size).toBe(1);
    expect(await reservations(box)).toEqual([...reserved]);
  });

  test('a reserved id whose process is gone is started again under that same id', async () => {
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.processes.clear();

    const restarted = await box.startSupervised(COMMAND);

    expect(restarted.processId).toBe(processId);
    expect(container.starts.map(start => start.processId)).toEqual([processId, processId]);
    expect(await reservations(box)).toEqual([processId]);
  });
});

describe('stopping a supervised process drops its spec only on evidence', () => {
  test('a confirmed kill takes the spec with it', async () => {
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);

    expect(await box.stopSupervised(processId)).toEqual({ stopped: true });

    expect(container.kills).toEqual([processId]);
    expect(await reservations(box)).toEqual([]);
  });

  test('a kill that failed keeps the SAME spec, so a later stop can retry it', async () => {
    // The spec alone names the process and restoration walks specs: dropping it on a failed kill
    // leaves a live server the box cannot list, stop or bring back.
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.killFaults.push(new Error('container transport reset'));

    expect(await box.stopSupervised(processId)).toEqual({ stopped: false });

    const state = await box.devboxState();
    expect(state.supervised.map(spec => spec.processId)).toEqual([processId]);
    // The reason is durable too, so a box that keeps failing to stop stays
    // visible after the object is evicted.
    expect(state.incidents.total).toBe(1);
    expect(container.processes.has(processId)).toBe(true);

    expect(await box.stopSupervised(processId)).toEqual({ stopped: true });
    expect(container.kills).toEqual([processId, processId]);
    expect(await reservations(box)).toEqual([]);
  });

  test('a native process already gone leaves no launch record or failure incident', async () => {
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.processes.delete(processId);
    container.files.delete(`/var/tmp/devbox/processes/${processId}/process.json`);
    await box.stopSupervised(processId);

    const state = await box.devboxState();
    expect(state.supervised).toEqual([]);
    expect(state.incidents.total).toBe(0);
  });

  test('KINU-N011: prose saying "unknown" and "not found" is NOT absence', async () => {
    // Neither fault means the process is gone: `UNKNOWN_ERROR` is unclassified by the container,
    // the bare Error is an unclassified platform/transport failure; a prose match would drop it.
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.killFaults.push(
      new SandboxFailure({ code: 'UNKNOWN_ERROR', message: 'Unknown error' }),
      new Error('container not found for this sandbox'),
    );

    for (const attempt of [1, 2]) {
      expect(await box.stopSupervised(processId)).toEqual({ stopped: false });
      const state = await box.devboxState();
      expect(state.supervised.map(spec => spec.processId)).toEqual([processId]);
      expect(state.incidents.total).toBe(attempt);
    }

    expect(container.processes.has(processId)).toBe(true);
  });
});

describe('the fakes can fail, so the assertions above are not vacuous', () => {
  let container: FakeSandbox;
  beforeEach(() => {
    container = harness(Devbox).container;
  });

  test('a queued start fault applies once and the container keeps the process', async () => {
    container.startFaults.push({ error: new Error(LOST), created: true });
    await expect(container.startProcess('x', { processId: 'p1' })).rejects.toThrow('lost');
    expect(container.processes.has('p1')).toBe(true);
    await expect(container.startProcess('x', { processId: 'p2' })).resolves.toMatchObject({
      id: 'p2',
    });
  });

  test('a queued start fault that created nothing leaves the container empty', async () => {
    container.startFaults.push({ error: new Error(LOST), created: false });
    await expect(container.startProcess('x', { processId: 'p1' })).rejects.toThrow('lost');
    expect(container.processes.size).toBe(0);
  });
});
