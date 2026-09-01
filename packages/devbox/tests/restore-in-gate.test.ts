// The restoration runs INSIDE the activation that owns the container, and this
// file is what holds that placement to its three promises.
//
// WHY THE PLACEMENT AT ALL. Every operation used to pass through
// `ensureReady()`, an in-isolate join: a caller that raced ahead of the
// scheduled restoration waited on a promise this class held. That works, and it
// is strictly weaker than what the platform already offers. `Container.onStart`
// is awaited inside `blockConcurrencyWhile` (`@cloudflare/containers`,
// `container.js`), and while that block is held the runtime delivers NO event to
// the object — so a restore that happens there cannot be observed half-done by
// anything, for a reason no promise can be lost or mis-joined to.
//
// WHAT THAT COSTS, AND WHAT PAYS FOR IT. The block is cancelled at
// `do.block_concurrency.cancel_ms` by RESETTING the object, and a timer set
// inside it is not delivered until it releases — so the bound cannot be a timer.
// It is a POLLED budget: consulted before each phase and before each container
// command, so a restore that cannot finish COMPLETES THE ACTIVATION with a
// classified reason instead of holding the gate until the runtime intervenes.
//
// THE THREE PROMISES, one describe block each:
//
//   1. Gate-time: nothing is admitted into a half-restored world. Proven by
//      delivering an operation DURING each phase and pinning what it observes.
//   2. Idempotent: the hook fires at least once per container start and again on
//      every replacement, so running it twice must cost one attach probe and
//      change nothing.
//   3. Bounded: every ending is a NAMED state and the activation completes —
//      never a wedged gate, and never a rejection into the platform's own block.
//
// The harness models the init gate where the SDK opens it, and `deliver()` is
// the only honest way to say "this request arrived during the restore": it
// issues the work then and lets the platform's own gate decide when it runs.
import { describe, expect, test } from 'bun:test';

import type { StoredValue } from '../src/storage';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import {
  Devbox, FakeSandbox, STAMP_COMMAND, deliver, gate, harness,
  type Gate, type Harness,
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

/** A box whose whole restore budget is already spent by the time the gate opens.
 *  Zero, not small: the budget is polled, so zero is the honest expression of
 *  "there is no time left for another container command" and it needs no sleep
 *  to reach. */
class SpentBudgetBox extends TestBox {
  protected override get policy(): DevboxPolicy {
    return { ...TEST_POLICY, attachBudgetMs: 0 };
  }
}

/** A durable process spec, as `startSupervised` would have left one. */
function proc(rows: Map<string, StoredValue>, processId: string): void {
  rows.set(`devbox:proc:${processId}`, {
    processId, command: 'bun run server.ts', cwd: '/workspace', createdAt: 1,
  });
}

function port(rows: Map<string, StoredValue>, value: number, token: string): void {
  rows.set(`devbox:port:${value}`, { port: value, name: 'web', token, createdAt: 1 });
}

/** One box with a service to restore, its container stopped so the next `start`
 *  really runs the container-start hook. */
async function stoppedBoxWithService(
  Box: typeof TestBox = TestBox,
): Promise<Harness<TestBox>> {
  const harnessed: Harness<TestBox> = harness(Box);
  proc(harnessed.rows, 'p1');
  port(harnessed.rows, 3000, 'tok3000');
  harnessed.container.listening.add(3000);
  await harnessed.container.stop();
  return harnessed;
}

const stamps = (container: FakeSandbox): number =>
  container.execs.filter((command) => command.includes(STAMP_COMMAND)).length;

/** Every command the container was asked to run, in order, as a readable
 *  sequence. The restore's own commands and a caller's arrive on one channel, so
 *  ORDER across them is the property — which is exactly what a half-restored
 *  world would violate. */
const commands = (container: FakeSandbox): string[] =>
  container.execs.map((command) => {
    if (command.includes(STAMP_COMMAND)) return 'restore:stamp-boot-id';
    if (command.includes('127.0.0.1:3000')) return 'restore:await-listener';
    return `caller:${command}`;
  });

describe('the activation restores the box, and nothing is admitted into a half-restored world', () => {
  test('an operation issued DURING the restore observes only the finished world', async () => {
    const { box, container, rows } = await stoppedBoxWithService();
    void rows;

    // The activation begins. Not awaited: the point is to issue an operation
    // while it is still running.
    const activation = box.start();
    expect(container.initGate).toBeDefined();

    let observedDuring: string | undefined;
    const operation = deliver(container, async () => {
      // What the caller sees the moment it is let in. `restoration` is read
      // through the public report, which is what a host would poll.
      observedDuring = (await box.devboxState()).restoration;
      return await box.exec('echo hello');
    });

    await activation;
    await operation;

    // THE WHOLE CLAIM, in two assertions. The caller was admitted into a
    // SETTLED world — never `restoring`, never `unstarted` — and every command
    // the restore issues precedes the caller's own.
    expect(observedDuring).toBe('attached');
    expect(commands(container)).toEqual([
      'restore:await-listener',
      'restore:stamp-boot-id',
      'caller:echo hello',
    ]);
    // And the service really came back before the caller arrived: the process
    // was started and its port exposed under the token its URL was built on.
    expect(container.starts).toEqual([
      { command: 'bun run server.ts', cwd: '/workspace', processId: 'p1' },
    ]);
    expect(container.exposures).toEqual([
      { port: 3000, token: 'tok3000', name: 'web' },
    ]);
  });

  test.each([
    ['the process restart', (container: FakeSandbox, held: Gate) => {
      container.startGate = held;
    }],
    ['the listener proof', (container: FakeSandbox, held: Gate) => {
      container.execGate = held;
    }],
    ['the port exposure', (container: FakeSandbox, held: Gate) => {
      container.exposeGate = held;
    }],
    ['the boot-id stamp', (container: FakeSandbox, held: Gate) => {
      container.stampGate = held;
    }],
  ])('no operation is admitted while %s is still in flight', async (_phase, park) => {
    // MAIN'S REGRESSION, per phase. `attached` used to be published the moment
    // the WORK DIRECTORY was there, so an operation could be admitted while a
    // service or a port was still settling and read a world that was only
    // partly restored. Under the gate there is no such window: the phase is
    // parked, the operation is issued, and it must not run at all until the
    // whole restore has settled into `attached` or the named `repair`.
    const { box, container } = await stoppedBoxWithService();
    const held = gate();
    park(container, held);

    const activation = box.start();
    await held.reached;

    let ran = false;
    let observed: string | undefined;
    const operation = deliver(container, async () => {
      observed = (await box.devboxState()).restoration;
      ran = true;
    });
    // The phase is parked and the operation is issued. Nothing may have run:
    // the platform has not delivered it, and there is no promise it could have
    // joined that would let it through early.
    expect(ran).toBe(false);

    held.release();
    await activation;
    await operation;

    expect(ran).toBe(true);
    // ONE OF EXACTLY TWO ENDINGS, never a third. Whichever phase was parked,
    // the caller is admitted into a fully restored world or into a box that
    // NAMES what is missing.
    expect(observed).toBeDefined();
    expect(['attached', 'repair']).toContain(observed!);
  });

  test('the ordering is not an accident of the fake: an operation issued after the gate still queues behind nothing', async () => {
    // The mirror of the tests above, so they cannot pass vacuously. Once the
    // activation has completed there is nothing to wait for, and a caller's
    // command is the FIRST thing on the channel after the restore's own.
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    const before = container.execs.length;
    await box.exec('echo after');
    expect(container.execs.slice(before)).toEqual(['echo after']);
  });
});

describe('the gate is re-entered on every container start, so the restore is idempotent', () => {
  test('a second activation costs one attach probe and starts no second process', async () => {
    const { box, container } = await stoppedBoxWithService();

    await box.start();
    const afterFirst = {
      starts: container.starts.length,
      exposures: container.exposures.length,
      ready: (await box.devboxState()).ready,
    };

    // The container is recycled and comes back: the hook fires again, on the
    // same durable specs.
    await container.stop();
    await box.start();

    const afterSecond = await box.devboxState();
    expect(afterFirst).toEqual({ starts: 1, exposures: 1, ready: true });
    // ALREADY RUNNING IS ALREADY RESTORED: the second walk asks the container
    // what it holds and leaves the live process alone, so one spec never
    // becomes two processes fighting over one port.
    expect(container.starts).toHaveLength(1);
    expect({ restoration: afterSecond.restoration, ready: afterSecond.ready })
      .toEqual({ restoration: 'attached', ready: true });
  });

  test('a stale attempt cannot publish over the activation that superseded it', async () => {
    // THE FENCE, proven rather than asserted. A restoration in flight when the
    // container is replaced keeps running with its own view of the world; the
    // generation it started on is what makes every write it still owes inert.
    const { box, container, rows } = await stoppedBoxWithService();

    // An attempt parked at its last phase, on the generation that is about to
    // be superseded.
    const parked = gate();
    container.stampGate = parked;
    const stale = box.devboxStartup();
    await parked.reached;

    // The container is replaced underneath it, and the new instance's own
    // activation restores the box.
    await container.stop();
    await box.start();
    const settled = await box.devboxState();

    // The stale attempt settles last. It must change nothing.
    parked.release();
    await stale;

    expect(settled.restoration).toBe('attached');
    const after = await box.devboxState();
    expect({ restoration: after.restoration, ready: after.ready, bootId: after.bootId })
      .toEqual({ restoration: 'attached', ready: true, bootId: settled.bootId });
    expect(rows.has('devbox:attach-recovery')).toBe(false);
  });

  test('the activation joins its own restore rather than opening a second one', async () => {
    // The `start()` the fallback callback makes is nested INSIDE this hook, so
    // its continuation arrives while the gate's restore is registered. It must
    // join, not open a rival restoration against the same container.
    const { box, container } = await stoppedBoxWithService();
    await box.devboxStartup();
    // One stamp: the activation's. A second restoration would have stamped
    // again, which is how a box gets two boot ids for one container.
    expect(stamps(container)).toBe(1);
    expect((await box.devboxState()).ready).toBe(true);
  });
});

describe('every ending is a named state, and the activation always completes', () => {
  test('a poisoned restore leaves an operable-for-repair box and a completed activation', async () => {
    // THE POISON: the port the caller left behind never answers. Nothing else
    // is wrong — the work directory is there, the process came back — so the
    // box must stay usable BY THE AGENT WHOSE SERVICE FAILED, which is the
    // whole reason `repair` admits operations at all.
    const harnessed = await stoppedBoxWithService();
    const { box, container, rows } = harnessed;
    container.listening.delete(3000);

    // THE ACTIVATION COMPLETES. It does not reject — a rejection here is
    // `blockConcurrencyWhile`'s own failure path, which the runtime answers by
    // resetting the object — and it does not hang.
    await box.start();

    const state = await box.devboxState();
    expect({ restoration: state.restoration, ready: state.ready, unready: state.unready })
      .toEqual({
        restoration: 'repair',
        ready: false,
        unready: 'port 3000 never answered',
      });
    // NO URL IS PUBLISHED for a port that said nothing: a preview that answers
    // 502 is worse than none.
    expect(container.exposures).toEqual([]);
    // OPERABLE FOR REPAIR: the agent can still reach the box to fix it.
    const repaired = await box.exec('echo fixing');
    expect(repaired.exitCode).toBe(0);
    // And the incident is on the ledger, so the failure is not only in memory.
    expect([...rows.keys()].some((key) => key.startsWith('devbox:incident:'))).toBe(true);
  });

  test('a restore with no budget left classifies instead of issuing another command', async () => {
    // THE BOUND, and the reason it is not a timer. With the budget spent, the
    // polled check refuses to ISSUE the next container command — so nothing is
    // left running to abandon, which is exactly why this classifies as
    // `gate-bound` (retry the same identity) rather than `abandoned` (destroy
    // it). A container that is merely slower than one activation may wait must
    // never be destroyed for it.
    const { box, container, rows } = await stoppedBoxWithService(SpentBudgetBox);

    await box.start();

    const state = await box.devboxState();
    expect(state.restoration).toBe('unattached');
    expect(state.unready).toContain('[gate-bound → retry]');
    expect(state.unready).toContain('init gate');
    // NOTHING WAS DESTROYED, and a successor is armed: the ladder did not move,
    // so the next tick tries the same container outside the gate, where a timer
    // is delivered and the ladder CAN escalate.
    expect(container.destroys).toBe(0);
    expect(container.schedules).toContain('devboxStartup');
    // The ladder did not move: the row names this attempt and carries NO stage,
    // so the next failure of this identity still enters at the first rung.
    expect(rows.get('devbox:attach-recovery')).not.toHaveProperty('stage');
  });

  test('a failure outside the restore still completes the activation with a reason', async () => {
    // The one thing `#restoreNow` cannot classify is a failure that is not the
    // restore's: this object's own storage, under the ladder claim. Rejecting
    // would reject the platform's block and reset the object — the same reset
    // this placement exists to avoid, reached by another road — so it is
    // recorded and the box refuses with a reason instead.
    const { box, storage } = await stoppedBoxWithService();
    storage.faultOn('devbox:attach-recovery', new Error('durable storage unreachable'));

    await box.start();

    const state = await box.devboxState();
    expect(state.restoration).toBe('unattached');
    expect(state.unready).toContain('durable storage unreachable');
  });

  test('a box mid-restoration says so, instead of reporting that none has run', async () => {
    // MEASURED DEFECT. `unstarted` meant both "nothing has begun" and "an
    // attempt is running and has published nothing yet", so a box in the middle
    // of a minutes-long restoration answered "no restoration has run for this
    // container yet" — and a poller read that as nothing-to-wait-for for as
    // long as it lasted. Live: 300,771 ms of it, with `/state` answering
    // throughout.
    const { box, container } = await stoppedBoxWithService();
    const parked = gate();
    container.stampGate = parked;

    const attempt = box.devboxStartup();
    await parked.reached;

    const during = await box.devboxState();
    expect(during.restoration).toBe('restoring');
    expect(during.unready).toContain('a restoration has been running');
    expect(during.ready).toBe(false);

    parked.release();
    await attempt;
    expect((await box.devboxState()).restoration).toBe('attached');
  });
});

describe('the per-operation join is the fallback, not the primary path', () => {
  test('a cold start needs no join: the first operation finds the box already settled', async () => {
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    // The container is up and restored, so the operation's readiness check
    // drives nothing: no second admission probe, no second restoration.
    const probesBefore = container.startWaitOptions.length;
    await box.exec('echo hello');
    expect(container.startWaitOptions).toHaveLength(probesBefore);
    expect(stamps(container)).toBe(1);
  });

  test('a container replaced in mid-life is what the join is for', async () => {
    // The case the start hook cannot cover: the platform swaps the instance
    // under a live object, and the hook that would restore it fires on a
    // container start this object never sees. The box notices by its boot
    // marker and re-drives the restoration through the fallback.
    const { box, container } = await stoppedBoxWithService();
    await box.start();
    expect((await box.devboxState()).ready).toBe(true);

    // A fresh instance: the ephemeral boot marker is gone, and nothing told the
    // object.
    container.bootId = undefined;
    await box.devboxHeartbeat();

    expect((await box.devboxState()).replacedCount).toBe(1);
    expect(stamps(container)).toBeGreaterThan(1);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('an operation is refused, re-armably, when no container was ever admitted', async () => {
    // MEASURED DEFECT. The readiness gate's tail was a bare drive with no check
    // after it, and the drive RETURNS NORMALLY when the platform admitted no
    // container — so an operation ran as if ready against a box with no
    // attached work directory. Live: `exec` answered success in 62 ms while the
    // box's own state said nothing had attached. For a mount-backed strategy
    // that means the caller's bytes land in a bare `/workspace` nothing will
    // ever checkpoint.
    const { box, container } = await stoppedBoxWithService();
    container.containerUnavailable = new Error(
      'there is no container instance that can be provided to this durable object',
    );

    await expect(box.exec('echo hello')).rejects.toThrow('not ready');

    // AND THE BOX STAYS RE-ARMABLE. The refusal is the operation's, not a
    // classification: writing `unattached` here would read as terminal to every
    // poller, and a capacity blip is not terminal.
    const state = await box.devboxState();
    expect(state.restoration).not.toBe('unattached');
    expect(container.schedules).toContain('devboxStartup');
  });
});
