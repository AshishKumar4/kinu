import { expect, test, vi } from 'bun:test';
import { ChainTestBox, asked, chainBox, chainHead } from './support/chain-box';
import { gate, wakeWhileArmed } from './support/devbox-harness';
import { markerPath } from './support/native-shim';
import { INCIDENT_PREFIX } from '../src/incidents';

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
// leaves no row that would wake the object to start it again.
for (const [race, callback, gated] of [
  ['before the checkpoint enters its lane', 'devboxCheckpoint', false],
  ['during the adoption a checkpoint opens', 'devboxCheckpoint', true],
  ['during the adoption a heartbeat opens', 'devboxHeartbeat', true],
] as const) {
  test(`a stop ${race} after eviction is not undone`, async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const { box, evict, rows, container } = chainBox(ScheduledChainBox);
      await box.start();
      await box.checkpointNow('tick');
      const committed = chainHead(rows);
      const starts = container.containerStarts;
      const successor = evict();
      const admission = gate();

      if (gated) container.containerHookGate = admission;
      await container.seedSchedule(callback, now / 1000 - 1);

      // Ungated, the stop is issued as the wake is delivered; gated, once the wake's adoption holds. A wake that never
      // admits settles instead.
      const delivered = container.alarm();

      if (gated) await Promise.race([admission.reached, delivered]);
      await successor.stop();
      admission.release();
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
