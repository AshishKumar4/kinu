// The restoration runs on the first DELIVERED frame after a container start,
// and this file is what holds that placement to its promises: once per start,
// durable, and admission waits on it.
//
// `Container.onStart` is awaited inside `blockConcurrencyWhile`
// (`@cloudflare/containers`, `container.js:583`), and a Durable Object timer
// set inside that block is not delivered until the block releases. The first
// command on a fresh container opens the SDK's control connection, whose
// connect abort (`@cloudflare/sandbox`, `dist/sandbox-CPj2jsbz.js:3563`,
// `setTimeout` 30 s) and retry backoff (`:812`, `setTimeout` 3 s) are both
// such timers — so a restore inside the hook either hangs to an abort that
// cannot fire or sleeps on a retry that cannot wake, and the platform resets
// the object at its cap. Measured on six fresh container starts (2026-09-10,
// `bench/measure-first/DECISIVE-2026-09-05.md`): one admitted, five reset with
// no phase stamped. The hook therefore reaches no container: it marks the
// restore pending and arms the rows, and the delivered frame does the work.
//
// The proofs here are the ones that keep it:
//
//   T1  the hook asks the container nothing: `start()` settles against a
//       container that never answers a command.
//   T2  the first delivered frame restores, and admission waits on it: the
//       operation runs only after the stamp, the processes and the ports.
//   T3  once per start: a second delivered frame on the same instance adopts
//       — no second stamp, no second process start.
//   T4  a settled restore retires its startup row.
//   T5  a request arriving mid-restore joins the one attempt and is admitted
//       after it settles; one with no join budget is refused re-askably.
//   T6  while restoring the box reports the door that is driving.
//   T7  a re-entered hook is harmless: it issues no command and opens no
//       second restoration.
//   T8  the settled phase is durable: a fresh activation over the running
//       container adopts it on its first delivered frame, asking one `cat`.
//   T9  a start the hook marked over a settled phase is not served: the
//       delivered frame compares the boot id and restores a fresh instance.
//   T10 a witness reads the attempt's clock: opened, the phases in walk order,
//       settled — and an adoption reports its own, shorter, clock.
//
// RED DIRECTION. T1 fails on the in-gate tree: `box.start()` reaches the
// parked exec and holds the gate. T2's ordering fails there too — the stamp
// lands inside `start()`, before any frame is delivered. The file imports only
// harness APIs both trees have, so the same file runs there and goes red for
// the reason each test names.
import { describe, expect, test } from 'bun:test';

import type { RestoreClockPhase } from '../src/devbox';
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

/** A box whose request frames may wait almost no time at all: the join
 *  budget is the one bound a request door has, and this box spends it. */
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

/** A box activated the way the platform activates one over a running
 *  container it already holds rows for, with the activation's own promise so
 *  a test can wait on it rather than on a clock. */
interface Activated {
  readonly box: TestBox;
  readonly container: FakeSandbox;
  readonly activation: Promise<unknown>;
}

/** Storage first with the rows already in it, then `new`, no `start()`. */
function activatedOverRunning(rows: Map<string, StoredValue>): Activated {
  const storage = fakeStorage();

  for (const [key, value] of rows) storage.rows.set(key, value);
  let activation: Promise<unknown> = Promise.resolve();

  // SAFETY: the constructor's contract reads `storage`, `id`, `container` and
  // `blockConcurrencyWhile` off its state and nothing else (devbox.ts
  // constructor + `#activate`); the fake carries those four, and hands the
  // gate's closure back so the test can wait on the activation itself.
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

  return { box, container: FakeSandbox.last!, activation };
}

describe('the restore runs on the first delivered frame after a container start', () => {
  test('T1: the hook asks the container nothing — start() settles against a container that never answers', async () => {
    // THE RED PROOF, and the measured defect it stands for. The control
    // server accepts and never answers: any exec parks for ever. Under the
    // in-gate placement `start()` reaches that exec inside the platform's
    // block and holds it to the 30 s cancel — five of six fresh starts on the
    // deployed bench. Here the hook must settle first.
    const { box, container } = await stoppedBoxWithService();
    const silent = gate();
    container.execGate = silent;

    const outcome = await Promise.race([
      box.start().then(() => 'settled' as const),
      silent.reached.then(() => 'asked the container' as const),
    ]);

    expect({ outcome, execs: container.execs }).toEqual({ outcome: 'settled', execs: [] });
    expect(container.starts).toEqual([]);
    // Nothing settled, nothing served: the box is not ready and says why.
    const state = await box.devboxState();
    expect({ restoration: state.restoration, ready: state.ready })
      .toEqual({ restoration: 'unstarted', ready: false });
  });

  test('T2: the first delivered frame restores, and the operation runs only after it', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    expect(stamps(container)).toBe(0);

    const out = await deliver(container, () => box.exec('echo hi'));

    expect(out.exitCode).toBe(0);
    // The restore ran on this frame, and every step of it landed before the
    // operation's own command. Under the in-gate placement the stamp is
    // already there when `start()` returns.
    expect(stamps(container)).toBe(1);
    const echo = container.execs.findIndex((command) => command.includes('echo hi'));
    const stamp = container.execs.findIndex((command) => command.includes(STAMP_COMMAND));
    expect(stamp).toBeLessThan(echo);
    expect(container.starts).toEqual([
      { command: 'bun run server.ts', cwd: '/workspace', processId: 'p1' },
    ]);
    expect(container.exposures).toEqual([{ port: 3000, token: 'tok3000', name: 'web' }]);
    const state = await box.devboxState();
    expect({ restoration: state.restoration, ready: state.ready }).toEqual({
      restoration: 'attached', ready: true,
    });
  });

  test('T3: once per start — a second delivered frame on the same instance adopts', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    expect((await box.ensureReady()).kind).toBe('restored');
    const stampedOnce = stamps(container);
    const restarts = container.starts.length;

    // The SDK asks for a start again — its own control paths do — and the
    // hook marks the restore pending again. The next frame compares the boot
    // id and adopts: one `cat`, no stamp, no second process.
    await box.start();
    expect((await box.ensureReady()).kind).toBe('restored');

    expect(stamps(container)).toBe(stampedOnce);
    expect(container.starts).toHaveLength(restarts);
    expect(container.execs.at(-1)).toBe('cat /tmp/devbox-boot-id 2>/dev/null || true');
  });

  test('T4: a settled restore retires its startup row', async () => {
    const { box, container } = await stoppedBoxWithService();

    await box.start();
    // The hook armed the row: a box with nothing restored needs a driver in
    // case no request follows.
    expect(armed(container)).toBe(1);

    await box.ensureReady();
    // The attempt that settled retired it: a row firing on an attached box is
    // a wake, a port probe and a boot-id read nobody asked for.
    expect(armed(container)).toBe(0);
  });

  test('T5: a request arriving mid-restore joins the one attempt and is admitted after it', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    const parked = gate();
    container.stampGate = parked;

    const first = box.exec('echo first');
    await parked.reached;
    const second = box.exec('echo second');

    parked.release();
    expect((await first).exitCode).toBe(0);
    expect((await second).exitCode).toBe(0);
    // ONE restoration: a second would have stamped a second boot id and
    // started the same process twice.
    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
  });

  test('T5b: a request with no join budget is refused re-askably, and the attempt keeps running', async () => {
    const harnessed: Harness<ImpatientBox> = harness(ImpatientBox);
    proc(harnessed.rows, 'p1');
    port(harnessed.rows, 3000, 'tok3000');
    harnessed.container.listening.add(3000);
    await harnessed.container.stop();
    const { box, container } = harnessed;
    await box.start();
    const parked = gate();
    container.stampGate = parked;

    const opener = box.devboxStartup();
    await parked.reached;
    // The honest answer: restoring, ask again. Nothing is abandoned.
    await expect(box.exec('echo hi')).rejects.toThrow('not ready');

    parked.release();
    await opener;
    expect((await box.exec('echo hi')).exitCode).toBe(0);
    expect(stamps(container)).toBe(1);
  });

  test('T6: while restoring the box reports the door that is driving', async () => {
    const { box, container } = runningBoxWithService();
    const parked = gate();
    container.stampGate = parked;

    const attempt = box.devboxStartup();
    await parked.reached;

    const during = await box.devboxState();
    expect(during.restoration).toBe('restoring');
    expect(during.unready).toContain('in the schedule');

    parked.release();
    await attempt;
    expect((await box.devboxState()).restoration).toBe('attached');
  });

  test('T7: a re-entered hook issues no command and opens no second restoration', async () => {
    // Measured: the SDK fires this hook from its own control paths on a
    // container that is already up — once 37 ms into a restore's first exec.
    const { box, container } = runningBoxWithService();

    await Promise.all([box.onStart(), box.onStart()]);
    expect(container.execs).toEqual([]);

    const [first, second] = await Promise.all([box.ensureReady(), box.devboxStartup()]);

    expect(first).toEqual({ kind: 'restored' });
    expect(second).toBeUndefined();
    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
    expect(armed(container)).toBe(0);
  });

  test('T8: the settled phase is durable — a fresh activation over the running container adopts it', async () => {
    // THE HANG THIS ALSO REFUSES. A box that restored once, its container
    // still running, and a control server that ACCEPTS the connection and
    // never answers. The activation reads the boot id nowhere near its own
    // gate: it marks the adoption pending, and the first delivered frame
    // asks, where a deadline works.
    const restored = await stoppedBoxWithService();
    await restored.box.start();
    await restored.box.ensureReady();
    expect(restored.rows.get('devbox:restoration')).toEqual({ phase: 'attached' });
    // The stamp landed in the container and its mirror in the rows.
    expect(restored.rows.get('devbox:boot-id')).toBe(restored.container.bootId);

    const { box, container, activation } = activatedOverRunning(restored.rows);
    const silent = gate();
    container.execGate = silent;

    const outcome = await Promise.race([
      activation.then(() => 'settled' as const),
      silent.reached.then(() => 'asked the container' as const),
    ]);

    expect({ outcome, execs: container.execs }).toEqual({ outcome: 'settled', execs: [] });

    container.execGate = undefined;
    container.bootId = restored.container.bootId;
    expect((await box.ensureReady()).kind).toBe('restored');
    expect(container.execs.at(-1)).toBe('cat /tmp/devbox-boot-id 2>/dev/null || true');
    expect(stamps(container)).toBe(0);
  });

  test('T9: a start marked over a settled phase is not served — the frame compares the boot id and restores', async () => {
    // The container was stopped and started again under this live object —
    // the SDK's own paths do that — and memory still says `attached` for an
    // instance that is gone. The hook could only mark; the delivered frame
    // asks, finds no boot id, and restores the fresh instance rather than
    // admitting a caller onto a bare work directory.
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    await box.ensureReady();
    expect((await box.devboxState()).restoration).toBe('attached');
    const stampedOnce = stamps(container);

    container.bootId = undefined;
    await box.onStart();
    const admitted = await box.ensureReady();

    expect(admitted.kind).toBe('restored');
    expect(stamps(container)).toBe(stampedOnce + 1);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('T9b: a pending adoption whose container was replaced is caught by the beat, not served', async () => {
    const restored = await stoppedBoxWithService();
    await restored.box.start();
    await restored.box.ensureReady();
    const { box, container, activation } = activatedOverRunning(restored.rows);
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

  test('T10: a witness reads the attempt\'s clock — opened, the phases in walk order, settled', async () => {
    // The bench fixture keeps these durably as they land, so an attempt the
    // platform resets still names its last phase. A fresh box mounts no store
    // and no base, so those two are absent — not zero. The harness storage
    // attaches with no container command, so `containerStart` lands on the
    // first exec after it here; on the shipped chain it is the attach's own
    // mount probe.
    const seen: [RestoreClockPhase, number][] = [];

    class WitnessBox extends TestBox {
      protected override onRestorePhase(phase: RestoreClockPhase, atMs: number): void {
        seen.push([phase, atMs]);
      }
    }

    const harnessed: Harness<WitnessBox> = harness(WitnessBox);
    proc(harnessed.rows, 'p1');
    harnessed.container.listening.add(3000);
    await harnessed.container.stop();

    await harnessed.box.start();
    expect(seen).toEqual([]);
    await harnessed.box.ensureReady();

    const phases = seen.map(([phase]) => phase);
    expect(phases[0]).toBe('opened');
    expect(phases.at(-1)).toBe('settled');
    expect(phases.slice(1, -1).sort()).toEqual(['attached', 'bootId', 'containerStart']);
    expect(phases.indexOf('attached')).toBeLessThan(phases.indexOf('bootId'));
    const clock = seen.map(([, atMs]) => atMs);
    expect(clock[0]).toBe(0);
    expect([...clock].sort((a, b) => a - b)).toEqual(clock);

    // A second start on the same instance adopts, on a clock of its own: the
    // identity is settled by the read, and nothing else lands.
    seen.length = 0;
    await harnessed.box.start();
    await harnessed.box.ensureReady();
    expect(seen.map(([phase]) => phase)).toEqual(['opened', 'containerStart', 'bootId', 'settled']);
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
    // The attempt's own storage failing is the one failure the restore does
    // not classify itself. The frame leaves the box refusing WITH A REASON
    // and a successor armed, and the cause travels to whoever asked — never
    // a phase left `restoring` for ever, never an activation dying into a
    // reset with the reason held only in a rejection nobody reads.
    const { box, container, storage } = await stoppedBoxWithService();
    await box.start();
    storage.faultOn('devbox:attach-recovery', new Error('durable storage unreachable'));

    await expect(box.ensureReady()).rejects.toThrow('durable storage unreachable');

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
