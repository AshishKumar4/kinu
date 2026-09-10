// The restoration runs INSIDE the container-start hook, and this file is what
// holds that placement to its promises.
//
// `Container.onStart` is awaited inside `blockConcurrencyWhile`
// (`@cloudflare/containers`, `container.js:583` for `start()` and `:632-636`
// for `startAndWaitForPorts`), so the platform delivers no request until the
// hook settles. The box is admitted only through `startAndWaitForPorts`, which
// calls `setHealthy()` BEFORE the hook (`:634-635`) — so a command the restore
// issues routes straight to the container instead of opening a nested start.
// That ordering is the whole mechanism, and it is the SDK's own documented
// expectation for work issued from inside `onStart` (`@cloudflare/sandbox`,
// `dist/sandbox-CPj2jsbz.js:1019-1029`).
//
// The proofs here are the ones that keep it:
//
//   T1  the hook restores: after the admitted start returns, the box is
//       attached and ready, with the boot stamp written.
//   T2  a settled restore retires its startup row: nothing wakes the box again.
//   T3  a re-entered hook joins the running restore in memory: one stamp, one
//       process start, however many entries.
//   T4  a request delivered after the gate observes the restored box, and
//       restores nothing further.
//   T5  a request arriving mid-gate-restore waits it out: the platform holds
//       every frame behind the hook, so there is no ask-again for it to answer.
//   T6  while the gate is held the box reports which door is driving: `start`.
//   T7  adoption: a second start on the same instance restores nothing; a
//       container the box never restored is restored, not served.
//
// RED DIRECTION. Every T-test above fails on the out-of-gate tree, where the
// hook only arms the schedule rows: no exec runs inside the block, no stamp
// lands, and a delivered request is the one that restores. The file imports
// only harness APIs that tree already has — `harness`, `gate`, `deliver`,
// `STAMP_COMMAND` — so the same file runs there and goes red for the reason
// each test names.
import { describe, expect, test } from 'bun:test';

import type { StoredValue } from '../src/storage';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import {
  Devbox, FakeSandbox, STAMP_COMMAND, TEST_BOX_ID, deliver, fakeStorage, gate, harness,
  scheduleTableOf, type Harness,
} from './support/devbox-harness';

/** Test-length probes. The listener proof is one container command whose loop
 *  the container itself bounds, so a short window here is a short command
 *  rather than a short timer. */
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

/** A box whose request frames may wait almost no time at all. Under the old
 *  law every such frame answered ask-again; under the gate the platform holds
 *  it until the restore settles, so even this box waits it out. */
class ImpatientBox extends TestBox {
  protected override get policy(): DevboxPolicy {
    return { ...TEST_POLICY, requestJoinMs: 1 };
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

/** One box with a service to restore, its container stopped so the next start
 *  really runs the container-start hook. */
async function stoppedBoxWithService(): Promise<Harness<TestBox>> {
  const harnessed: Harness<TestBox> = harness(TestBox);
  proc(harnessed.rows, 'p1');
  port(harnessed.rows, 3000, 'tok3000');
  harnessed.container.listening.add(3000);
  await harnessed.container.stop();
  return harnessed;
}

/** One box with a service to restore on a RUNNING container: the replacement
 *  the heartbeat spotted, or the wake the platform delivered. */
function runningBoxWithService(): Harness<TestBox> {
  const harnessed: Harness<TestBox> = harness(TestBox);
  proc(harnessed.rows, 'p1');
  port(harnessed.rows, 3000, 'tok3000');
  harnessed.container.listening.add(3000);
  return harnessed;
}

describe('the container-start hook restores the box', () => {
  test('T1: the admitted start restores in-gate, and the box is ready when it returns', async () => {
    const { box, container } = await stoppedBoxWithService();

    await box.start();

    // The restore ran INSIDE the block: the boot stamp landed before the start
    // returned. Under the refuted placement this list is empty — the hook
    // armed rows and the restore waited for a delivered frame.
    expect(container.execs.some((command) => command.includes(STAMP_COMMAND))).toBe(true);
    expect(container.starts).toEqual([
      { command: 'bun run server.ts', cwd: '/workspace', processId: 'p1' },
    ]);
    expect(container.exposures).toEqual([{ port: 3000, token: 'tok3000', name: 'web' }]);
    const state = await box.devboxState();
    expect({ restoration: state.restoration, ready: state.ready }).toEqual({
      restoration: 'attached', ready: true,
    });
  });

  test('T2: a settled restore retires its startup row', async () => {
    const { box, container } = await stoppedBoxWithService();

    await box.start();

    // The arm runs on every start, so without this a settled box wakes once a
    // second for a port probe and a boot-id read nobody asked for. Under the
    // refuted placement the row survives: nothing settled it.
    expect(armed(container)).toBe(0);
  });

  test('T3: a re-entered hook joins the running restore in memory', async () => {
    // Measured: the SDK fires this hook from its own control paths on a
    // container that is already up — once 37 ms into a restore's first exec.
    // A re-entered hook must join the running restore with no I/O at all,
    // never open a second one.
    const { box, container } = runningBoxWithService();

    await Promise.all([box.onStart(), box.onStart()]);

    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
    expect((await box.devboxState()).restoration).toBe('attached');
    expect(armed(container)).toBe(0);
  });

  test('T4: a request delivered after the gate observes the restored box', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    const stamped = stamps(container);

    // Delivered the way the platform delivers it: not before the gate opens.
    const out = await deliver(container, () => box.exec('echo hi'));

    expect(out.exitCode).toBe(0);
    // And it restored nothing: the gate already did. Under the refuted
    // placement this request is the one that restores, so the stamp lands here.
    expect(stamps(container)).toBe(stamped);
    expect((await box.devboxState()).restoration).toBe('attached');
  });

  test('T5: a request arriving mid-gate-restore waits it out, even with no join budget', async () => {
    // THE LAW THAT CHANGED WITH THE PLACEMENT. A request racing a DELIVERED
    // attempt joins it for `requestJoinMs` and then answers ask-again. A
    // request arriving while the hook holds the platform gate never reaches
    // that question: the platform holds it until the restore settles, so it
    // observes only the restored box — with a 1 ms budget or any other.
    const harnessed: Harness<ImpatientBox> = harness(ImpatientBox);
    proc(harnessed.rows, 'p1');
    port(harnessed.rows, 3000, 'tok3000');
    harnessed.container.listening.add(3000);
    await harnessed.container.stop();
    const { box, container } = harnessed;
    const parked = gate();
    container.stampGate = parked;

    const restoring = box.start();
    await parked.reached;
    const answered = box.exec('echo hi');

    parked.release();
    await restoring;
    expect((await answered).exitCode).toBe(0);
    expect(stamps(container)).toBe(1);
  });

  test('T6: while the gate is held the box reports the start door is driving', async () => {
    const { box, container } = runningBoxWithService();
    const parked = gate();
    container.stampGate = parked;

    const attempt = box.devboxStartup();
    await parked.reached;

    const during = await box.devboxState();
    expect(during.restoration).toBe('restoring');
    // The admission ran the hook, so the hook's restore is the one parked —
    // and the schedule drive behind it is still in admission, not driving.
    // Under the refuted placement this names the schedule door.
    expect(during.unready).toContain('in the start');

    parked.release();
    await attempt;
    expect((await box.devboxState()).restoration).toBe('attached');
  });

  test('T7: a second start on the same instance adopts instead of restoring', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    expect((await box.devboxState()).restoration).toBe('attached');
    const stampedOnce = stamps(container);
    const restarts = container.starts.length;

    await box.start();

    expect(stamps(container)).toBe(stampedOnce);
    expect(container.starts).toHaveLength(restarts);
    expect((await box.devboxState()).restoration).toBe('attached');
  });

  test('a box looking at a container it never restored restores it', async () => {
    // The other half of adoption: the durable claim proves the instance, so a
    // container that answers with another id — or none — is a restoration this
    // box has not done, and the drive runs it rather than serving a world that
    // is gone.
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    expect((await box.devboxState()).restoration).toBe('attached');
    const stampedOnce = stamps(container);

    // A fresh instance: the boot marker is gone and nothing told the object.
    container.bootId = undefined;
    await box.devboxStartup();

    expect(stamps(container)).toBeGreaterThan(stampedOnce);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('both delivered doors at once open ONE restoration', async () => {
    const { box, container } = runningBoxWithService();

    const [first, second] = await Promise.all([box.ensureReady(), box.devboxStartup()]);

    expect(first).toEqual({ kind: 'restored' });
    // One restoration: a second would have stamped a second boot id and
    // started the same process twice.
    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
    expect((await box.devboxState()).restoration).toBe('attached');
    expect(second).toBeUndefined();
  });

  test('a schedule row naming a callback this class cannot call is dropped at activation', async () => {
    // MEASURED IN PRODUCTION LOGS (build 6d19d50e7): `Callback
    // snapshotWorkspaceIfDue not found or is not a function`, twice a second
    // per sandbox object, with the alarm re-arming for ever. The sweep runs in
    // the constructor's activation gate, which settles before the runtime
    // delivers any event, alarm included; the test activates the way the
    // platform does: storage first with the rows already in it, then `new`,
    // then no `start()` at all.
    const storage = fakeStorage();
    // Overdue: the shape that re-arms the physical alarm at once and spins the
    // twice-a-second loop.
    const overdue = Date.now() / 1000 - 1;
    scheduleTableOf(storage.handle).push(
      { callback: 'snapshotWorkspaceIfDue', time: overdue },
      { callback: 'devboxIncidents', time: overdue },
    );
    // Built the way `harness` builds it — the same members the class reads at
    // construction — but with the dead row already present, which is what an
    // activation wakes into.
    // SAFETY: the constructor's contract reads `storage`, `id` and
    // `blockConcurrencyWhile` off its state and nothing else (devbox.ts
    // constructor + `#activate`); the fake is constructed with exactly those
    // three members.
    const state = {
      storage: storage.handle,
      id: { toString: () => TEST_BOX_ID },
      blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> => await closure(),
    } as ConstructorParameters<typeof Devbox>[0];
    new TestBox(state, {});
    // No waiting: this stub runs the gate closure inline inside `new`, and the
    // sweep body is synchronous storage I/O, so the rows are gone before `new`
    // returns. An `await` added inside the sweep must update this test.

    // The probe is membership on `this`, so a callback the class carries —
    // inherited or its own — survives, or the sweep would break a live chain.
    const remaining = scheduleTableOf(storage.handle).map((row) => row.callback);
    expect(remaining).not.toContain('snapshotWorkspaceIfDue');
    expect(remaining).toContain('devboxIncidents');
    // And the box never left activation: nothing armed, nothing ran.
    expect(FakeSandbox.last?.schedules).toEqual([]);
    expect(FakeSandbox.last?.execs).toEqual([]);
  });

  test('an activation over a running container asks it nothing; the first delivered frame does', async () => {
    // THE HANG THIS REFUSES. A box that restored once, its container still
    // running, and a control server that ACCEPTS the connection and never
    // answers. The activation used to read the boot id inside the
    // constructor's gate, where no timer is delivered: the exec hung, the
    // platform cancelled the gate and reset the object, and the next
    // activation repeated it — no request, no alarm, no stop, no destroy,
    // until the container process died. A server that refuses outright is
    // the counterexample: the exec rejects and the gate opens.
    const storage = fakeStorage();
    storage.rows.set('devbox:boot-id', 'instance-a');
    storage.rows.set('devbox:restoration', { phase: 'attached' });
    let activation: Promise<unknown> = Promise.resolve();
    // SAFETY: the constructor's contract reads `storage`, `id`, `container`
    // and `blockConcurrencyWhile` off its state; the fake carries those four,
    // and hands the gate's closure back so the test can wait on the activation
    // itself rather than on a clock.
    const state = {
      storage: storage.handle,
      id: { toString: () => TEST_BOX_ID },
      container: { running: true },
      blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> => {
        const run = closure();
        activation = run;
        return await run;
      },
    } as ConstructorParameters<typeof Devbox>[0];
    const box = new TestBox(state, {});
    const container = FakeSandbox.last!;
    // The control server accepts and never answers: any exec parks for ever.
    const silent = gate();
    container.execGate = silent;
    // Either the activation settles, or it reaches the parked exec and would
    // hold the platform's gate to its cancel: the old shape, and the red.
    const outcome = await Promise.race([
      activation.then(() => 'settled' as const),
      silent.reached.then(() => 'asked the container' as const),
    ]);
    expect({ outcome, execs: container.execs }).toEqual({ outcome: 'settled', execs: [] });

    // THE FIRST DELIVERED FRAME asks the question, where a deadline works: the
    // server now answers, the boot id matches, and the box is adopted, not
    // restored — one `cat`, no stamp.
    container.execGate = undefined;
    container.bootId = 'instance-a';
    expect((await box.ensureReady()).kind).toBe('restored');
    expect(container.execs.at(-1)).toBe('cat /tmp/devbox-boot-id 2>/dev/null || true');
    expect(stamps(container)).toBe(0);
  });

  test('a pending adoption whose container was replaced is caught by the beat, not served', async () => {
    const storage = fakeStorage();
    storage.rows.set('devbox:boot-id', 'instance-a');
    storage.rows.set('devbox:restoration', { phase: 'attached' });
    let activation: Promise<unknown> = Promise.resolve();
    // SAFETY: the constructor's contract reads `storage`, `id`, `container`
    // and `blockConcurrencyWhile` off its state and nothing else (devbox.ts
    // constructor + `#activate`); the fake is constructed with exactly those
    // four members.
    const state = {
      storage: storage.handle,
      id: { toString: () => TEST_BOX_ID },
      container: { running: true },
      blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> => {
        const run = closure();
        activation = run;
        return await run;
      },
    } as ConstructorParameters<typeof Devbox>[0];
    const box = new TestBox(state, {});
    const container = FakeSandbox.last!;
    container.bootId = undefined;
    await activation;

    await box.devboxHeartbeat();

    // The beat resolved the adoption first: the rows named an instance the
    // container does not carry, so nothing was adopted — the box is not served
    // as attached, and no quiesce was decided over it. The request door then
    // restores the instance nobody restored: one fresh stamp.
    const beaten = await box.devboxState();
    expect({ restoration: beaten.restoration, decision: beaten.lastTick?.decision })
      .toEqual({ restoration: 'unstarted', decision: 'hold' });
    await box.ensureReady();
    expect(stamps(container)).toBe(1);
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

  test('a failure outside the restore parks the gate instead of rejecting', async () => {
    // Destructive recovery needs timers the gate does not deliver, so an
    // in-gate failure records its reason, arms one successor, and returns: the
    // delivered frame continues with the full machinery. What must never
    // happen is the old shape — the activation dying into a reset with the
    // reason held only in a rejection nobody reads.
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

    await expect(box.exec('echo hello')).rejects.toThrow('not ready');

    const state = await box.devboxState();
    expect(state.restoration).not.toBe('unattached');
    expect(container.schedules).toContain('devboxStartup');
  });
});
