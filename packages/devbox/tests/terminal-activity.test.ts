// The ready+activity bridge lives on Devbox itself, so every host inherits it:
// a terminal lane the lease cannot see stamps the same durable interaction any
// other caller stamps, and only after the readiness gate admits the box.
//
// The three properties below are the ones the Kinu thin-adapter cleanup moved
// without changing: a refused box stamps nothing, an admitted box stamps, and
// a host-background check that throws still holds the box open — the hold
// coming from Devbox's own heartbeat fail-safe, not from the host.
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

/** A host whose background-work question cannot be answered. */
class UnreachableHostBox extends TestBox {
  protected override async hasBackgroundWork(): Promise<boolean> {
    throw new Error('the owning workspace cannot be reached');
  }
}

/** A host with nothing still bound to the container. */
class IdleHostBox extends TestBox {
  protected override async hasBackgroundWork(): Promise<boolean> {
    return false;
  }
}

// The durable row names come from lifecycle.ts beside the policy: the seeding
// below has to name them, and every assertion reads back through the public
// devboxState().
describe('noteTerminalActivity refuses before it stamps', () => {
  test('a box the platform admitted nothing to stamps no interaction', async () => {
    const { box, container } = harness(TestBox);
    await container.stop();
    container.containerUnavailable = new Error(
      'there is no container instance that can be provided to this durable object',
    );

    // The refusal a pending box gives, as a value and as a throw: the value
    // is what survives the RPC boundary, the throw is what the strict gate
    // raises. Either refusal shape names unreadiness, not some other failure.
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
    // The startup itself is maintenance traffic, not use: it stamps nothing,
    // so the stamp below can only come from the inherited method.
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
    // `hold` with a confirmed quiet window and an idle lease leaves exactly
    // one suspect: background work stayed true, which with a throwing host
    // check can only be the heartbeat's own possibly-busy fail-safe.
    expect(state.lastTick?.decision).toBe('hold');
    expect(state.quietSince).toBeUndefined();
    expect(container.running.running).toBe(true);
  });

  test('the same seeding quiesces when the host answers idle, so the hold above is not vacuous', async () => {
    const { box, rows } = harness(IdleHostBox);
    await box.devboxStartup();
    // Same seeding as above: idle lease, confirmed quiet window.
    const now = Date.now();
    rows.set(LAST_INTERACTION_KEY, now - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);
    rows.set(QUIET_SINCE_KEY, now - DEFAULT_DEVBOX_POLICY.quietConfirmMs - 60_000);

    await box.devboxHeartbeat();

    expect((await box.devboxState()).lastTick?.decision).toBe('quiesce');
  });
});
