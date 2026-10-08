// The box's schedule table is its lifeline and its bill: every self-re-arming chain keeps a successor,
// and a row nobody owes must not exist, since the platform wakes the object for every row it holds.
// Driven through native alarm dispatch, quiesce and checkpoint entrypoints.
import { TestDevbox } from './support/test-devbox';
import { describe, expect, test, vi } from 'bun:test';

import { harness, wakeWhileArmed, type FakeSandbox } from './support/devbox-harness';

class TestBox extends TestDevbox<unknown> {

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
    ['was reclaimed by the platform', async (_box: TestBox, container: FakeSandbox) => { await container.stop(); }],
  ] as const) {
    test(`a box that ${how} is woken for what the stop left, then never again`, async () => {
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

      try {
        const { box, container } = harness(TestBox);
        await box.devboxStartup();
        await stop(box, container);
        const starts = container.containerStarts;

        await container.seedSchedule("devboxHeartbeat", now / 1000 - 1);

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
    container.clearSchedules();
    storage.faultOn('devbox:last-tick', new Error('the storage write was refused'));

    await box.devboxHeartbeat();

    // Nothing else re-arms a heartbeat: a beat that ends without a successor is the last one.
    expect(callbacks(container)).toEqual(['devboxHeartbeat']);
  });
  test("one native alarm dispatches both due callbacks while each arms its successor", async () => {
    const { box, container } = harness(TestBox);
    await box.start();
    await container.seedSchedule("devboxCheckpoint", Date.now() / 1000 - 1);
    await container.seedSchedule("devboxHeartbeat", Date.now() / 1000 - 1);
    await box.alarm();
    expect(callbacks(container)).toEqual(["devboxCheckpoint", "devboxHeartbeat"]);
    expect(container.alarmAt).toBeGreaterThan(Date.now());
  });
  test("a failed native alarm is delivered again until its callback settles", async () => {
    let calls = 0;
    const failure = new Error("interrupted heartbeat");

    class InterruptedBox extends TestBox {
      override async devboxHeartbeat(): Promise<void> {
        calls++;

        if (calls === 1) throw failure;
        await super.devboxHeartbeat();
      }
    }

    const { box, container } = harness(InterruptedBox);
    await container.seedSchedule("devboxHeartbeat", Date.now() / 1000 - 1);
    await expect(box.alarm()).rejects.toMatchObject({ _tag: "DevboxError", message: failure.message });
    await box.alarm();
    expect({ calls, rows: callbacks(container), alarm: container.alarmAt })
      .toEqual({ calls: 2, rows: [], alarm: null });
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
      container.clearSchedules();
      container.bootId = undefined;

      await expect(run(box)).rejects.toMatchObject({ code: 'io' });
      expect(callbacks(container)).toContain('devboxStartup');
    });
  }
});
