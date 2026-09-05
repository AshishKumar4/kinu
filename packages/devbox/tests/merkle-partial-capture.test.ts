import { describe, expect, test } from 'bun:test';

import { issueVerifiedJournalCapture, manifestSha256 } from '../src/capture/model';
import type { Capture, NodeEntry } from '../src/capture/model';
import { publishedParentOf, readStagedCandidateObjectForTest, MemoryCandidateObjectSink } from '../src/candidates/publication';
import type { CandidatePayloadStore, CandidatePublicationControl } from '../src/candidates/publication';
import { buildMerklePack, openMerklePack, parentFromPublishedParent } from '../src/candidates/merkle-pack';
import type { MerklePackBuild, MerklePackReader, MerklePackView, PackRun } from '../src/candidates/merkle-pack';
import { finalizeCandidatePayload, stageCandidatePayload, StaleParentRefused } from '../src/candidates/publication';
import type {
  ImmutableObjectRef,
  ObjectReceipt,
  OperationRecord,
  PayloadGrant,
  RangeReadIntent,
  RootEnvelopeV1,
  UploadIntent,
} from '../src/durability/contracts';
import { sha256Hex } from '../src/cas/hash';

// ── THE GATE QUESTION, stated before its answer ──────────────────────────────
//
// The journal daemon now fences v2 DELTA manifests: only the touched paths and
// their ancestors appear, so a runner handed one CANNOT present the codec a
// whole-tree AuditedCapture the way the v1 fence allowed. Bounded-layers merges
// a partial capture against its parent by construction (`parent.merged()`).
// v1 buildMerklePack plants its tree ONLY from the capture's entries and
// consults the parent for chunk/node reuse by digest — so the question is
// empirical, and this file answers it: does a PARTIAL capture build a child
// that serves the parent's untouched paths, or does it silently drop every path
// the capture did not name?
//
// The answer decides the defect-1 route for the merkle-pack arm: merge works →
// route A (the runner converts the v2 delta into the capture shape
// publishCapturedCandidate already merges); no merge → route B (host-side v2
// control, a bigger change announced before starting).

let inoSeq = 100;

function dir(path: string, mode = 0o755, ino = ++inoSeq): NodeEntry {
  return { path, kind: 'dir', mode, ino };
}

/** Deterministic pseudo-random bytes; a fixed seed keeps the test reproducible. */
function prng(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed | 0;
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    out[i] = s & 0xff;
  }
  return out;
}

const CAPTURE_IDENTITY = Object.freeze({
  captureId: 'cap-merkle',
  epoch: '7',
  baseRevision: '0',
  stableStageHandle: 'stage-merkle',
});

/** Journal metadata the daemon's v2 rows always carry. */
function withJournalMetadata(entries: readonly NodeEntry[]): readonly NodeEntry[] {
  return entries.map((entry) => entry.metadata === undefined
    ? { ...entry, metadata: { uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {} } }
    : entry);
}

/**
 * A SEALED capture, the shape `issueVerifiedJournalCapture` issues from a fence:
 * content addressed by digest, read through a sealed reader. This is what the
 * runner will build from a v2 delta's staged ranges, so the gate question is
 * asked against exactly that shape.
 */
function sealedAudited(
  entries: readonly NodeEntry[],
  sources: ReadonlyMap<string, Uint8Array>,
  cut = '4096',
  partial: { partial?: boolean; removed?: readonly string[] } = {},
): ReturnType<typeof issueVerifiedJournalCapture> {
  const journalEntries = withJournalMetadata(entries);
  const cutNumber = Number(cut);
  const capture: Capture = {
    mechanism: 'mutation-journal',
    cut: cutNumber,
    generation: 0,
    entries: journalEntries,
  };
  return issueVerifiedJournalCapture({
    cut: cutNumber,
    generation: 0,
    entries: journalEntries,
    identity: CAPTURE_IDENTITY,
    manifestSha256: manifestSha256(capture),
    sealedReader: {
      async read(sourceId, offset, length): Promise<Uint8Array> {
        const bytes = sources.get(sourceId);
        if (bytes === undefined) throw new Error(`missing sealed source ${sourceId}`);
        return bytes.slice(offset, offset + length);
      },
    },
    partial: partial.partial === true,
    removed: partial.removed,
  });
}

async function build(
  capture: Parameters<typeof buildMerklePack>[0],
  options: Omit<Parameters<typeof buildMerklePack>[1], 'sink'> = {},
): Promise<MerklePackBuild> {
  return await buildMerklePack(capture, { ...options, sink: new MemoryCandidateObjectSink() });
}

const RANGE_IDENTITY = {
  operationId: 'op-read-1',
  attemptId: 'try-read-1',
  boxId: 'box-merkle',
  epoch: '7',
  expiresAt: '99999999999999',
};

/** An object reader over in-memory bytes. */
class MemStore implements MerklePackReader {
  readonly objects = new Map<string, Uint8Array>();

  async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
    const bytes = this.objects.get(intent.exactKey);
    if (bytes === undefined) throw new Error(`missing object: ${intent.exactKey}`);
    const offset = Number(intent.byteOffset);
    const length = Number(intent.byteLength);
    if (offset < 0 || offset + length > bytes.byteLength) {
      throw new Error(`range out of bounds: ${intent.exactKey}`);
    }
    return bytes.slice(offset, offset + length);
  }

  async readRun(run: PackRun): Promise<Uint8Array> {
    const bytes = this.objects.get(run.key);
    if (bytes === undefined) throw new Error(`missing object: ${run.key}`);
    if (run.offset < 0 || run.offset + run.length > bytes.byteLength) {
      throw new Error(`run out of bounds: ${run.key}`);
    }
    return bytes.slice(run.offset, run.offset + run.length);
  }

  async restore(build: MerklePackBuild): Promise<void> {
    for (const object of build.staged) {
      this.objects.set(object.ref.key, await readStagedCandidateObjectForTest(object));
    }
  }
}

async function publish(build: MerklePackBuild, store: MemStore): Promise<MerklePackView> {
  await store.restore(build);
  return await openMerklePack(build.root, store, RANGE_IDENTITY);
}

/** The publication surface a finalized plan needs, in memory. */
class FakePublicationStore implements CandidatePayloadStore, CandidatePublicationControl {
  readonly operations: OperationRecord[] = [];
  readonly uploadedKeys: string[] = [];
  readonly payloads = new Map<string, Uint8Array>();
  readonly envelopes = new Map<string, RootEnvelopeV1>();
  private head: { rootEnvelopeId: string } | null = null;

  recordOperation(record: OperationRecord): void {
    this.operations.push(record);
  }

  async issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant> {
    return {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: `grant:${intent.exactKey}`,
    };
  }

  async uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const key = grant.opaque.slice('grant:'.length);
    this.uploadedKeys.push(key);
    this.payloads.set(key, bytes);
    return {
      operationId: grant.operationId,
      attemptId: grant.attemptId,
      key,
      byteLength: String(bytes.byteLength),
      sha256: sha256Hex(bytes),
      etag: 'etag-1',
      verified: true,
    };
  }

  async verifyObject(ref: ImmutableObjectRef): Promise<void> {
    const bytes = this.payloads.get(ref.key);
    if (bytes === undefined) throw new Error(`missing candidate object ${ref.key}`);
    if (String(bytes.byteLength) !== ref.byteLength || sha256Hex(bytes) !== ref.sha256) {
      throw new Error(`candidate object metadata mismatches ${ref.key}`);
    }
  }

  async writeEnvelope(envelope: RootEnvelopeV1, rootEnvelopeId: string): Promise<void> {
    this.envelopes.set(rootEnvelopeId, Object.freeze({ ...envelope }));
  }

  async compareAndSwapHead(envelope: RootEnvelopeV1, expectedParentRootId: string | null) {
    const id = (await import('../src/candidates/publication')).envelopeIdOf(envelope);
    if (this.head !== null && this.head.rootEnvelopeId !== expectedParentRootId) {
      throw new StaleParentRefused(expectedParentRootId, this.head.rootEnvelopeId);
    }
    this.head = { rootEnvelopeId: id };
    return { version: 1 as const, rootEnvelopeId: id, lastOperationId: 'cas-op' };
  }

  markFailed(): void {}
  async markComplete(): Promise<void> {}
}

let parentSequence = 0;

async function publishedParent(built: MerklePackBuild, view: MerklePackView) {
  const sequence = parentSequence++;
  const fullInput = {
    operationId: `parent-op-${sequence}`,
    attemptId: `parent-try-${sequence}`,
    boxId: 'box-merkle',
    bootId: 'parent-boot',
    epoch: '7',
    kind: 'tick' as const,
    expiresAt: '99999999999999',
  };
  const store = new FakePublicationStore();
  const published = await finalizeCandidatePayload(
    await stageCandidatePayload(built.plan, fullInput, store),
    fullInput,
    store,
  );
  return parentFromPublishedParent(view, publishedParentOf(published));
}

describe('merkle-pack/v1 partial captures against a parent', () => {
  test('a partial capture merges the untouched subtree from its parent', async () => {
    const untouchedBytes = prng(40 * 1024, 61);
    const changedBytes = prng(40 * 1024, 62);
    const untouchedIno = ++inoSeq;
    const changedIno = ++inoSeq;

    // Generation one: the whole tree, sealed through a fence-shaped reader.
    const first = await build(sealedAudited([
      dir('pkg'),
      {
        path: 'pkg/kept.bin', kind: 'file', mode: 0o644, ino: untouchedIno,
        metadata: { uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {} },
        content: {
          kind: 'sealed', size: untouchedBytes.byteLength, sourceId: 'kept-source',
          extents: [{ offset: 0, length: untouchedBytes.byteLength, sha256: sha256Hex(untouchedBytes) }],
        },
      },
      {
        path: 'pkg/changed.bin', kind: 'file', mode: 0o644, ino: changedIno,
        metadata: { uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {} },
        content: {
          kind: 'sealed', size: 40 * 1024, sourceId: 'changed-before',
          extents: [{ offset: 0, length: 40 * 1024, sha256: sha256Hex(prng(40 * 1024, 63)) }],
        },
      },
    ], new Map<string, Uint8Array>([
      ['kept-source', untouchedBytes],
      ['changed-before', prng(40 * 1024, 63)],
    ]), '4096', { partial: false }));
    const view = await publish(first, new MemStore());
    const parent = await publishedParent(first, view);

    // THE PARTIAL CAPTURE: only the changed file and its ancestor — the exact
    // entry set a v2 delta manifest presents for that write.
    const second = await build(sealedAudited([
      dir('pkg'),
      {
        path: 'pkg/changed.bin', kind: 'file', mode: 0o644, ino: changedIno,
        metadata: { uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {} },
        content: {
          kind: 'sealed', size: changedBytes.byteLength, sourceId: 'changed-after',
          extents: [{ offset: 0, length: changedBytes.byteLength, sha256: sha256Hex(changedBytes) }],
        },
      },
    ], new Map<string, Uint8Array>([['changed-after', changedBytes]]), '4097', { partial: true }), { parent });

    const store = new MemStore();
    await store.restore(first);
    await store.restore(second);
    const child = await openMerklePack(second.root, store, RANGE_IDENTITY);

    // THE GATE. If the merge works, the child serves the parent's untouched
    // file at full fidelity; if it does not, the child's tree silently lost
    // every path the capture did not name.
    expect(await child.stat('pkg/changed.bin')).toMatchObject({ kind: 'file', size: changedBytes.byteLength });
    // THE MERGE THE v2 FENCE REQUIRES: the parent's untouched file must be
    // served by the child at full fidelity. This is RED against the current
    // builder (which drops it — the characterization this file first proved),
    // and is the defect-1 fix for the merkle-pack arm.
    expect(await child.stat('pkg/kept.bin')).toMatchObject({ kind: 'file', size: untouchedBytes.byteLength });
    expect(Buffer.from(await child.readRange('pkg/kept.bin', 0, untouchedBytes.byteLength)))
      .toEqual(Buffer.from(untouchedBytes));
    // And the untouched content cost the child nothing: its bytes came from
    // the parent's packs, carried by digest.
    expect(second.stats.distinctChunksReused).toBeGreaterThan(0);

    expect(Buffer.from(await child.readRange('pkg/changed.bin', 0, changedBytes.byteLength)))
      .toEqual(Buffer.from(changedBytes));

  });
});
