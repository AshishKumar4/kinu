import { expect, test, vi } from 'bun:test';
import { ChainTestBox, asked, chainBox, chainHead, type ChainBox } from './support/chain-box';
import { READY_GOLDEN, gate, wakeWhileArmed, type Gate } from './support/devbox-harness';
import { markerPath } from './support/native-shim';
import { INCIDENT_PREFIX } from '../src/incidents';
import type { RestoreClockPhase } from '../src/restoration';

class ScheduledChainBox extends ChainTestBox {
  protected override get ambientCheckpoints(): boolean {
    return true;
  }
}

test('a checkpoint delivered before the first heartbeat adopts the running container after eviction', async () => {
  const { box, evict, rows, container } = chainBox(ScheduledChainBox);
  await box.start();
  await box.checkpointNow('tick');
  const committed = chainHead(rows);
  const bootId = container.bootId;
  const starts = container.containerStarts;
  const successor = evict();
  await container.seedSchedule('devboxCheckpoint', Date.now() / 1000 - 1);

  await container.alarm();

  expect({
    committed: chainHead(rows),
    incidents: [...rows.keys()].filter((key) => key.startsWith(INCIDENT_PREFIX)),
    bootId: container.bootId,
    starts: container.containerStarts,
    ready: (await successor.devboxState()).ready,
  }).toEqual({ committed: (committed ?? 0) + 1, incidents: [], bootId, starts, ready: true });

  await successor.quiesce();
  expect(container.running.running).toBe(false);
  expect(chainHead(rows)).toBe((committed ?? 0) + 2);
});

test('a checkpoint alarm on an unused computer starts nothing and reports no durability failure', async () => {
  const { container, rows } = chainBox(ScheduledChainBox);
  await container.seedSchedule('devboxCheckpoint', Date.now() / 1000 - 1);

  await container.alarm();

  expect({
    committed: chainHead(rows),
    incidents: [...rows.keys()].filter((key) => key.startsWith(INCIDENT_PREFIX)),
    starts: container.containerStarts,
    running: container.running.running,
    schedules: container.scheduleRows,
  }).toEqual({ committed: null, incidents: [], starts: 0, running: false, schedules: [] });
});

// D34: maintenance starts no container. A wake whose adoption meets a stop leaves the box stopped, files nothing, and
// leaves no row that would wake the object to start it again. The stop lands as the wake is delivered, or while one
// step of the adoption is held.
const races: readonly (readonly [string, string, ((arm: ChainBox, held: Gate) => void) | undefined])[] = [
  ['before the checkpoint enters its lane', 'devboxCheckpoint', undefined],
  ['during the admission a checkpoint opens', 'devboxCheckpoint', ({ container }, held) => { container.containerHookGate = held; }],
  ['during the admission a heartbeat opens', 'devboxHeartbeat', ({ container }, held) => { container.containerHookGate = held; }],
  ['during the start hook a checkpoint opens', 'devboxCheckpoint', ({ storage }, held) => { storage.gateOn('devbox:restoration', held); }],
  // The platform replaced the container: the adoption turns over and restores it, and the stop lands in that restore.
  ['during the restore a checkpoint opens', 'devboxCheckpoint', ({ container }, held) => { container.bootId = undefined; container.stampGate = held; }],
];

for (const [race, callback, hold] of races) {
  test(`a stop ${race} after eviction is not undone`, async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const arm = chainBox(ScheduledChainBox);
      const { box, evict, rows, container } = arm;
      await box.start();
      await box.checkpointNow('tick');
      const committed = chainHead(rows);
      const starts = container.containerStarts;
      const successor = evict();
      const held = gate();
      hold?.(arm, held);
      await container.seedSchedule(callback, now / 1000 - 1);
      const delivered = container.alarm();

      // A wake that never reaches the hold settles instead.
      if (hold !== undefined) await Promise.race([held.reached, delivered]);
      await successor.stop();
      held.release();
      await delivered;
      await wakeWhileArmed(container, (to) => { now = Math.max(now, to); }, 20);

      expect({
        committed: chainHead(rows),
        incidents: [...rows.keys()].filter((key) => key.startsWith(INCIDENT_PREFIX)),
        starts: container.containerStarts,
        running: container.running.running,
        schedules: container.scheduleRows,
        alarm: container.alarmAt,
      }).toEqual({ committed, incidents: [], starts, running: false, schedules: [], alarm: null });
    } finally {
      clock.mockRestore();
    }
  });
}

test('a superseded restore whose container stopped leaves the start that replaced it alone', async () => {
  const source = gate();
  let holding = false;
  let restoreSettled = (): void => undefined;

  // Tells the test when a restore settles, whatever its outcome.
  class WitnessedChainBox extends ScheduledChainBox {
    protected override onRestorePhase(phase: RestoreClockPhase): void {
      if (phase === 'settled') restoreSettled();
    }
  }

  const { box, evict, rows, container } = chainBox(WitnessedChainBox, {
    ...READY_GOLDEN,
    goldenFor: async (asking, lost) => {
      if (holding) {
        source.enter();
        await source.promise;
      }

      return await READY_GOLDEN.goldenFor(asking, lost);
    },
  });

  await box.start();
  await box.checkpointNow('tick');
  const committed = chainHead(rows);
  const starts = container.containerStarts;
  // The platform replaced the container: the tick's adoption turns over, and its restore parks at the boot-id stamp.
  container.bootId = undefined;
  const successor = evict();
  const stamp = gate();
  container.stampGate = stamp;
  await container.seedSchedule('devboxCheckpoint', Date.now() / 1000 - 1);
  const ticked = container.alarm();
  // A tick that never adopts settles instead, here and below.
  await Promise.race([stamp.reached, ticked]);
  // The platform reclaims the container, and a start supersedes the parked restore while its source is held.
  await container.stop();
  holding = true;
  const restarted = successor.devboxStartup();
  await source.reached;
  const settled = new Promise<void>((resolve) => { restoreSettled = resolve; });
  stamp.release();
  await Promise.race([settled, ticked]);
  const startupHeld = (await successor.devboxState()).flights.startupMs !== null;

  source.release();
  await Promise.all([ticked, restarted]);

  // The checkpoint waits for the live start and saves what it restored (D26).
  expect({
    startupHeld,
    committed: chainHead(rows),
    starts: container.containerStarts,
    running: container.running.running,
    ready: (await successor.devboxState()).ready,
  }).toEqual({ startupHeld: true, committed: (committed ?? 0) + 1, starts: starts + 1, running: true, ready: true });
});

test('attaching after eviction adopts the restoration the running container carries', async () => {
  const { box, evict, container } = chainBox();
  const first = await box.attachNow();
  await box.checkpointNow('tick');
  const bootId = container.bootId;
  const starts = container.containerStarts;
  const successor = evict();
  const before = asked.length;

  const again = await successor.attachNow();

  expect({
    again,
    asked: asked.slice(before),
    bootId: container.bootId,
    starts: container.containerStarts,
    ready: (await successor.devboxState()).ready,
  }).toEqual({ again: first, asked: [], bootId, starts, ready: true });
});

// Its final checkpoint adopts too, but a stop reads the adopted restoration before it lists processes or saves sessions.
test('a stop of an evicted box whose adoption is refused stops it with nothing to commit', async () => {
  const { box, evict, rows, container } = chainBox();
  await box.start();
  await box.checkpointNow('tick');
  const committed = chainHead(rows);
  // A marker this box cannot route refuses the adoption terminally (D47).
  container.files.set(markerPath('/backups'), JSON.stringify({ protocolVersion: 2 }));
  const successor = evict();

  const outcome = await successor.quiesce();

  expect({
    outcome: outcome.kind,
    committed: chainHead(rows),
    incidents: (await successor.devboxIncidentReasons()).map((row) => row.stage),
    running: container.running.running,
  }).toEqual({ outcome: 'skipped', committed, incidents: ['attach'], running: false });
});

test('a scheduled checkpoint on a replaced container commits nothing and arms the restore', async () => {
  const { box, rows, container } = chainBox(ScheduledChainBox);
  await box.start();
  await box.checkpointNow('tick');
  const committed = chainHead(rows);
  container.clearSchedules();
  container.bootId = undefined;
  await container.seedSchedule('devboxCheckpoint', Date.now() / 1000 - 1);

  await container.alarm();

  expect({ committed: chainHead(rows), startup: container.scheduleRows.some((row) => row.callback === 'devboxStartup') })
    .toEqual({ committed, startup: true });
});
