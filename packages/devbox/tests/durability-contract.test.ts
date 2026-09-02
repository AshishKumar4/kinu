import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CandidateControlStateV1Schema,
  CandidateRunControlV1Schema,
  DURABILITY_AWAIT_POINTS,
  DURABILITY_OPERATION_PHASES,
  CapturedCutSchema,
  ImmutableObjectRefSchema,
  HeadPointerV1Schema,
  ObjectReceiptSchema,
  OperationRecordSchema,
  PayloadGrantSchema,
  RangeReadIntentSchema,
  RestoreWorkSchema,
  RootEnvelopeV1Schema,
  UploadIntentSchema,
} from '../src/durability/contracts';
import type {
  CandidateControlStateV1,
  CandidateRunControlV1,
  HeadPointerV1,
  RestoreWork,
  RootEnvelopeV1,
} from '../src/durability/contracts';
import { FileCasStore, runOverlayRunner } from '../src/cas/overlay-runner';
import { overlayCasStorage, type OverlayCasPorts } from '../src/overlay-cas';
import type { AttachOutcome } from '../src/storage';
import { WatchedCasStore, treeHeavyStore } from './support/cas-cost-probe';

const SHA = 'a'.repeat(64);
const object = { key: 'v1/boxes/box/attempts/op/try/data-a', byteLength: '12', sha256: SHA };
const closureObject = { key: 'v1/boxes/box/attempts/op/try/closure-a', byteLength: '12', sha256: SHA };
const capturedCut = {
  captureId: 'capture-1',
  epoch: '7',
  baseRevision: '8',
  cut: '42',
  stableStageHandle: 'stage-1',
  manifestSha256: SHA,
};
const envelope: RootEnvelopeV1 = {
  version: 1,
  format: 'merkle-pack/v1',
  boxId: 'box-1',
  epoch: '7',
  generation: '9',
  parentRootId: null,
  cut: capturedCut,
  rootObject: object,
  closure: [object],
  closureObject,
};

describe('durability v1 wire contracts', () => {
  test('a closed root envelope binds the full captured cut, not a bare cut number', () => {
    expect(v.parse(RootEnvelopeV1Schema, envelope)).toEqual(envelope);
  });

  test('a head pointer names one exact envelope and the operation that published it', () => {
    const pointer: HeadPointerV1 = {
      version: 1,
      rootEnvelopeId: SHA,
      lastOperationId: 'op-1',
    };
    expect(v.parse(HeadPointerV1Schema, pointer)).toEqual(pointer);
    expect(() => v.parse(HeadPointerV1Schema, {
      ...pointer,
      lastOperationId: '',
    })).toThrow();
    expect(() => v.parse(HeadPointerV1Schema, {
      ...pointer,
      reachable: [object],
    })).toThrow();
  });

  test('wire counters and digests refuse unsafe representations', () => {
    expect(() => v.parse(ImmutableObjectRefSchema, { ...object, byteLength: '-1' })).toThrow();
    expect(() => v.parse(ImmutableObjectRefSchema, { ...object, sha256: 'short' })).toThrow();
    // A bare decimal is no longer a legal envelope cut.
    expect(() => v.parse(RootEnvelopeV1Schema, {
      version: 1,
      format: 'merkle-pack/v1',
      boxId: 'box-1',
      epoch: '7',
      generation: '9',
      parentRootId: null,
      cut: '42',
      rootObject: object,
      closure: [object],
      closureObject,
    })).toThrow();
    expect(() => v.parse(RootEnvelopeV1Schema, {
      version: 1,
      format: 'merkle-pack/v1',
      boxId: 'box-1',
      epoch: '01',
      generation: '9',
      parentRootId: null,
      cut: { ...capturedCut, captureId: '' },
      rootObject: object,
      closure: [object],
      closureObject,
    })).toThrow();
  });

  test('an upload receipt proves the exact attempted object', () => {
    expect(v.parse(ObjectReceiptSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-1',
      key: object.key,
      byteLength: object.byteLength,
      sha256: SHA,
      etag: 'etag',
      verified: true,
    }).verified).toBe(true);
    expect(() => v.parse(ObjectReceiptSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-1',
      key: object.key,
      byteLength: object.byteLength,
      sha256: SHA,
      etag: 'etag',
      verified: false,
    })).toThrow();
  });

  test('restore work reports every hidden readiness dimension', () => {
    expect(v.parse(RestoreWorkSchema, {
      serialRemoteOps: 1,
      totalRemoteOps: 1,
      metadataBytes: 128,
      payloadBytes: 0,
      cpuSteps: 4,
      mounts: 1,
      replayUnits: 0,
    })).toEqual({
      serialRemoteOps: 1,
      totalRemoteOps: 1,
      metadataBytes: 128,
      payloadBytes: 0,
      cpuSteps: 4,
      mounts: 1,
      replayUnits: 0,
    });
  });

  test('payload grants bind one attempt, method, object, and expiry', () => {
    const intent = v.parse(UploadIntentSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-1',
      boxId: 'box-1',
      epoch: '7',
      exactKey: object.key,
      method: 'PUT',
      byteLength: object.byteLength,
      sha256: SHA,
      expiresAt: '100',
    });
    expect(intent.method).toBe('PUT');
    expect(v.parse(PayloadGrantSchema, {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: 'provider-owned-capability',
    }).opaque).toBe('provider-owned-capability');
    expect(() => v.parse(UploadIntentSchema, { ...intent, method: 'GET' })).toThrow();
  });

  test('range reads and captures carry exact re-drive coordinates', () => {
    expect(v.parse(RangeReadIntentSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-2',
      boxId: 'box-1',
      epoch: '7',
      exactKey: object.key,
      method: 'GET',
      byteOffset: '4096',
      byteLength: '8192',
      sha256: SHA,
      expiresAt: '100',
    }).byteOffset).toBe('4096');
    expect(v.parse(CapturedCutSchema, {
      captureId: 'capture-1',
      epoch: '7',
      baseRevision: '8',
      cut: '42',
      stableStageHandle: 'stage-1',
      manifestSha256: SHA,
    }).cut).toBe('42');
  });

  test('operation state stores only information independent of its phase', () => {
    const intent = v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'intent',
    });
    expect(intent.phase).toBe('intent');
    expect(Object.keys(intent).sort()).toEqual([
      'baseRevision', 'bootId', 'epoch', 'expectedParent', 'kind', 'operationId', 'phase',
    ]);

    const published = v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'published',
      resultRootId: SHA,
    });
    expect(published.phase).toBe('published');
    const completionPending = v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'completion-pending',
      attemptId: 'attempt-1',
      resultRootId: SHA,
    });
    expect(completionPending.phase).toBe('completion-pending');
    expect(v.parse(HeadPointerV1Schema, {
      version: 1,
      rootEnvelopeId: SHA,
      lastOperationId: 'op-1',
    })).toEqual({
      version: 1,
      rootEnvelopeId: SHA,
      lastOperationId: 'op-1',
    });
    expect(() => v.parse(HeadPointerV1Schema, {
      version: 1,
      rootEnvelopeId: SHA,
      lastOperationId: 'op-1',
      parentRootId: SHA,
    })).toThrow();
  });

  test('operation phase rejects redundant and impossible state', () => {
    expect(() => v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'intent',
      attemptId: 'unused-attempt',
    })).toThrow();
    expect(() => v.parse(OperationRecordSchema, {
      operationId: 'op-1',
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-1',
      baseRevision: '8',
      expectedParent: SHA,
      phase: 'sealed',
      attemptId: 'attempt-1',
    })).toThrow();
  });

  test('durable operation phases contain no response-only acknowledgement state', () => {
    expect(DURABILITY_OPERATION_PHASES).toEqual([
      'intent', 'transferring', 'sealed', 'completion-pending', 'published', 'failed',
    ]);
  });

  test('the durable control record holds a pointer and an operation, never an envelope', () => {
    const record: CandidateControlStateV1 = {
      version: 1,
      head: { version: 1, rootEnvelopeId: SHA, lastOperationId: 'op-1' },
      operation: null,
    };
    expect(v.parse(CandidateControlStateV1Schema, record)).toEqual(record);
    expect(v.parse(CandidateControlStateV1Schema, { version: 1, head: null, operation: null }).head).toBeNull();
    expect(() => v.parse(CandidateControlStateV1Schema, { ...record, envelope })).toThrow();
    expect(() => v.parse(CandidateControlStateV1Schema, {
      ...record,
      head: { ...record.head, envelope },
    })).toThrow();
  });

  test('the container run control pairs one pointer with the exact envelope it names', () => {
    const pointer: HeadPointerV1 = { version: 1, rootEnvelopeId: SHA, lastOperationId: 'op-1' };
    const control: CandidateRunControlV1 = {
      version: 1,
      head: { pointer, envelope },
      operation: null,
    };
    expect(v.parse(CandidateRunControlV1Schema, control)).toEqual(control);
    // A pointer without its envelope, or an envelope without its pointer, is unrepresentable.
    expect(() => v.parse(CandidateRunControlV1Schema, { ...control, head: { pointer } })).toThrow();
    expect(() => v.parse(CandidateRunControlV1Schema, { ...control, head: { envelope } })).toThrow();
    expect(() => v.parse(CandidateRunControlV1Schema, { ...control, head: pointer })).toThrow();
  });

  test('the reset fault register exactly names every external await', () => {
    expect(DURABILITY_AWAIT_POINTS).toEqual([
      'issue-payload-grant',
      'create-multipart',
      'upload-multipart-part',
      'complete-multipart',
      'verify-upload',
      'upload-root',
      'publish-head',
      'create-pin',
      'renew-pin',
      'release-pin',
      'read-mark-page',
      'complete-mark',
      'retire-object',
      'delete-retired-object',
      'mount-root',
      'cleanup-resource',
    ]);
    expect(new Set(DURABILITY_AWAIT_POINTS).size).toBe(DURABILITY_AWAIT_POINTS.length);
  });
});

// ── the readiness dimensions, measured on a real attach ──────────────────────
//
// `RestoreWorkSchema` above declares the dimensions a readiness claim has to be
// stated in, and until now nothing produced one — so a strategy could advertise
// flat recovery while carrying a term that grew with its own tree, and the
// contract would not notice. overlay-cas did exactly that: `attach` called
// `inventory()`, a LIST over the whole prefix, on both of its paths.
//
// These tests fill a `RestoreWork` from a REAL attach — the shipped adapter,
// the shipped runner, receipts crossing the shipped stdout schema — and assert
// which of its seven dimensions may move. The `inventory` port is poisoned, so
// a prefix listing anywhere in attach fails the attach rather than inflating a
// number someone has to notice.

interface AttachProbe {
  readonly outcome: AttachOutcome;
  readonly work: RestoreWork;
}

/**
 * One real attach against a prefix holding `objects` folded objects, plus
 * whatever `pending` names journalled and not folded.
 *
 * Every field of the returned `RestoreWork` comes from something observed:
 * store calls for the op counts, recorded byte lengths split by key namespace
 * for the two byte figures, mount port calls for `mounts`, and the restore
 * receipt for `replayUnits`.
 */
async function measureAttach(
  objects: number,
  foldedSeq: number,
  pending: readonly (readonly [string, string])[] = [],
): Promise<AttachProbe> {
  const root = await mkdtemp(join(tmpdir(), 'overlay-attach-work-'));
  try {
    const upper = join(root, 'upper');
    const store = join(root, 'store');
    await Promise.all([mkdir(upper), mkdir(store)]);
    await treeHeavyStore(store, objects, foldedSeq);
    // Journalled through the real checkpoint, so what the attach replays is a
    // journal this release wrote rather than a fixture's idea of one.
    if (pending.length > 0) {
      for (const [name, body] of pending) await writeFile(join(upper, name), body);
      await runOverlayRunner({ operation: 'checkpoint', upper, store: new FileCasStore(store) });
      await rm(upper, { recursive: true, force: true });
      await mkdir(upper);
    }

    const watched = new WatchedCasStore(new FileCasStore(store));
    let mounted = false;
    let mounts = 0;
    let replayUnits = 0;
    let batchesDecoded = 0;
    const ports: OverlayCasPorts = {
      containerRunning: () => true,
      mountStore: async () => {
        mounts += 1;
      },
      unmountStore: async () => {},
      mountOverlay: async () => {
        mounts += 1;
        mounted = true;
      },
      unmountOverlay: async () => {
        mounted = false;
      },
      overlayMounted: async () => mounted,
      invokeRunner: async (operation) => {
        const receipt = await runOverlayRunner({ operation, upper, store: watched });
        replayUnits = receipt.entries;
        batchesDecoded = watched.keys('get').filter(key => key.startsWith('journal/')).length;
        // Through stdout, because that is the wire. The adapter parses these
        // bytes under its strict schema, so a receipt this release cannot
        // produce fails here rather than in a reviewer's head.
        return { stdout: `${JSON.stringify(receipt)}\n`, stderr: '', exitCode: 0 };
      },
      inventory: async () => {
        throw new Error('attach listed the prefix, which is the tree-size term');
      },
      clearPrefix: async () => 0,
      // Nothing here writes to a bare work directory, so the salvage moves
      // nothing; `overlay-cas.test.ts` owns the case where a replaced container
      // left bytes there.
      salvageWorkdirResidue: async () => 0,
      readState: async () => null,
      writeState: async () => {},
      clearState: async () => {},
      checkpointIntervalMs: () => 300_000,
      now: () => 1_000,
      log: () => {},
    };

    const outcome = await overlayCasStorage(ports).attach();
    const payloadBytes = watched.payloadBytes('get') + watched.payloadBytes('put');
    return {
      outcome,
      work: {
        // The runner awaits each store call before issuing the next, so its
        // serial depth and its total are the same number. Recording both is how
        // a future batched implementation would show up as a difference.
        serialRemoteOps: watched.calls.length,
        totalRemoteOps: watched.calls.length,
        metadataBytes: watched.bytes('get') + watched.bytes('put') - payloadBytes,
        payloadBytes,
        // Local work the replay performs: decode a pending batch, apply an
        // entry. Zero when there is nothing pending, which is the point.
        cpuSteps: batchesDecoded + replayUnits,
        mounts,
        replayUnits,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('an overlay-cas attach, in the readiness dimensions this contract declares', () => {
  test('A 100× LARGER TREE PRODUCES AN IDENTICAL RestoreWork', async () => {
    // THE CLAIM, in the contract's own vocabulary: none of the seven dimensions
    // is a function of the tree. The cursor is held equal across the two probes
    // so the only thing that varies is the object count — a larger `foldedSeq`
    // is a genuinely longer `cursor.json`, and letting both move would give a
    // real prefix scan an explainable place to hide.
    const thin = await measureAttach(20, 7);
    const fat = await measureAttach(2_000, 7);

    expect(v.parse(RestoreWorkSchema, thin.work)).toEqual(thin.work);
    expect(fat.work).toEqual(thin.work);
    // Two remote operations: read the cursor, list the journal. Plus the two
    // mounts the adapter takes — the store, then the overlay, in that order.
    expect(thin.work).toMatchObject({
      serialRemoteOps: 2,
      totalRemoteOps: 2,
      payloadBytes: 0,
      cpuSteps: 0,
      mounts: 2,
      replayUnits: 0,
    });
    expect(thin.work.metadataBytes).toBeGreaterThan(0);
    // Both prefixes hold objects, and the cursor is how attach knew that
    // without listing either one.
    expect(thin.outcome.kind).toBe('attached');
    expect(fat.outcome.kind).toBe('attached');
  });

  test('A FRESH PREFIX IS TOLD APART FROM A FOLDED ONE AT THE SAME OP, MOUNT AND PAYLOAD COST',
    async () => {
      // The classification `inventory()` used to answer. A fresh prefix reports
      // `empty`; a folded one reports `attached`; both pay two remote operations
      // and two mounts and read no payload, and neither is listed.
      //
      // THE TWO ROWS ARE NOT EQUAL, and the difference is named rather than
      // asserted away: a folded prefix has a `cursor.json` to read and a fresh
      // one does not, so `metadataBytes` differs by the size of that one control
      // object. Every other dimension is identical, which is the claim — nothing
      // here is a function of the tree.
      const fresh = await measureAttach(0, 0);
      const folded = await measureAttach(2_000, 7);

      expect(fresh.outcome.kind).toBe('empty');
      expect(folded.outcome.kind).toBe('attached');
      expect({ ...fresh.work, metadataBytes: 0 }).toEqual({ ...folded.work, metadataBytes: 0 });
      expect(fresh.work.metadataBytes).toBe(0);
      expect(folded.work.metadataBytes).toBeGreaterThan(0);
      expect(fresh.work).toMatchObject({
        serialRemoteOps: 2, totalRemoteOps: 2, payloadBytes: 0, cpuSteps: 0,
        mounts: 2, replayUnits: 0,
      });
    });

  test('ONLY THE PENDING DIMENSIONS MOVE WHEN THERE IS PENDING WORK', async () => {
    // The other half of the contract: recovery is O(pending change), so the
    // dimensions that describe pending work — the batch and blob reads, the
    // payload bytes, the replay units — are exactly the ones allowed to rise,
    // and they rise with the pending set rather than with the tree.
    const body = 'pending bytes a replay must read';
    const idle = await measureAttach(2_000, 7);
    const busy = await measureAttach(2_000, 7, [['pending.txt', body]]);

    expect(v.parse(RestoreWorkSchema, busy.work)).toEqual(busy.work);
    expect(busy.work.payloadBytes).toBe(body.length);
    expect(busy.work.replayUnits).toBe(1);
    // One batch decoded, one entry applied.
    expect(busy.work.cpuSteps).toBe(2);
    // Cursor, journal listing, the one pending batch, the one blob it names.
    expect(busy.work.totalRemoteOps).toBe(idle.work.totalRemoteOps + 2);
    // And the fixed dimensions did not move.
    expect(busy.work.mounts).toBe(idle.work.mounts);
    expect(busy.outcome.kind).toBe('attached');
  // Measured 3.2 s on a box at load 66-98 (2026-09-02 sweep, foreign mutation jobs on all
  // 24 threads), where bun's default 5 s bound read red and the test is green alone. A bound
  // on a finite run, stated with its measurement, not a detector.
  }, 15_000);
});
