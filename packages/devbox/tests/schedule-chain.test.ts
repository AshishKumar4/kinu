// The box's schedule table is its lifeline and its bill: every self-re-arming chain keeps a successor,
// and a row nobody owes must not exist, since the platform wakes the object for every row it holds.
// Driven through the SDK's own entry points (scheduled callbacks, the activity expiry, `quiesce`,
// `checkpointNow`) against the harness container, whose schedule table the box and the SDK share.
import { describe, expect, test, vi } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { chainBox, chainHead } from './support/chain-box';
import { Devbox, harness, wakeWhileArmed, type FakeSandbox } from './support/devbox-harness';

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get previewHost(): string | undefined {
    return 'preview.example';
  }
}

const callbacks = (container: FakeSandbox): string[] => container.scheduleRows.map((row) => row.callback).sort();

describe('the schedule a started box holds', () => {
  test('its heartbeat and checkpoint links, and no incident row while none waits to be delivered', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();

    // The admission spends the startup row; an incident row with nothing to deliver would wake the
    // object for nothing.
    expect(callbacks(container)).toEqual(['devboxCheckpoint', 'devboxHeartbeat']);
  });

  // Waste, 2026-09-25: stopped boxes' heartbeats kept waking their objects, 10,141 alarms in an hour
  // across 174 boxes. However the container stopped, and however many overdue beats a reset object
  // owes, each row the stop left runs once, starts nothing, and the object is left with no alarm.
  for (const [how, stop] of [
    ['quiesced', async (box: TestBox) => { await box.quiesce(); }],
    ['was stopped under it', async (box: TestBox) => { await box.stop(); }],
    ['outlived its activity lease', async (box: TestBox) => { await box.onActivityExpired(); }],
  ] as const) {
    test(`a box that ${how} is woken for what the stop left, then never again`, async () => {
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

      try {
        const { box, container } = harness(TestBox);
        await box.devboxStartup();
        await stop(box);
        const starts = container.containerStarts;

        for (const late of [3, 2, 1]) container.scheduleRows.push({ callback: 'devboxHeartbeat', time: now / 1000 - late });

        await wakeWhileArmed(container, (to) => { now = Math.max(now, to); }, 20);

        expect({ starts: container.containerStarts, running: container.running.running, rows: callbacks(container), alarm: container.alarmAt })
          .toEqual({ starts, running: false, rows: [], alarm: null });
      } finally {
        clock.mockRestore();
      }
    });
  }
});

describe('every self-re-arming chain keeps its successor', () => {
  test('a heartbeat whose own tick cannot be written still arms the next beat', async () => {
    const { box, container, storage } = harness(TestBox);
    await box.devboxStartup();
    container.scheduleRows.splice(0);
    storage.faultOn('devbox:last-tick', new Error('the storage write was refused'));

    await box.devboxHeartbeat();

    // Nothing else re-arms a heartbeat: a beat that ends without a successor is the last one.
    expect(callbacks(container)).toEqual(['devboxHeartbeat']);
  });

  test('a heartbeat renews the activity timeout, which alone keeps the SDK alarm chain alive', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();
    const before = container.activityRenewals;

    await box.devboxHeartbeat();

    expect(container.activityRenewals).toBe(before + 1);
  });

  test('the activity expiry commits a final checkpoint before the SDK stops the container', async () => {
    const { box, container, rows } = chainBox();
    expect((await box.attachNow()).kind).toBe('empty');
    await box.writeFile('/workspace/notes.md', 'written just before the box went idle');

    await box.onActivityExpired();

    expect({ committed: chainHead(rows) !== null, running: container.running.running })
      .toEqual({ committed: true, running: false });
  });
});

describe('a commit on a replaced container is refused, and the restore is armed', () => {
  // The heartbeat notices a replacement only at its cadence; a commit in between would claim bytes
  // durable from a container that lost the mount.
  for (const [commit, run] of [
    ['a checkpoint between beats', (box: TestBox) => box.checkpointNow('tick')],
    ['the final checkpoint of a stop', (box: TestBox) => box.quiesce()],
  ] as const) {
    test(`${commit} refuses`, async () => {
      const { box, container } = harness(TestBox);
      await box.devboxStartup();
      container.scheduleRows.splice(0);
      container.bootId = undefined;

      await expect(run(box)).rejects.toThrow('the restored container was replaced');
      expect(callbacks(container)).toContain('devboxStartup');
    });
  }
});
