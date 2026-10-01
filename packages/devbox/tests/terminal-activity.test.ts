// The ready+activity bridge lives on `Devbox`, so every host inherits it: a terminal lane
// stamps the durable interaction only after the readiness gate admits the box.
import { describe, expect, setSystemTime, test, vi } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY, LAST_INTERACTION_KEY, QUIET_SINCE_KEY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, harness, wakeWhileArmed } from './support/devbox-harness';
import { Processes } from "../src/processes";

/** The shipped policy with a test-length probe: nothing here is about budgets. */
class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
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

// D56, as the owner corrected it: a box rests on its own use only. Its workspace's turns never reach it, so a box
// whose workspace keeps working without touching it rests one idle window after its own last use.
describe("only the box's own use holds it", () => {
  test('a box last used a minute ago holds through its idle window and rests once the quiet is confirmed', async () => {
    const start = Date.now();
    const { box, rows } = harness(TestBox);

    try {
      await box.devboxStartup();
      rows.set(LAST_INTERACTION_KEY, start - 60_000);
      setSystemTime(start);
      await box.devboxHeartbeat();
      const holding = (await box.devboxState()).lastTick?.decision;

      setSystemTime(start - 60_000 + DEFAULT_DEVBOX_POLICY.idleMs);
      await box.devboxHeartbeat();
      setSystemTime(start - 60_000 + DEFAULT_DEVBOX_POLICY.idleMs + DEFAULT_DEVBOX_POLICY.quietConfirmMs);
      await box.devboxHeartbeat();
      const resting = (await box.devboxState()).lastTick?.decision;

      expect({ holding, resting }).toEqual({ holding: 'hold', resting: 'quiesce' });
    } finally {
      setSystemTime();
    }
  });
});

describe('a box rests only once no command it ran is still running', () => {
  test("an earlier activation's command keeps the box awake, and the box rests once it exits", async () => {
    const start = Date.now();
    const { box, container, rows } = harness(TestBox);

    try {
      await box.devboxStartup();
      await new Processes(container.handle()).start("npm test", { processId: "cmd-npm-test" });
      rows.set(LAST_INTERACTION_KEY, start - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);
      rows.set(QUIET_SINCE_KEY, start - DEFAULT_DEVBOX_POLICY.quietConfirmMs - 60_000);

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
    const { box, container, rows } = harness(TestBox);
    await box.devboxStartup();
    container.fileFaults.set('/var/tmp/devbox/processes', { errno: 13, message: 'the process directory cannot be read' });

    try {
      rows.set(LAST_INTERACTION_KEY, start - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);
      const beats = [];

      for (let beat = 1; beat <= 40; beat++) {
        setSystemTime(start + DEFAULT_DEVBOX_POLICY.idleMs + beat * 60_000);
        await box.devboxHeartbeat();
        const tick = (await box.devboxState()).lastTick;
        beats.push(tick?.decision);

        if (tick?.decision === 'quiesce') {
          expect(tick.note).toContain('the process directory cannot be read');
          break;
        }
      }

      expect(beats.slice(0, 9).every((decision) => decision === 'hold')).toBe(true);
      expect(beats.at(-1)).toBe('quiesce');
      expect(container.running.running).toBe(false);
      // The streak's start, the give-way, and the stop's fallback are durable incidents.
      expect((await box.devboxState()).incidents.total).toBe(3);
    } finally {
      container.fileFaults.clear();
      setSystemTime();
    }
  });

  test('an unreadable supervised-spec store counts as an unreadable list: the beat holds, it does not throw', async () => {
    const { box, rows, storage } = harness(TestBox);
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
    const { box } = harness(TestBox);

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

// Staging, 2026-09-28: a box whose own startup got a container after its caller had gone was never
// used, so its idle clock read "now" on every beat and it never rested.
describe('a box no caller used rests from its start', () => {
  test('a box its own startup started rests after the idle window and quiet confirmation', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const { box, container } = harness(TestBox);
      await box.devboxStartup();

      // The shipped policy rests an idle box after about forty beats.
      await wakeWhileArmed(container, (to) => { now = Math.max(now, to); }, 120);

      expect({ running: container.running.running, alarm: container.alarmAt }).toEqual({ running: false, alarm: null });
    } finally {
      clock.mockRestore();
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
