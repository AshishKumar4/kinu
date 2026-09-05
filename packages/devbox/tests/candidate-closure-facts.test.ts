import { describe, expect, test } from 'bun:test';

import { candidateStoreFacts } from '../bench/candidate-facts';
import type { CandidateObjectReader } from '../bench/candidate-facts';
import { envelopeBytes, envelopeIdOf } from '../src/candidates/publication';
import type { RootEnvelopeV1 } from '../src/durability/contracts';

// ── the closure proof resolves the envelope's mount-relative keys ───────────
//
// The runner writes `obj/<sha>` beneath the store mounted at the payload
// prefix, and the envelope names the keys that way. Run
// 20260905075659 failed bounded-layers' lifecycle proof on "146 objects
// absent, 146 outside this arm's payload prefix" while every object was in
// the bucket: the facts asked the store for the bare keys. The row carries
// the joined key, and the driver's prefix check reads that address.

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
    };
    const facts = await candidateStoreFacts(stubStore({
      [`${BOX}/candidate-control/bounded-layers/envelopes/${envelopeIdOf(envelope)}.json`]: envelopeBytes(envelope),
      [`${BOX}/candidate/bounded-layers/obj/${sha}`]: new Uint8Array(4),
      [`${BOX}/candidate/bounded-layers/obj/${'b'.repeat(64)}`]: new Uint8Array(2),
    }), 'bounded-layers', BOX);

    expect(facts.head?.closureCount).toBe(1);
    expect(facts.payloadPrefix).toBe(`${BOX}/candidate/bounded-layers/`);
    expect(facts.closure).toEqual([
      { key: `${BOX}/candidate/bounded-layers/obj/${sha}`, declaredBytes: '4', storedBytes: 4 },
      { key: `${BOX}/candidate/bounded-layers/obj/${'b'.repeat(64)}`, declaredBytes: '2', storedBytes: 2 },
    ]);
    for (const row of facts.closure) expect(row.key.startsWith(facts.payloadPrefix)).toBe(true);
  });
});
