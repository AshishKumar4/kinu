// The ready+activity bridge lives on `Devbox`, so every host inherits it: a terminal lane
// stamps the durable interaction only after the readiness gate admits the box.
import { describe, expect, setSystemTime, test } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY, LAST_INTERACTION_KEY, QUIET_SINCE_KEY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, harness } from './support/devbox-harness';

/** The shipped policy with a test-length probe: nothing here is about budgets. */
class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

class UnreachableHostBox extends TestBox {
  protected override async hasBackgroundWork(): Promise<boolean> {
    throw new Error('the owning workspace cannot be reached');
  }
}

class IdleHostBox extends TestBox {
  protected override async hasBackgroundWork(): Promise<boolean> {
    return false;
  }
}

describe('noteTerminalActivity refuses before it stamps', () => {
  test('a box the platform admitted nothing to stamps no interaction', async () => {
    const { box, container } = harness(TestBox);
    await container.stop();
    container.containerUnavailable = new Error(
      'there is no container instance that can be provided to this durable object',
    );

    // The value is the refusal that survives the RPC boundary; the throw is the strict gate's.
    // Both shapes must name unreadiness, not some other failure.
    expect(await box.resolveReadiness()).toEqual({
      kind: 'pending',
      reason: expect.stringContaining('not ready'),
    });
    await expect(box.noteTerminalActivity()).rejects.toThrow(/(not ready|no attached work directory)/);
    expect((await box.devboxState()).lastInteractionAt).toBeUndefined();
  });

  test('an admitted box stamps the interaction the heartbeat reads', async () => {
    const { box } = harness(TestBox);
    await box.devboxStartup();
    expect((await box.devboxState()).ready).toBe(true);
    // Startup is maintenance traffic and stamps nothing, so the stamp below comes only from
    // the inherited method.
    expect((await box.devboxState()).lastInteractionAt).toBeUndefined();

    await box.noteTerminalActivity();

    expect((await box.devboxState()).lastInteractionAt).toEqual(expect.any(Number));
  });
});

describe('a throwing host-background check holds the box', () => {
  test('the beat holds, opens no quiet window, and stops nothing', async () => {
    const { box, container, rows } = harness(UnreachableHostBox);
    await box.devboxStartup();
    // Park the lease so the box is idle AND its quiet window already
    // confirmed: with the host answering, the next beat must quiesce.
    const now = Date.now();
    rows.set(LAST_INTERACTION_KEY, now - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);
    rows.set(QUIET_SINCE_KEY, now - DEFAULT_DEVBOX_POLICY.quietConfirmMs - 60_000);

    await box.devboxHeartbeat();

    const state = await box.devboxState();
    // With a confirmed quiet window and an idle lease, `hold` can only come from background
    // work staying true: the heartbeat's possibly-busy fail-safe for a throwing host check.
    expect(state.lastTick?.decision).toBe('hold');
    expect(state.quietSince).toBeUndefined();
    expect(container.running.running).toBe(true);
  });

  test('the same seeding quiesces when the host answers idle, so the hold above is not vacuous', async () => {
    const { box, rows } = harness(IdleHostBox);
    await box.devboxStartup();
    const now = Date.now();
    rows.set(LAST_INTERACTION_KEY, now - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);
    rows.set(QUIET_SINCE_KEY, now - DEFAULT_DEVBOX_POLICY.quietConfirmMs - 60_000);

    await box.devboxHeartbeat();

    expect((await box.devboxState()).lastTick?.decision).toBe('quiesce');
  });
});

/** Idle host; the container's process list fails every read. */
class UnreadableProcessesBox extends IdleHostBox {
  override listProcesses(): Promise<never> {
    return Promise.reject(new Error('the sandbox /processes endpoint answered 500'));
  }
}

/** Busy, and counts how often the beat asks: each ask wakes the owning workspace. */
class CountingHostBox extends TestBox {
  asks = 0;

  protected override async hasBackgroundWork(): Promise<boolean> {
    this.asks += 1;

    return true;
  }
}

describe('the beat asks the host at most once per quiet-confirm window', () => {
  test('beats inside one window reuse the answer, and the next window asks again', async () => {
    const start = Date.now();
    const { box, rows } = harness(CountingHostBox);

    try {
      await box.devboxStartup();
      rows.set(LAST_INTERACTION_KEY, start - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);

      for (let beat = 0; beat < 5; beat++) {
        setSystemTime(start + beat * 60_000);
        await box.devboxHeartbeat();
      }

      // warm-forge-4d6acc02's box asked its root every minute for 30+ hours (2026-09-25/26).
      expect(box.asks).toBe(1);
      expect((await box.devboxState()).lastTick?.decision).toBe('hold');

      setSystemTime(start + DEFAULT_DEVBOX_POLICY.quietConfirmMs + 60_000);
      await box.devboxHeartbeat();

      expect(box.asks).toBe(2);
    } finally {
      setSystemTime();
    }
  });
});

describe('a box rests only once no command it ran is still running', () => {
  test("an earlier activation's command keeps the box awake, and the box rests once it exits", async () => {
    const start = Date.now();
    const { box, container, rows } = harness(IdleHostBox);

    try {
      await box.devboxStartup();
      rows.set(LAST_INTERACTION_KEY, start - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);
      rows.set(QUIET_SINCE_KEY, start - DEFAULT_DEVBOX_POLICY.quietConfirmMs - 60_000);
      // A detached `npm test` its caller's evicted activation left running.
      container.processes.set('cmd-npm-test', { id: 'cmd-npm-test', pid: 4242, status: 'running', command: 'npm test' });

      await box.devboxHeartbeat();

      expect((await box.devboxState()).lastTick?.decision).toBe('hold');
      expect(container.running.running).toBe(true);

      container.processes.set('cmd-npm-test', { id: 'cmd-npm-test', pid: 4242, status: 'completed', command: 'npm test' });
      await box.devboxHeartbeat();
      setSystemTime(start + DEFAULT_DEVBOX_POLICY.quietConfirmMs + 60_000);
      await box.devboxHeartbeat();

      expect((await box.devboxState()).lastTick?.decision).toBe('quiesce');
    } finally {
      setSystemTime();
    }
  });

  test('a process list that never reads holds for one quiet-confirm window, then lets the box rest', async () => {
    const start = Date.now();
    const { box, container, rows } = harness(UnreadableProcessesBox);

    try {
      await box.devboxStartup();
      rows.set(LAST_INTERACTION_KEY, start - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);
      const beats = [];

      for (let beat = 1; beat <= 40; beat++) {
        setSystemTime(start + DEFAULT_DEVBOX_POLICY.idleMs + beat * 60_000);
        await box.devboxHeartbeat();
        const tick = (await box.devboxState()).lastTick;
        beats.push(tick?.decision);

        if (tick?.decision === 'quiesce') {
          expect(tick.note).toContain('process list');
          break;
        }
      }

      expect(beats.slice(0, 9).every((decision) => decision === 'hold')).toBe(true);
      expect(beats.at(-1)).toBe('quiesce');
      // The stop itself reads the list to kill processes; it must not refuse on the same failure.
      expect(container.running.running).toBe(false);
      // On record, not only on the console: the streak's start, the give-way, and the stop's fallback.
      expect((await box.devboxState()).incidents.total).toBe(3);
    } finally {
      setSystemTime();
    }
  });

  test('an unreadable supervised-spec store counts as an unreadable list: the beat holds, it does not throw', async () => {
    const { box, rows, storage } = harness(IdleHostBox);
    await box.devboxStartup();
    const now = Date.now();
    rows.set(LAST_INTERACTION_KEY, now - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);
    rows.set(QUIET_SINCE_KEY, now - DEFAULT_DEVBOX_POLICY.quietConfirmMs - 60_000);
    storage.failListOn('devbox:proc:', new Error('storage read failed'));

    await box.devboxHeartbeat();
    storage.failListOn('devbox:proc:', undefined);

    expect((await box.devboxState()).lastTick?.decision).toBe('hold');
  });

  test('a supervised server does not hold the box: the next start restores it', async () => {
    const start = Date.now();
    const { box } = harness(IdleHostBox);

    try {
      await box.devboxStartup();
      await box.startSupervised('python3 -m http.server 8000');

      setSystemTime(start + DEFAULT_DEVBOX_POLICY.idleMs + 60_000);
      await box.devboxHeartbeat();
      setSystemTime(start + DEFAULT_DEVBOX_POLICY.idleMs + DEFAULT_DEVBOX_POLICY.quietConfirmMs + 120_000);
      await box.devboxHeartbeat();

      expect((await box.devboxState()).lastTick?.decision).toBe('quiesce');
    } finally {
      setSystemTime();
    }
  });
});

describe('every admitted operation is an interaction', () => {
  test('a file write on an admitted box stamps the lease the heartbeat reads', async () => {
    const { box } = harness(TestBox);
    await box.devboxStartup();
    expect((await box.devboxState()).lastInteractionAt).toBeUndefined();

    await box.writeFile('/workspace/witness.txt', 'bytes a caller put there');

    expect((await box.devboxState()).lastInteractionAt).toEqual(expect.any(Number));
  });
});
