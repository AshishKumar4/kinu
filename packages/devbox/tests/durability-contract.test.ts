import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  DURABILITY_AWAIT_POINTS,
  ImmutableObjectRefSchema,
  ObjectReceiptSchema,
  RestoreWorkSchema,
  RootEnvelopeV1Schema,
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

  test('the reset fault register has one unique name per external await', () => {
    expect(new Set(DURABILITY_AWAIT_POINTS).size).toBe(DURABILITY_AWAIT_POINTS.length);
    expect(DURABILITY_AWAIT_POINTS).toContain('publish-head');
    expect(DURABILITY_AWAIT_POINTS).toContain('delete-retired-object');
    expect(DURABILITY_AWAIT_POINTS).toContain('cleanup-resource');
  });
});
