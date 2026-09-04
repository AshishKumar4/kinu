import { describe, expect, test } from 'bun:test';
import { candidateBox, candidateHead } from './support/candidate-box';
import { TEST_BOX_ID, deriveBoxId } from './support/devbox-harness';
import { candidateStorePaths } from '../src/candidates/container';
import type { CandidateContainerFormat } from '../src/candidates/container';

const RUN = 'ab-bounded-layers-20260904';

describe('box identity derives from strategy and name', () => {
  test('the identity is a stated function of its inputs, stable across processes', () => {
    // Was `deriveBoxId(a, b)` compared with `deriveBoxId(a, b)` — the expected
    // side computed by the code under test, so it could not fail. Determinism
    // WITHIN one process is not the property that matters either: the id
    // addresses durable storage, so a derivation that changes between deploys
    // strands every existing box. Only a stated value can assert that, which
    // is why these literals are here and why drift in one is a finding rather
    // than a chore. Each is `sha256Hex('<strategy>:<name>')`, the fixture's
    // model of `binding.idFromName`.
    expect(deriveBoxId('bounded-layers', RUN))
      .toBe('47353dc73641b25ec31b484d638525cb549209617d437243029ce4385a3b750d');
    expect(deriveBoxId('merkle-pack', RUN))
      .toBe('2c20456c8985722141a11115274afb71b3dc0b002495742b8e6bdab0a550a61a');
    expect(deriveBoxId('bounded-layers', `${RUN}-other`))
      .toBe('6225a1e8af4ab22b5c3248ce8c63a2eee2647fdfc5bc87d3dee6217fede58b90');
    // And each differs from the legacy fixed id, which is what makes two boxes
    // in one test genuinely separate storage rather than one shared row map.
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
