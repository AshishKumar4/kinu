// A restoration in flight is a restoration the box admits to.
//
// MEASURED DEFECT THIS HOLDS, and it is the reason bounded-layers read as a box
// that never attached rather than as a box that was slow. On the deployed arm
// (probe `blp1`: one Worker, one container, `wrangler tail` open across the
// whole attempt) the sequence was:
//
//   t+0     `/create`, container not yet admitted
//   t+~5s   two admission refusals recorded as incidents
//   t+15s   the container comes up; the scheduled callback drives the attach
//   t+15s…  `#startup` holds that attempt, `kickStartup` returns early on it,
//           so nothing re-arms and nothing else runs
//   t+300s  still `running=true restoration=unstarted`, still two incidents,
//           `/state` still answering in ~300 ms
//
// For 285 of those seconds the box answered `unready: no restoration has run
// for this container yet` while one was in flight. That sentence is not merely
// unhelpful, it is the wrong sentence: the driver's own classifier reads
// `running=true` plus `unstarted` as `pending` — its `stopped` arm requires
// `running === false` — so it never drives, never gives up early, and reports
// a ceiling refusal that names no cause. `e2ecal0901002202` recorded 900,001 ms
// of exactly that reading.
//
// THE PROPERTY, stated so it survives a rewrite of the state model: at every
// moment, a box that is not attached must either be VISIBLY WORKING or be
// RE-ARMABLE. Never both silent and pinned. A model in which an attempt can be
// held with no observable trace reintroduces this defect whatever its phases
// are called.
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
    // Parked at the boot-id stamp: the last await of the restoration, so the
    // attempt is registered, its single-flight entry is held, and every later
    // caller joins it. This is `blp1`'s state exactly.
    const stamp = gate();
    container.stampGate = stamp;
    const restoring = box.devboxStartup();
    await stamp.reached;

    const state = await box.devboxState();

    // THE ASSERTION THE DEPLOYED BOX FAILED. The attempt is on the record as
    // work in flight, never as work nobody started. Read off the phase rather
    // than the sentence, so a rewording cannot pass against a reworded lie.
    expect(state.ready).toBe(false);
    expect(state.restoration).toBe('restoring');

    stamp.release();
    await restoring;
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('a restoration nobody started still says so', async () => {
    // The other half of the property, so the fix above cannot be "always claim
    // to be working": a box that genuinely has not begun must still be
    // distinguishable from one that has.
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

    // Nothing is in flight, so the OTHER arm of the property applies: something
    // must be scheduled to try again. A refusal that armed nothing is the
    // permanent wedge with an incident attached.
    expect(container.schedules).toContain('devboxStartup');
    expect((await box.devboxState()).ready).toBe(false);
  });
});
