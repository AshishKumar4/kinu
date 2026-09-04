// The restoration runs on a DELIVERED FRAME, never inside the container-start
// hook, and this file is what holds that placement to its promises.
//
// WHY IT MOVED BACK OUT. `Container.onStart` is awaited inside
// `blockConcurrencyWhile` (`@cloudflare/containers`, `container.js:583` and
// `:632-636`), and a restore that ran there looked strictly stronger than an
// in-isolate join: the runtime delivers no event to the object while the block
// is held, so nothing could observe a half-restored box. Deployed probe
// `gp0902011918` refuted it — the FIRST container command issued inside the
// block never returned:
//
//   01:29:51.520  onStart entry gen=1
//   01:29:51.574  the three schedule rows written (+54 ms)
//   01:29:51.574  exec issued: `cat /proc/mounts`
//   01:29:51.611  onStart entry gen=2      <- the SDK re-entered the hook
//   ...no exec ever returned... then: blockConcurrencyWhile canceled, the
//                                     Durable Object was reset
//
// Reaching the container asks the SDK for a NESTED `blockConcurrencyWhile`
// (`@cloudflare/sandbox`, `dist/sandbox-CPj2jsbz.js:3556, 8831, 8688-8702`),
// which cannot be granted while the outer one is held, so the activation runs to
// the cap `do.block_concurrency.cancel_ms` names and the object is reset. The
// proofs here are the ones that keep the defect out:
//
//   T1  the hook carries no container work: a command nothing will answer must
//       not hold the block, and `exec` must not be called inside it at all.
//   T2  a counted-loop command's own duration does not extend the block.
//   T3  the post-reset activation restores: the SDK sees a running, healthy
//       container and never calls the hook again, so BOTH doors — the armed
//       `devboxStartup` row and a readiness request — must open the attempt, and
//       two doors at once must open exactly one.
import { describe, expect, test } from 'bun:test';

import type { StoredValue } from '../src/storage';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import {
  Devbox, FakeSandbox, STAMP_COMMAND, TEST_BOX_ID, fakeStorage, gate, harness,
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

/** One box with a service to restore, its container stopped so the next `start`
 *  really runs the container-start hook. */
async function stoppedBoxWithService(): Promise<Harness<TestBox>> {
  const harnessed: Harness<TestBox> = harness(TestBox);
  proc(harnessed.rows, 'p1');
  port(harnessed.rows, 3000, 'tok3000');
  harnessed.container.listening.add(3000);
  await harnessed.container.stop();
  return harnessed;
}

/** A box on a RUNNING, healthy container whose memory holds no restoration —
 *  the post-reset activation, exactly. The platform reset the object while its
 *  restore held the block; the container survived, the SDK's durable status
 *  still says healthy, so the SDK will never call the start hook again. */
function postResetBox(): Harness<TestBox> {
  const harnessed: Harness<TestBox> = harness(TestBox);
  proc(harnessed.rows, 'p1');
  port(harnessed.rows, 3000, 'tok3000');
  harnessed.container.listening.add(3000);
  harnessed.container.providerStatus = 'healthy';
  return harnessed;
}

describe('the container-start hook carries no container work', () => {
  test('T1: a command nothing will answer does not hold the block, and none is issued in it', async () => {
    const { box, container } = await stoppedBoxWithService();
    // The next command parks for ever. Under the refuted design the hook issued
    // one, so the block stayed open on it until the runtime reset the object.
    const withheld = gate();
    container.execGate = withheld;

    // The hook settles on its own, while the command is still withheld. Under
    // the refuted design this await never returns: the block holds the command,
    // the command waits for the block, and the runtime resets the object at
    // `do.block_concurrency.cancel_ms`.
    await box.start();
    expect(container.execs).toEqual([]);
    // And what it DID do: the durable chains, and nothing else. The checkpoint
    // row is armed because this box keeps ambient checkpoints.
    expect(container.schedules).toEqual([
      'devboxStartup', 'devboxCheckpoint', 'devboxHeartbeat',
    ]);
  });

  test('T2: a counted-loop command\'s own duration does not extend the block', async () => {
    const { box, container } = await stoppedBoxWithService();
    // Every command waits inside the container, the way a layer probe or a
    // listener proof does. The hook must not be charged for any of it.
    container.execDelayMs = 60;

    const openedAt = Date.now();
    await box.start();
    const heldMs = Date.now() - openedAt;

    expect(container.execs).toEqual([]);
    expect(heldMs).toBeLessThan(container.execDelayMs);
    // The restore still happens, on its own frame, and it does run commands.
    await box.devboxStartup();
    expect(container.execs.length).toBeGreaterThan(0);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('the hook is idempotent, because the SDK re-enters it on a container that is already up', async () => {
    // Measured: the SDK called `onStart` again 37 ms into the first exec of a
    // restore. So a second entry must fence nothing and cost nothing — no
    // second restoration, no re-armed row on a settled box.
    const { box, container } = await stoppedBoxWithService();
    await box.devboxStartup();
    expect((await box.devboxState()).ready).toBe(true);
    const armedBefore = container.schedules.length;
    const stampedBefore = stamps(container);

    await box.start();

    expect(stamps(container)).toBe(stampedBefore);
    // A settled box arms no startup row: `kickStartup` owns that question, so
    // the chain ends instead of waking the box every second.
    expect(container.schedules.length).toBe(armedBefore);
    expect((await box.devboxState()).restoration).toBe('attached');
  });

  test('a schedule row naming a callback this class cannot call is dropped at activation, with no container start', async () => {
    // MEASURED IN PRODUCTION LOGS (build 6d19d50e7): `Callback
    // snapshotWorkspaceIfDue not found or is not a function`, twice a second
    // per sandbox object, with the alarm re-arming for ever. The sweep used to
    // run in the container-start hook, but the SDK fires that hook from
    // `start()` (`@cloudflare/containers`, `container.js:583`) — never on a
    // wake whose container is asleep — while the alarm loop still runs
    // (`container.js:1502-1535`). So the sweep runs in the constructor's
    // activation gate instead, and this test activates the way the platform
    // does: storage first with the rows already in it, then `new`, then no
    // `start()` at all.
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
    // constructor + `#sweepUnknownSchedules`); the fake is constructed with
    // exactly those three members.
    const state = {
      storage: storage.handle,
      id: { toString: () => TEST_BOX_ID },
      blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> => await closure(),
    } as ConstructorParameters<typeof Devbox>[0];
    const box = new TestBox(state, {});
    expect(box).toBeInstanceOf(TestBox);
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

describe('T3: the post-reset activation restores through either door, and only once', () => {
  test('the request door restores a running, healthy container whose memory holds none', async () => {
    const { box, container } = postResetBox();

    const admitted = await box.ensureReady();

    expect(admitted).toEqual({ kind: 'restored' });
    expect(stamps(container)).toBe(1);
    expect(container.starts).toEqual([
      { command: 'bun run server.ts', cwd: '/workspace', processId: 'p1' },
    ]);
    expect(container.exposures).toEqual([{ port: 3000, token: 'tok3000', name: 'web' }]);
  });

  test('the alarm door restores the same activation', async () => {
    const { box, container } = postResetBox();

    await box.devboxStartup();

    expect((await box.devboxState()).ready).toBe(true);
    expect(stamps(container)).toBe(1);
  });

  test('both doors at once open ONE attempt', async () => {
    const { box, container } = postResetBox();

    const request = box.ensureReady();
    const alarm = box.devboxStartup();
    await Promise.all([request, alarm]);

    // One restoration: a second would have stamped a second boot id and started
    // the same process twice.
    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
    expect((await box.devboxState()).restoration).toBe('attached');
  });

  test('a box that claims `attached` on a container it never restored restores it', async () => {
    // The other half of the door's question, and the reason the start hook does
    // NOT turn the generation over any more: the hook cannot tell a fresh
    // instance from a probe of the one it is already on, and the boot id can.
    const { box, container } = postResetBox();
    await box.devboxStartup();
    expect((await box.devboxState()).restoration).toBe('attached');
    const stampedOnce = stamps(container);

    // A fresh instance: the ephemeral marker is gone and nothing told the object.
    container.bootId = undefined;
    await box.devboxStartup();

    expect(stamps(container)).toBeGreaterThan(stampedOnce);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('a settled box the boot id still names is left alone', async () => {
    const { box, container } = postResetBox();
    await box.devboxStartup();
    const stampedOnce = stamps(container);
    const restarts = container.starts.length;

    await box.devboxStartup();

    expect(stamps(container)).toBe(stampedOnce);
    expect(container.starts).toHaveLength(restarts);
  });
});

/** A box whose request frames may wait almost no time at all, so the join
 *  budget is reached deterministically rather than by racing a real clock. */
class ImpatientBox extends TestBox {
  protected override get policy(): DevboxPolicy {
    return { ...TEST_POLICY, requestJoinMs: 1 };
  }
}

describe('T4/T5: a request joins the one attempt, and is never held hostage to it', () => {
  test('T4: a request arriving mid-attempt answers ask-again rather than waiting it out', async () => {
    // THE SAME LAW AS THE INIT GATE, on the other kind of frame. The attempt is
    // parked at its last phase, so it cannot settle inside the request's budget;
    // the request must answer from the restoration's state instead of holding
    // the connection open for the whole restore.
    const harnessed: Harness<ImpatientBox> = harness(ImpatientBox);
    proc(harnessed.rows, 'p1');
    port(harnessed.rows, 3000, 'tok3000');
    harnessed.container.listening.add(3000);
    const { box, container } = harnessed;
    const parked = gate();
    container.stampGate = parked;

    // The alarm door opens the attempt and drives it to completion; it is not
    // awaited here, because the point is what a REQUEST sees meanwhile.
    const driven = box.devboxStartup();
    await parked.reached;

    await expect(box.exec('echo hello')).rejects.toThrow('ask again');
    const during = await box.devboxState();
    expect(during.restoration).toBe('restoring');
    expect(during.unready).toContain('a restoration has been running in the');

    // And the attempt the request left running is the one that settles.
    parked.release();
    await driven;
    expect((await box.devboxState()).ready).toBe(true);
    expect(stamps(container)).toBe(1);
  });

  test('T5: the first request opens exactly one attempt and a second joins it', async () => {
    const { box, container } = postResetBox();

    const [first, second] = await Promise.all([box.ensureReady(), box.ensureReady()]);

    expect(first).toEqual({ kind: 'restored' });
    expect(second).toEqual({ kind: 'restored' });
    // ONE attempt: a second would have stamped a second boot id and started the
    // same process twice.
    expect(stamps(container)).toBe(1);
    expect(container.starts).toHaveLength(1);
  });

  test('T4b: a CHECKPOINT arriving mid-attempt is bounded by the same law', async () => {
    // THE DEPLOYED DEFECT. `#checkpoint` awaited the in-flight startup attempt
    // with no bound at all — `await pending.run` — inside both the checkpoint
    // lane and the storage-mutation FIFO. So a restoration that ran long held
    // every later checkpoint behind it, and the armed operation row stayed
    // `pending` while the box answered every other segment with `a restoration
    // has been running in the request for N ms`. That is run 20260903140046's
    // overlay-cas arm exactly: its first decisive `npm` checkpoint never
    // settled inside the 1,500,000 ms operation deadline, and every segment
    // after it was refused with that sentence until the runner died.
    //
    // A checkpoint is a REQUEST, and the law T4 states for `exec` is the law
    // for it too: join the attempt, wait only the request's own budget, then
    // answer from the restoration's state. Nothing is abandoned — the attempt
    // keeps running under the single-flight entry — and the caller gets a
    // re-askable refusal instead of an unbounded hold.
    const harnessed: Harness<ImpatientBox> = harness(ImpatientBox);
    proc(harnessed.rows, 'p1');
    port(harnessed.rows, 3000, 'tok3000');
    harnessed.container.listening.add(3000);
    const { box, container } = harnessed;
    const parked = gate();
    container.stampGate = parked;

    const driven = box.devboxStartup();
    await parked.reached;

    // The checkpoint must not wait out the parked attempt.
    const settled = await box.checkpointNow('tick');
    expect(settled.kind).toBe('failed');
    expect(settled.reason).toContain('ask again');

    parked.release();
    await driven;
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('the alarm door drives the attempt to completion, budget or no budget', async () => {
    // The other half of the ruling: the schedule frame holds no caller, so it
    // waits for the whole restoration. A box nobody is asking about has no other
    // driver.
    const harnessed: Harness<ImpatientBox> = harness(ImpatientBox);
    proc(harnessed.rows, 'p1');
    port(harnessed.rows, 3000, 'tok3000');
    harnessed.container.listening.add(3000);

    await harnessed.box.devboxStartup();

    expect((await harnessed.box.devboxState()).ready).toBe(true);
    expect(stamps(harnessed.container)).toBe(1);
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

  test('a failure outside the restore leaves a reason rather than a rejection', async () => {
    const { box, storage } = await stoppedBoxWithService();
    storage.faultOn('devbox:attach-recovery', new Error('durable storage unreachable'));

    await expect(box.devboxStartup()).rejects.toThrow('durable storage unreachable');

    const state = await box.devboxState();
    expect(state.restoration).toBe('unattached');
    expect(state.unready).toContain('durable storage unreachable');
  });

  test('a box mid-restoration says which door is driving it', async () => {
    const { box, container } = await stoppedBoxWithService();
    const parked = gate();
    container.stampGate = parked;

    const attempt = box.devboxStartup();
    await parked.reached;

    const during = await box.devboxState();
    expect(during.restoration).toBe('restoring');
    expect(during.unready).toContain('a restoration has been running in the schedule');
    expect(during.ready).toBe(false);

    parked.release();
    await attempt;
    expect((await box.devboxState()).restoration).toBe('attached');
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
