import { describe, expect, test } from 'bun:test';
import { candidateBox, candidateHead } from './support/candidate-box';
import { Devbox, TEST_BOX_ID, harness } from './support/devbox-harness';
import type { CandidateContainerFormat } from '../src/candidates/container';

async function publishOne(format: CandidateContainerFormat): Promise<void> {
  const { box, rows } = candidateBox(format);
  const fresh = await box.candidateControlState();
  expect(fresh.strategy).toBe(format);
  expect(fresh.boxId).toBe(TEST_BOX_ID);
  const freshKey = fresh.key;
  if (freshKey === null) throw new Error('a candidate box names its control key');
  expect(fresh.found).toBe(false);
  expect(fresh.head).toBeNull();
  expect(fresh.operation).toBeNull();
  expect(rows.has(freshKey)).toBe(false);

  await box.attachNow();
  const beforePublish = await box.candidateControlState();
  expect(beforePublish.found).toBe(false);

  await box.writeFile('/workspace/probe.txt', 'control dump probe bytes');
  const published = await box.checkpointNow('quiesce');
  expect(published.kind).toBe('committed');
  const head = candidateHead(rows, format);
  if (head === null) throw new Error('the quiesce published no head');
  const after = await box.candidateControlState();
  expect(after.strategy).toBe(format);
  expect(after.boxId).toBe(TEST_BOX_ID);
  expect(after.found).toBe(true);
  expect(after.head).toBe(head);
  expect(after.operation).toBe('published');
  const afterKey = after.key;
  if (afterKey === null) throw new Error('a published box names its control key');
  expect(rows.has(afterKey)).toBe(true);
}

describe('candidateControlState reports the raw control fact', () => {
  test('bounded-layers: absent before publish, present after', async () => {
    await publishOne('bounded-layers');
  });

  test('merkle-pack: absent before publish, present after', async () => {
    await publishOne('merkle-pack');
  });

  test('a non-candidate box has no control key by design', async () => {
    const { box } = harness(Devbox);
    const state = await box.candidateControlState();
    expect(state.key).toBeNull();
    expect(state.found).toBe(false);
    expect(state.head).toBeNull();
    expect(state.operation).toBeNull();
  });
});
