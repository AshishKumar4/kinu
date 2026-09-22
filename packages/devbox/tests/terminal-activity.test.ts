// The ready+activity bridge lives on `Devbox`, so every host inherits it: a terminal lane
// stamps the durable interaction only after the readiness gate admits the box.
import { describe, expect, test } from 'bun:test';

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

describe('every admitted operation is an interaction', () => {
  test('a file write on an admitted box stamps the lease the heartbeat reads', async () => {
    const { box } = harness(TestBox);
    await box.devboxStartup();
    expect((await box.devboxState()).lastInteractionAt).toBeUndefined();

    await box.writeFile('/workspace/witness.txt', 'bytes a caller put there');

    expect((await box.devboxState()).lastInteractionAt).toEqual(expect.any(Number));
  });
});
