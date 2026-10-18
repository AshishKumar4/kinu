import { expect, test } from 'bun:test';
import { ChainTestBox, chainBox, chainHead } from './support/chain-box';
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
