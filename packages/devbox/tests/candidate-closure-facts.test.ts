import { describe, expect, test } from 'bun:test';

import { candidateStoreFacts, envelopeBytes, envelopeIdOf } from '../bench/candidate-facts';
import type { CandidateObjectReader, RootEnvelopeV1 } from '../bench/candidate-facts';

// The envelope names `obj/<sha>` and `closure/<sha>` relative to the store's mount, so facts
// must read them beneath the payload prefix and report the joined key.

const sha = 'a'.repeat(64);

const BOX = 'boxes/3d74cb9b';

function stubStore(objects: Record<string, Uint8Array>): CandidateObjectReader {
  return {
    list: async ({ prefix }) => ({
      objects: Object.entries(objects)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => ({ key, size: bytes.byteLength })),
      truncated: false,
    }),
    get: async (key) => {
      const bytes = objects[key];

      return bytes === undefined ? null : { arrayBuffer: async () => new Uint8Array(bytes).buffer };
    },
    head: async (key) => {
      const bytes = objects[key];

      return bytes === undefined ? null : { size: bytes.byteLength };
    },
  };
}

describe('candidate closure facts', () => {
  test('finds the closure at the payload prefix and reports the joined key', async () => {
    const envelope: RootEnvelopeV1 = {
      version: 1,
      format: 'bounded-layers/v1',
      boxId: '3d74cb9b',
      epoch: '3',
      generation: '1',
      parentRootId: null,
      cut: {
        captureId: 'cut', epoch: '3', baseRevision: '0', cut: '1',
        stableStageHandle: 'stage', manifestSha256: sha,
      },
      rootObject: { key: `obj/${sha}`, byteLength: '4', sha256: sha },
      closure: [{ key: `obj/${'b'.repeat(64)}`, byteLength: '2', sha256: 'b'.repeat(64) }],
      closureObject: { key: `closure/${'c'.repeat(64)}`, byteLength: '3', sha256: 'c'.repeat(64) },
    };

    const facts = await candidateStoreFacts(stubStore({
      [`${BOX}/candidate-control/bounded-layers/envelopes/${envelopeIdOf(envelope)}.json`]: envelopeBytes(envelope),
      [`${BOX}/candidate/bounded-layers/obj/${sha}`]: new Uint8Array(4),
      [`${BOX}/candidate/bounded-layers/obj/${'b'.repeat(64)}`]: new Uint8Array(2),
      [`${BOX}/candidate/bounded-layers/closure/${'c'.repeat(64)}`]: new Uint8Array(3),
    }), 'bounded-layers', BOX);

    expect(facts.head?.closureCount).toBe(1);
    expect(facts.payloadPrefix).toBe(`${BOX}/candidate/bounded-layers/`);
    expect(facts.closure).toEqual([
      { key: `${BOX}/candidate/bounded-layers/obj/${sha}`, declaredBytes: '4', storedBytes: 4 },
      { key: `${BOX}/candidate/bounded-layers/closure/${'c'.repeat(64)}`, declaredBytes: '3', storedBytes: 3 },
      { key: `${BOX}/candidate/bounded-layers/obj/${'b'.repeat(64)}`, declaredBytes: '2', storedBytes: 2 },
    ]);

    for (const row of facts.closure) expect(row.key.startsWith(facts.payloadPrefix)).toBe(true);
  });

  test('a bare-key lookup reproduces the 146-absent false negative', async () => {
    const envelope: RootEnvelopeV1 = {
      version: 1,
      format: 'bounded-layers/v1',
      boxId: '3d74cb9b',
      epoch: '3',
      generation: '1',
      parentRootId: null,
      cut: {
        captureId: 'cut', epoch: '3', baseRevision: '0', cut: '1',
        stableStageHandle: 'stage', manifestSha256: sha,
      },
      rootObject: { key: `obj/${sha}`, byteLength: '4', sha256: sha },
      closure: [],
      closureObject: { key: `closure/${'c'.repeat(64)}`, byteLength: '3', sha256: 'c'.repeat(64) },
    };

    const objects = {
      [`${BOX}/candidate/bounded-layers/obj/${sha}`]: new Uint8Array(4),
      [`${BOX}/candidate/bounded-layers/closure/${'c'.repeat(64)}`]: new Uint8Array(3),
    };

    const store = stubStore(objects);

    for (const ref of [envelope.rootObject, envelope.closureObject]) {
      expect(await store.head(ref.key)).toBeNull();
      expect(ref.key.startsWith(`${BOX}/candidate/bounded-layers/`)).toBe(false);
    }
  });
});
