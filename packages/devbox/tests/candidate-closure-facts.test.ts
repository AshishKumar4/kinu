import { describe, expect, test } from 'bun:test';

import { candidateStoreFacts, envelopeBytes, envelopeIdOf } from '../bench/candidate-facts';
import type { CandidateObjectReader, RootEnvelopeV1 } from '../bench/candidate-facts';

// ── the closure proof resolves the envelope's mount-relative keys ───────────
//
// The runner writes `obj/<sha>` and `closure/<sha>` beneath the store mounted
// at the payload prefix, and the envelope names them that way. Run
// 20260905075659 failed bounded-layers' lifecycle proof on "146 objects
// absent, 146 outside this arm's payload prefix" while every object was in
// the bucket: the facts asked the store for the bare keys. The row carries
// the joined key, and the driver's prefix check reads that address.
//
// PROVENANCE. First added in `4b2c25c76` (2026-09-05), deleted with its
// module in `32fd27369` (2026-09-09). Restored 2026-09-10 against the
// bench-local `bench/candidate-facts.ts`: the envelope helpers it imported
// from `src/candidates/publication` now live in the bench module itself.

const sha = 'a'.repeat(64);

const BOX = 'boxes/3d74cb9b';

function stubStore<const T extends Record<string, Uint8Array>>(objects: T): CandidateObjectReader {
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
    // The pre-`4b2c25c76` defect, pinned so it cannot return silently: ask
    // the store for the envelope's mount-relative keys WITHOUT the payload
    // prefix and every object reads absent, exactly the morning run's row.
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
