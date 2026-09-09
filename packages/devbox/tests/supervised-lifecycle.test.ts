// The supervised process lifecycle, driven through the real Devbox class.
//
// Both defects below are about ORDER — which of a durable row and a container
// process happens first, and what the other one is allowed to do when its
// partner failed. No pure decision can carry that, so the only way to pin
// either is to run the shipped method against the platform stand-in in
// `support/devbox-harness.ts`, which holds the one SDK substitution and explains
// why it exists.
//
// The two defects have one shape: a durable row and a container process are two
// steps, and every earlier version did them in the order that leaves the row
// disagreeing with the world. Starting recorded the row AFTER the process, so a
// lost answer hid a live process from the next attempt, which started a second
// one. Stopping dropped the row EVEN WHEN THE KILL FAILED, so a process that was
// still running lost the only thing that named it.
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
      // The window KINU-N031 lives in. The row and the process are two steps
      // inside the container, and the caller retries on exactly the errors that
      // can strike between them. With the row written second, the retry could
      // only look for a row, found none, and started a second copy: two servers
      // on one port, and the unrecorded one impossible to list, stop or restore.
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
    // The container DID create the process and the reply never arrived. The
    // retry asks about the reserved id, is told it is running, and hands that
    // one back — so the retry costs nothing and creates nothing.
    const { box, container } = harness(Devbox);
    container.startFaults.push({ error: new Error(LOST), created: true });
    await expect(box.startSupervised(COMMAND)).rejects.toThrow(LOST);

    const retried = await box.startSupervised(COMMAND);

    expect(container.starts.map(start => start.processId)).toEqual([retried.processId]);
    expect(container.processes.size).toBe(1);
    expect(await reservations(box)).toEqual([retried.processId]);
  });

  test('a container that cannot answer refuses rather than starting a second copy', async () => {
    // Absence has to be POSITIVE. A query that failed says nothing about
    // whether a process exists, and starting on it is the duplication the
    // reservation exists to prevent — so the call refuses and the reservation
    // stands for the next attempt.
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
    // KINU-N011. The spec is the only thing that names the process, and the
    // restoration walks specs — so deleting it on a kill that did not land left
    // a live server the box could no longer list, stop or bring back.
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.killFaults.push(new Error('container transport reset'));

    expect(await box.stopSupervised(processId)).toEqual({ stopped: false });

    const state = await box.devboxState();
    expect(state.supervised.map(spec => spec.processId)).toEqual([processId]);
    // The reason is durable too, so a box that keeps failing to stop stays
    // visible after the object is evicted.
    expect(state.incidents.total).toBe(1);
    // The process really is still there, which is why the spec had to stay.
    expect(container.processes.has(processId)).toBe(true);

    // The retry addresses the SAME id — no second record was ever created.
    expect(await box.stopSupervised(processId)).toEqual({ stopped: true });
    expect(container.kills).toEqual([processId, processId]);
    expect(await reservations(box)).toEqual([]);
  });

  test('a container answering PROCESS_NOT_FOUND is absence, and the spec goes', async () => {
    // The ordinary post-recycle case: the spec was restarted under its own id
    // and the caller is holding the previous one. The container ANSWERED, and
    // its answer is that it holds no such id, so nothing is running and keeping
    // the row would restore a process that does not exist.
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
    // What the classification used to be: `/not found|unknown/` over the
    // rendered cause chain. Neither failure below says the process is gone.
    // The first is the container reporting a failure IT could not classify,
    // which is the SDK's own `UNKNOWN_ERROR`; the second is a value the SDK
    // never classified at all, which is what every platform and transport
    // failure reaching this call from outside its error tree looks like. Prose
    // was the only thing that made either look like absence, and dropping the
    // spec on it left a live server nothing named, listed, stopped or restored.
    const { box, container } = harness(Devbox);
    const { processId } = await box.startSupervised(COMMAND);
    container.killFaults.push(
      new SandboxFailure({ code: 'UNKNOWN_ERROR', message: 'Unknown error' }),
      new Error('container not found for this sandbox'),
    );

    for (const attempt of [1, 2]) {
      expect(await box.stopSupervised(processId)).toEqual({ stopped: false });
      const state = await box.devboxState();
      // The SAME row, every time, and one filed reason per refusal.
      expect(state.supervised.map(spec => spec.processId)).toEqual([processId]);
      expect(state.incidents.total).toBe(attempt);
    }
    // The process the box refused to forget really is still running.
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
