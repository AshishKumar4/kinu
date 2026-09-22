import { describe, expect, test } from 'bun:test';

import type { RestoreClockPhase } from '../src/devbox';
import type { StoredValue } from '../src/storage';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import {
  Devbox, FakeSandbox, STAMP_COMMAND, TEST_BOX_ID, boxState, deliver, fakeStorage, gate, harness,
  scheduleTableOf, type Harness,
} from './support/devbox-harness';

/** The listener proof is one container command whose loop the container bounds,
 *  so a short `portWaitMs` shortens that command rather than a timer. */
const TEST_POLICY: DevboxPolicy = {
  ...DEFAULT_DEVBOX_POLICY,
  portWaitMs: 4,
  portProbeIntervalMs: 1,
};

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return TEST_POLICY;
  }

  protected override get previewHost(): string | undefined {
    return 'preview.test';
  }
}

function proc(rows: Map<string, StoredValue>, processId: string): void {
  rows.set(`devbox:proc:${processId}`, {
    processId, command: 'bun run server.ts', cwd: '/workspace', createdAt: 1,
  });
}

function port(rows: Map<string, StoredValue>, value: number, token: string): void {
  rows.set(`devbox:port:${value}`, { port: value, name: 'web', token, createdAt: 1 });
}

const stamps = (container: FakeSandbox): number =>
  container.execs.filter((command) => command.includes(STAMP_COMMAND)).length;

/** Startup rows the box is actually holding: the live table, not the log of
 *  arm calls. */
const armed = (container: FakeSandbox): number =>
  container.scheduleRows.filter((row) => row.callback === 'devboxStartup').length;

/** The container is stopped so the next start really runs the container-start hook. */
async function stoppedBoxWithService(): Promise<Harness<TestBox>> {
  const harnessed: Harness<TestBox> = harness(TestBox);
  proc(harnessed.rows, 'p1');
  port(harnessed.rows, 3000, 'tok3000');
  harnessed.container.listening.add(3000);
  await harnessed.container.stop();

  return harnessed;
}

/** A box with a service to restore on a RUNNING container: a heartbeat-spotted replacement
 *  or a platform-delivered wake. */
function runningBoxWithService(): Harness<TestBox> {
  const harnessed: Harness<TestBox> = harness(TestBox);
  proc(harnessed.rows, 'p1');
  port(harnessed.rows, 3000, 'tok3000');
  harnessed.container.listening.add(3000);

  return harnessed;
}

interface Activated {
  readonly box: TestBox;
  readonly container: FakeSandbox;
  readonly activation: Promise<unknown>;
}

function activatedOverRunning(rows: Map<string, StoredValue>): Activated {
  const storage = fakeStorage();

  for (const [key, value] of rows) storage.rows.set(key, value);
  let activation: Promise<unknown> = Promise.resolve();

  // The fake `blockConcurrencyWhile` captures the closure's promise so the test can await
  // the activation itself.
  const state = boxState({
    storage: storage.handle,
    id: TEST_BOX_ID,
    container: { running: true },
    blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> => {
      const run = closure();
      activation = run;

      return await run;
    },
  });

  const box = new TestBox(state, {});
  const container = FakeSandbox.last;

  if (container === undefined) {
    throw new Error('the substituted Sandbox base class did not run its constructor');
  }

  return { box, container, activation };
}

describe('the start hook owns restoration', () => {
  for (const arrival of ['before running', 'before hook'] as const) {
    test(`after quiesce, exec arriving ${arrival} joins the replacement restore`, async () => {
      const { box, container } = harness(TestBox);
      await box.ensureReady();
      const oldBoot = container.bootId;
      await box.quiesce();
      expect(container.running.running).toBe(false);
      const window = gate();
      const restored = gate();

      if (arrival === 'before running') container.containerStartGate = window;
      else container.containerHookGate = window;
      container.stampGate = restored;
      const startup = box.devboxStartup();
      await window.reached;
      expect(container.running.running).toBe(arrival === 'before hook');
      let settled = false;

      const caller = (async () => {
        try {
          return { output: await box.exec('cat /tmp/devbox-boot-id 2>/dev/null || true') };
        } catch (error) {
          return { error };
        } finally {
          settled = true;
        }
      })();

      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        window.release();
        await restored.reached;
        expect(settled).toBe(false);
      } finally {
        window.release();
        restored.release();
        await startup;
      }

      expect(await caller).toMatchObject({ output: { stdout: container.bootId, stderr: '', exitCode: 0 } });
      expect(container.bootId).toBeString();
      expect(container.bootId).not.toBe(oldBoot);
      expect(stamps(container)).toBe(2);
      expect((await box.devboxState()).ready).toBe(true);
    });
  }

  for (const termination of ['stop', 'destroy'] as const) {
    test(`actual container ${termination} loses local state while the same identity keeps durable state`, async () => {
      const { box, container, rows } = harness(TestBox);
      await box.ensureReady();
      await box.writeFile('/tmp/uncheckpointed-marker', 'local only');
      const identity = container.ctx.id.toString();
      const previousBoot = container.bootId;
      const remote = new Map([['backups/remote', new Uint8Array([1, 2, 3])]]);
      container.chainStore = { root: 'backups', objects: remote };
      rows.set('durable-lifecycle-marker', 'keep this');
      container.stagedArchives.set('/var/tmp/devbox/local-stage', new Uint8Array([4]));
      container.s3fsMounts.add('/backups');
      container.overlayMounts.add('/workspace');
      container.layerMounts.add('/var/tmp/devbox/lower-base');


      await container[termination]();

      expect(container.files.size).toBe(0);
      expect(container.bootId).toBeUndefined();
      expect(container.stagedArchives.size).toBe(0);
      expect(container.s3fsMounts.size + container.overlayMounts.size + container.layerMounts.size).toBe(0);
      expect(rows.get('durable-lifecycle-marker')).toBe('keep this');
      expect(remote.get('backups/remote')).toEqual(new Uint8Array([1, 2, 3]));

      await box.start();
      await box.ensureReady();
      expect(container.ctx.id.toString()).toBe(identity);
      expect(container.bootId).not.toBe(previousBoot);
      await expect(box.readFile('/tmp/uncheckpointed-marker')).rejects.toThrow('File not found');
    });

    test(`a refused container ${termination} keeps the still-running generation intact`, async () => {
      const { box, container } = harness(TestBox);
      await box.ensureReady();
      await box.writeFile('/tmp/uncheckpointed-marker', 'local only');
      const previousBoot = container.bootId;
      container.stagedArchives.set('/var/tmp/devbox/local-stage', new Uint8Array([4]));
      container.s3fsMounts.add('/backups');
      container.overlayMounts.add('/workspace');
      container.layerMounts.add('/var/tmp/devbox/lower-base');
      container[termination === 'stop' ? 'stopFault' : 'destroyFault'] = new Error('termination refused');

      await expect(container[termination]()).rejects.toThrow('termination refused');

      expect(container.running.running).toBe(true);
      expect(container.bootId).toBe(previousBoot);
      expect(container.stagedArchives.size).toBe(1);
      expect(container.s3fsMounts.size + container.overlayMounts.size + container.layerMounts.size).toBe(3);
      expect((await box.readFile('/tmp/uncheckpointed-marker')).content).toBe('local only');
    });
  }

  test('T1: restore holds the hook and readiness is absent until it settles', async () => {
    const { box, container, rows } = await stoppedBoxWithService();

    const parked = gate();
    container.stampGate = parked;
    let returned = false;
    const start = box.start().then(() => { returned = true; });
    await parked.reached;
    expect(returned).toBe(false);
    expect(container.initGate).toBeUndefined();
    expect(rows.get('devbox:restoration')).toEqual({
      phase: 'restoring', where: 'start', since: expect.any(Number),
    });
    expect((await box.devboxState()).ready).toBe(false);
    parked.release();
    await start;
    expect(rows.get('devbox:restoration')).toEqual({ phase: 'attached' });
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('T2: the delivered command follows restore, process resumption and exposure', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
    expect(container.exposures).toEqual([{ port: 3000, token: 'tok3000', name: 'web' }]);
    expect((await deliver(container, () => box.exec('echo hi'))).exitCode).toBe(0);
    expect(container.execs.findIndex(command => command.includes(STAMP_COMMAND)))
      .toBeLessThan(container.execs.findIndex(command => command.includes('echo hi')));
  });

  test('a failed settled-phase write never publishes readiness', async () => {
    const { box, container, storage, rows } = await stoppedBoxWithService();
    const parked = gate();
    container.stampGate = parked;
    const start = box.start();
    await parked.reached;
    storage.faultOn('devbox:restoration', new Error('settled row could not be persisted'));
    parked.release();
    await start;
    expect((await box.devboxState()).ready).toBe(false);
    expect(rows.get('devbox:restoration')).not.toEqual({ phase: 'attached' });
    expect(await box.resolveReadiness()).toMatchObject({ kind: 'pending' });
  });

  test('a fresh boot replaces the old settled row with an unready claim before stamping', async () => {
    const { box, container, rows } = runningBoxWithService();
    container.running.running = true;
    rows.set('devbox:boot-id', 'old-boot');
    rows.set('devbox:restoration', { phase: 'attached' });
    const parked = gate();
    container.stampGate = parked;
    const start = box.start();
    await parked.reached;
    expect(rows.get('devbox:restoration')).toEqual({
      phase: 'restoring', where: 'start', since: expect.any(Number),
    });
    expect((await box.devboxState()).ready).toBe(false);
    parked.release();
    await start;
    expect(rows.get('devbox:restoration')).toEqual({ phase: 'attached' });
    expect(rows.get('devbox:boot-id')).not.toBe('old-boot');
  });

  test('T3: a second onStart on the same boot adopts without restoring', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    const before = { stamps: stamps(container), starts: container.starts.length };
    await box.onStart();
    expect({ stamps: stamps(container), starts: container.starts.length }).toEqual(before);
    expect(await box.resolveReadiness()).toEqual({ kind: 'restored' });
  });

  test('a stale startup schedule does not reopen the hook around an active caller', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    const parked = gate();
    container.execGate = parked;
    const caller = box.exec('echo active caller');
    await parked.reached;
    const commands = container.execs.length;

    try {
      await box.devboxStartup();
      expect(container.execs).toHaveLength(commands);
      expect((await box.devboxState()).ready).toBe(true);
    } finally {
      parked.release();
      await caller;
    }
  });

  test('an interrupted durable claim refuses a second restore on the same boot', async () => {
    const { box, container, rows } = runningBoxWithService();
    container.running.running = true;
    container.bootId = 'interrupted-boot';
    rows.set('devbox:boot-id', 'interrupted-boot');
    rows.set('devbox:restoration', { phase: 'restoring', where: 'start', since: 1 });
    rows.set('devbox:attach-recovery', { owner: 'interrupted-owner' });
    await box.start();
    expect(stamps(container)).toBe(0);
    expect(container.starts).toEqual([]);
    expect((await box.devboxState()).unready).toContain('[abandoned → replace]');
    container.deleteSchedules('devboxStartup');
    await expect(box.resolveReadiness()).rejects.toThrow('no attached work directory');
    expect(armed(container)).toBe(1);
    await box.devboxStartup();
    expect(container.destroys).toBe(1);
    expect(container.running.running).toBe(false);
    await box.ensureReady();
    expect(stamps(container)).toBe(1);
  });

  test('a failed recovery transaction spends no destructive ladder rung', async () => {
    const { box, container, rows, storage } = runningBoxWithService();
    storage.faultOn('devbox:last-attach', new Error('the attach record failed'));
    storage.faultOn('devbox:recovery-action', new Error('the recovery action write failed'));
    await box.start();
    expect(rows.get('devbox:attach-recovery')).toEqual({ owner: expect.any(String), stage: 'retry' });
    expect(rows.get('devbox:recovery-action')).toEqual({
      owner: expect.any(String), action: 'retry', reason: expect.any(String),
    });
    expect((await box.devboxState()).ready).toBe(false);
    expect(container.destroys).toBe(0);
  });

  test('T4: successful hook settlement retires startup immediately', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    expect(armed(container)).toBe(0);
    await box.resolveReadiness();
    expect(armed(container)).toBe(0);
  });

  test('T5: delivered requests join readiness while the RPC input gate stays open', async () => {
    const { box, container } = await stoppedBoxWithService();
    const parked = gate();
    container.stampGate = parked;
    const start = box.start();
    await parked.reached;
    expect(container.initGate).toBeUndefined();
    const first = deliver(container, () => box.exec('echo first'));
    const second = deliver(container, () => box.exec('echo second'));
    expect(container.execs.some(command => command.startsWith('echo'))).toBe(false);
    parked.release();
    await start;
    expect((await first).exitCode).toBe(0);
    expect((await second).exitCode).toBe(0);
    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
  });

  test('T5b: a running boot without a coordinator creates and joins its port-proven start', async () => {
    const { box, container } = runningBoxWithService();
    container.running.running = true;
    expect(await box.resolveReadiness()).toEqual({ kind: 'restored' });
    expect(container.startWaitOptions).toHaveLength(1);
    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
    expect(armed(container)).toBe(0);
  });

  test('T6: the in-flight phase names the hook', async () => {
    const { box, container } = runningBoxWithService();
    const parked = gate();
    container.stampGate = parked;
    const start = box.start();
    await parked.reached;
    const state = await box.devboxState();
    expect(state.restoration).toBe('restoring');
    expect(state.unready).toContain('in the start');
    parked.release();
    await start;
    expect((await box.devboxState()).restoration).toBe('attached');
  });

  test('T7: a re-entered hook joins one in-memory attempt', async () => {
    const { box, container } = runningBoxWithService();
    container.running.running = true;
    const parked = gate();
    container.stampGate = parked;
    const first = box.onStart();
    await parked.reached;
    const second = box.onStart();
    parked.release();
    await Promise.all([first, second]);
    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
  });

  test('T8: an activation adopts the durable settled generation at the request door', async () => {
    const restored = await stoppedBoxWithService();
    await restored.box.start();
    const { box, container, activation } = activatedOverRunning(restored.rows);
    await activation;
    expect(container.execs).toEqual([]);
    container.bootId = restored.container.bootId;
    expect(await box.resolveReadiness()).toEqual({ kind: 'restored' });
    expect(stamps(container)).toBe(0);
    expect(container.starts).toEqual([]);
  });

  test('T9: a fresh boot restores inside its own hook, never adopts the prior boot', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    container.bootId = undefined;
    await box.onStart();
    expect(stamps(container)).toBe(2);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('T9b: after heartbeat detects replacement the request joins the only coordinator', async () => {
    const restored = await stoppedBoxWithService();
    await restored.box.start();
    const { box, container, activation } = activatedOverRunning(restored.rows);
    container.bootId = undefined;
    await activation;
    await box.devboxHeartbeat();
    expect((await box.devboxState()).ready).toBe(false);
    expect(await box.resolveReadiness()).toEqual({ kind: 'repair', incomplete: 'port 3000 never answered' });
    expect(stamps(container)).toBe(1);
    await box.devboxStartup();
    expect(stamps(container)).toBe(1);
  });

  test('T10: the restore witness settles inside start and adoption leaves its clock alone', async () => {
    const seen: [RestoreClockPhase, number][] = [];

    class WitnessBox extends TestBox {
      protected override onRestorePhase(phase: RestoreClockPhase, atMs: number): void {
        seen.push([phase, atMs]);
      }
    }

    const { box } = harness(WitnessBox);
    await box.start();
    const phases = seen.map(([phase]) => phase);
    expect(phases[0]).toBe('opened');
    expect(phases.at(-1)).toBe('settled');
    expect(phases).toContain('attached');
    expect(phases).toContain('bootId');
    const clock = seen.map(([, atMs]) => atMs);
    expect([...clock].sort((a, b) => a - b)).toEqual(clock);
    seen.length = 0;
    await box.start();
    expect(seen).toEqual([]);
  });

  test('an over-budget hook settles unready and late work cannot publish readiness', async () => {
    class BudgetBox extends TestBox {
      protected override get policy(): DevboxPolicy {
        return { ...TEST_POLICY, attachBudgetMs: 10 };
      }
    }

    const { box, container, rows } = harness(BudgetBox);
    const parked = gate();
    container.execGate = parked;
    const start = box.start();
    await parked.reached;
    await start;
    expect(container.initGate).toBeUndefined();
    expect((await box.devboxState()).ready).toBe(false);
    expect(rows.has('devbox:restoration')).toBe(true);
    expect((await box.devboxState()).unready).toContain('[abandoned → replace]');
    expect((await box.checkpointNow('tick')).kind).toBe('failed');
    parked.release();
    await expect(box.resolveReadiness()).rejects.toThrow('no attached work directory');
    expect((await box.devboxState()).ready).toBe(false);
  });

  test('a schedule row naming a callback this class cannot call is dropped at activation', async () => {
    // The sweep runs in the constructor's activation gate, before any event (alarm included);
    // activate as the platform does: storage with rows first, then `new`, no `start()`.
    const storage = fakeStorage();
    // Overdue rows are the shape that re-arms the physical alarm at once.
    const overdue = Date.now() / 1000 - 1;
    scheduleTableOf(storage.handle).push(
      { callback: 'snapshotWorkspaceIfDue', time: overdue },
      { callback: 'devboxIncidents', time: overdue },
    );

    // Mirrors `harness` construction but with the dead row already stored, as an activation
    // wakes into it.
    const state = boxState({
      storage: storage.handle,
      id: TEST_BOX_ID,
      blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> => await closure(),
    });

    new TestBox(state, {});
    // No waiting: the stub runs the gate closure inline and the sweep is synchronous storage I/O,
    // so rows are gone before `new` returns; an `await` inside the sweep must update this test.

    // The probe is membership on `this`, so a callback the class carries —
    // inherited or its own — survives, or the sweep would break a live chain.
    const remaining = scheduleTableOf(storage.handle).map((row) => row.callback);
    expect(remaining).not.toContain('snapshotWorkspaceIfDue');
    expect(remaining).toContain('devboxIncidents');
    expect(FakeSandbox.last?.schedules).toEqual([]);
    expect(FakeSandbox.last?.execs).toEqual([]);
  });
});

describe('every ending is a named state, and no ending rejects into the platform', () => {
  test('a poisoned restore leaves an operable-for-repair box', async () => {
    const harnessed = await stoppedBoxWithService();
    const { box, container, rows } = harnessed;
    container.listening.delete(3000);

    await box.devboxStartup();

    const state = await box.devboxState();
    expect({ restoration: state.restoration, ready: state.ready, unready: state.unready })
      .toEqual({
        restoration: 'repair',
        ready: false,
        unready: 'port 3000 never answered',
      });
    expect(container.exposures).toEqual([]);
    expect((await box.exec('echo fixing')).exitCode).toBe(0);
    expect([...rows.keys()].some((key) => key.startsWith('devbox:incident:'))).toBe(true);
  });

  test('a failure outside the restore is classified on the frame, never a rejection into the platform', async () => {
    // The restore does not classify its own storage failing; the frame must, or the phase stays
    // `restoring` or the activation resets with the reason lost in an unread rejection.
    const { box, container, storage } = await stoppedBoxWithService();
    storage.faultOn('devbox:attach-recovery', new Error('durable storage unreachable'));

    await box.start();

    const state = await box.devboxState();
    expect(state.restoration).toBe('unattached');
    expect(state.unready).toContain('durable storage unreachable');
    expect(container.schedules).toContain('devboxStartup');
  });

  test('an operation is refused, re-armably, when no container was ever admitted', async () => {
    const { box, container } = await stoppedBoxWithService();
    container.containerUnavailable = new Error(
      'there is no container instance that can be provided to this durable object',
    );

    await expect(box.exec('echo hello')).rejects.toMatchObject(
      { message: expect.stringContaining('not ready') });

    // The same refusal as a value, the shape that survives a Durable Object RPC boundary intact.
    expect(await box.resolveReadiness()).toEqual({
      kind: 'pending',
      reason: expect.stringContaining('not ready'),
    });

    const state = await box.devboxState();
    expect(state.restoration).not.toBe('unattached');
    expect(container.schedules).toContain('devboxStartup');
  });
});
