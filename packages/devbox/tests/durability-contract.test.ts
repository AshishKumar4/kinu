import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
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

const SHA = 'a'.repeat(64);
const object = { key: 'v1/boxes/box/attempts/op/try/data-a', byteLength: '12', sha256: SHA };

describe('durability v1 wire contracts', () => {
  test('a closed root envelope has one canonical immutable reference vocabulary', () => {
    expect(v.parse(RootEnvelopeV1Schema, {
      version: 1,
      format: 'merkle-pack/v1',
      boxId: 'box-1',
      epoch: '7',
      generation: '9',
      parentRootId: null,
      cut: '42',
      rootObject: object,
    })).toEqual({
      version: 1,
      format: 'merkle-pack/v1',
      boxId: 'box-1',
      epoch: '7',
      generation: '9',
      parentRootId: null,
      cut: '42',
      rootObject: object,
    });
  });

  test('wire counters and digests refuse unsafe representations', () => {
    expect(() => v.parse(ImmutableObjectRefSchema, { ...object, byteLength: '-1' })).toThrow();
    expect(() => v.parse(ImmutableObjectRefSchema, { ...object, sha256: 'short' })).toThrow();
    expect(() => v.parse(RootEnvelopeV1Schema, {
      version: 1,
      format: 'merkle-pack/v1',
      boxId: 'box-1',
      epoch: '01',
      generation: '9',
      parentRootId: null,
      cut: '42',
      rootObject: object,
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
      'intent', 'transferring', 'sealed', 'published', 'failed',
    ]);
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
