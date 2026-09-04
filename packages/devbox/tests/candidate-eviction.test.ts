import { describe, expect, test } from 'bun:test';
import { candidateBox, candidateHead, reactivateCandidateBox } from './support/candidate-box';
import { TEST_BOX_ID } from './support/devbox-harness';
import type { CandidateContainerFormat } from '../src/candidates/container';

async function publishStopEvictWake(format: CandidateContainerFormat): Promise<void> {
  const first = candidateBox(format);
  await first.box.attachNow();
  for (const kib of [64, 4096, 65536] as const) {
    await first.box.writeFile(`/workspace/ladder/c${kib}.bin`, `ladder ${kib} bytes`);
    const quiesce = await first.box.checkpointNow('quiesce');
    expect(quiesce.kind).toBe('committed');
    const tick = await first.box.checkpointNow('tick');
    expect(tick.kind).toBe('skipped');
  }
  const head = candidateHead(first.rows, format);
  if (head === null) throw new Error('the ladder published no head');
  const published = await first.box.candidateControlState();
  expect(published.found).toBe(true);
  expect(published.head).toBe(head);
  expect(published.boxId).toBe(TEST_BOX_ID);

  const stopped = await first.box.quiesce();
  expect(stopped.kind).toBe('skipped');
  expect(first.container.running.running).toBe(false);

  const second = reactivateCandidateBox(format, first);
  await second.box.kickStartup();
  await second.box.devboxStartup();
  const woken = await second.box.candidateControlState();
  console.log(
    `[evict:${format}] publish box=${published.boxId} key=${published.key} head=${published.head} op=${published.operation}`,
  );
  console.log(
    `[evict:${format}] wake box=${woken.boxId} key=${woken.key} found=${String(woken.found)} head=${woken.head} op=${woken.operation}`,
  );
  expect(woken.strategy).toBe(published.strategy);
  expect(woken.boxId).toBe(published.boxId);
  expect(woken.key).toBe(published.key);
  const state = await second.box.devboxState();
  expect(state.restoration).toBe('attached');
  expect(state.lastAttach?.kind).toBe('attached');
  expect(state.lastAttach?.detail).toContain(head);
  expect(woken.found).toBe(true);
  expect(woken.head).toBe(head);
}

describe('a published head survives eviction between stop and wake', () => {
  test('bounded-layers: stop, evict, wake finds the ladder head', async () => {
    await publishStopEvictWake('bounded-layers');
  });

  test('merkle-pack: stop, evict, wake finds the ladder head', async () => {
    await publishStopEvictWake('merkle-pack');
  });
});
