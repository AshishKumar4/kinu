// An unattached box must always be either visibly working or re-armable, never silent
// and pinned: an in-flight restoration must not read as `unstarted`.
import { describe, expect, test } from 'bun:test';

import { Devbox, gate, harness } from './support/devbox-harness';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, attachBudgetMs: 60_000, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

describe('a box that is not attached is either visibly working or re-armable', () => {
  test('a restoration in flight is reported as one, not as a restoration nobody ran', async () => {
    const { box, container } = harness(TestBox);
    // Parked at the boot-id stamp, the restoration's last await: the attempt is registered,
    // its single-flight entry is held, and every later caller joins it.
    const stamp = gate();
    container.stampGate = stamp;
    const restoring = box.devboxStartup();
    await stamp.reached;

    const state = await box.devboxState();

    // Asserts the phase rather than the message text, so a rewording cannot pass.
    expect(state.ready).toBe(false);
    expect(state.restoration).toBe('restoring');

    stamp.release();
    await restoring;
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('a restoration nobody started still says so', async () => {
    const { box } = harness(TestBox);

    const state = await box.devboxState();
    expect(state.restoration).toBe('unstarted');
    expect(state.ready).toBe(false);
  });

  test('an admission the container refused leaves a re-armable row, not silence', async () => {
    const { box, container } = harness(TestBox);
    container.running.running = false;
    container.startFaultBeforeRunning = new Error(
      'There is no container instance that can be provided to this Durable Object, try again later',
    );

    await box.devboxStartup();

    expect(container.schedules).toContain('devboxStartup');
    expect((await box.devboxState()).ready).toBe(false);
  });
});
