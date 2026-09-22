// Supervised process lifecycle through the real Devbox: start records the row before the
// process; stop keeps the row unless the kill is confirmed, so the row names a live process.
import { beforeEach, describe, expect, test } from 'bun:test';

import { Devbox, harness, SandboxFailure, type FakeSandbox } from './support/devbox-harness';

const COMMAND = 'bun run server.ts';

/** The transient the caller retries on, and the one that can strike between
 *  the reservation and the process. */
const LOST = 'network connection lost';

/** The specs the box would restore after a recycle: its own public answer, so
 *  no test needs to know a storage key. */
async function reservations(box: InstanceType<typeof Devbox>): Promise<readonly string[]> {
  return (await box.devboxState()).supervised.map(spec => spec.processId);
}

describe('starting a supervised process reserves its id before the process exists', () => {
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

  test('a container answering PROCESS_NOT_FOUND is absence, and the spec goes', async () => {
    // A restarted spec keeps its id, so a caller may hold the previous one. The container
    // answered that it holds no such id; keeping the row would restore a nonexistent process.
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.killFaults.push(new SandboxFailure({
      code: 'PROCESS_NOT_FOUND',
      message: 'Process not found',
    }));

    expect(await box.stopSupervised(processId)).toEqual({ stopped: false });

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
