import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
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
  RootEnvelopeV1,
} from '../src/durability/contracts';

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
