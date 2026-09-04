import { describe, expect, test } from 'bun:test';
import { candidateBox, candidateHead } from './support/candidate-box';
import { TEST_BOX_ID, deriveBoxId } from './support/devbox-harness';
import { candidateStorePaths } from '../src/candidates/container';
import type { CandidateContainerFormat } from '../src/candidates/container';

const RUN = 'ab-bounded-layers-20260904';

describe('box identity derives from strategy and name', () => {
  test('same inputs give the same identity, any difference gives another', () => {
    expect(deriveBoxId('bounded-layers', RUN)).toBe(deriveBoxId('bounded-layers', RUN));
    expect(deriveBoxId('bounded-layers', RUN)).not.toBe(deriveBoxId('merkle-pack', RUN));
    expect(deriveBoxId('bounded-layers', RUN)).not.toBe(deriveBoxId('bounded-layers', `${RUN}-other`));
    expect(deriveBoxId('bounded-layers', RUN)).not.toBe(TEST_BOX_ID);
  });

  test('one name shares the head it published', async () => {
    const format: CandidateContainerFormat = 'bounded-layers';
    const first = candidateBox(format, RUN);
    await first.box.attachNow();
    await first.box.writeFile('/workspace/probe.txt', 'identity probe bytes');
    const published = await first.box.checkpointNow('quiesce');
    expect(published.kind).toBe('committed');
    const head = candidateHead(first.rows, format);
    if (head === null) throw new Error('the quiesce published no head');

    const same = candidateBox(format, RUN);
    for (const [key, value] of first.rows) same.rows.set(key, value);
    const firstDump = await first.box.candidateControlState();
    const reread = await same.box.candidateControlState();
    expect(reread.found).toBe(true);
    expect(reread.boxId).toBe(firstDump.boxId);
    expect(reread.key).toBe(firstDump.key);
    expect(reread.head).toBe(head);
  });

  test('another name isolates, leaving the first box orphans', async () => {
    const format: CandidateContainerFormat = 'bounded-layers';
    const first = candidateBox(format, RUN);
    await first.box.attachNow();
    await first.box.writeFile('/workspace/probe.txt', 'identity probe bytes');
    const published = await first.box.checkpointNow('quiesce');
    expect(published.kind).toBe('committed');
    const head = candidateHead(first.rows, format);
    if (head === null) throw new Error('the quiesce published no head');

    const other = candidateBox(format, `${RUN}-other`);
    for (const [key, value] of first.bucket.objects) other.bucket.objects.set(key, value);
    const isolated = await other.box.candidateControlState();
    expect(isolated.found).toBe(false);
    expect(isolated.boxId).not.toBe(deriveBoxId(format, RUN));
    const prefix = candidateStorePaths(`boxes/${deriveBoxId(format, RUN)}`, format).envelopePrefix;
    const listed = await other.bucket.handle.list({ prefix: `${prefix}/` });
    const orphans = listed.objects.filter((object) => object.key.includes(head.slice(0, 16)));
    expect(orphans).toHaveLength(1);
    expect((await other.box.attachNow()).kind).toBe('empty');
    const bootA = (await first.box.devboxState()).bootId;
    if (bootA === undefined) throw new Error('the first box stamped no boot id');
    const bootB = (await other.box.devboxState()).bootId;
    if (bootB === undefined) throw new Error('the other box stamped no boot id');
    expect(bootB).not.toBe(bootA);
  });
});
