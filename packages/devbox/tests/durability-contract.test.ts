import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import {
  DURABILITY_OPERATION_PHASES,
  PayloadGrantSchema,
  PublishWorkSchema,
  RangeReadIntentSchema,
  RestoreWorkSchema,
  UploadIntentSchema,
} from '../src/durability/contracts';

const SHA = 'a'.repeat(64);

const KEY = 'v1/boxes/box/attempts/op/try/data-a';

describe('the durability wire contracts', () => {
  test('counters and digests refuse unsafe representations', () => {
    // A negative byte count is unrepresentable, so it is refused at the
    // boundary rather than read as a huge unsigned length downstream.
    expect(() => v.parse(UploadIntentSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-1',
      boxId: 'box-1',
      epoch: '7',
      exactKey: KEY,
      method: 'PUT',
      byteLength: '-1',
      sha256: SHA,
      expiresAt: '100',
    })).toThrow('Expected a canonical non-negative decimal string');
    // A leading zero is a second spelling of one number: two instruments that
    // compare intents byte for byte would disagree about identical requests.
    expect(() => v.parse(UploadIntentSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-1',
      boxId: 'box-1',
      epoch: '01',
      exactKey: KEY,
      method: 'PUT',
      byteLength: '12',
      sha256: SHA,
      expiresAt: '100',
    })).toThrow('Expected a canonical non-negative decimal string');
    // A truncated digest cannot authenticate anything, so it never parses.
    expect(() => v.parse(UploadIntentSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-1',
      boxId: 'box-1',
      epoch: '7',
      exactKey: KEY,
      method: 'PUT',
      byteLength: '12',
      sha256: 'short',
      expiresAt: '100',
    })).toThrow('Expected a lowercase SHA-256 digest');
    // An empty id names nothing, and the id is what binds an intent to the
    // attempt it may be replayed against.
    expect(() => v.parse(UploadIntentSchema, {
      operationId: '',
      attemptId: 'attempt-1',
      boxId: 'box-1',
      epoch: '7',
      exactKey: KEY,
      method: 'PUT',
      byteLength: '12',
      sha256: SHA,
      expiresAt: '100',
    })).toThrow('Invalid length: Expected >=1 but received 0');
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
      exactKey: KEY,
      method: 'PUT',
      byteLength: '12',
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
    expect(() => v.parse(UploadIntentSchema, { ...intent, method: 'GET' }))
      .toThrow('Invalid type: Expected "PUT" but received "GET"');
  });

  test('range reads carry exact re-drive coordinates', () => {
    expect(v.parse(RangeReadIntentSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-2',
      boxId: 'box-1',
      epoch: '7',
      exactKey: KEY,
      method: 'GET',
      byteOffset: '4096',
      byteLength: '8192',
      sha256: SHA,
      expiresAt: '100',
    }).byteOffset).toBe('4096');
    // A read intent is a GET and an upload intent is a PUT: one shape cannot
    // stand in for the other, which is what makes a replayed intent safe.
    expect(() => v.parse(RangeReadIntentSchema, {
      operationId: 'op-1',
      attemptId: 'attempt-2',
      boxId: 'box-1',
      epoch: '7',
      exactKey: KEY,
      method: 'PUT',
      byteOffset: '4096',
      byteLength: '8192',
      sha256: SHA,
      expiresAt: '100',
    })).toThrow('Invalid type: Expected "GET" but received "PUT"');
  });

  test('a publish row accepts safe counts and refuses unsafe counts or extra state', () => {
    const row = { objectsPut: 3, bytesPut: 4096, casAttempts: 1 };
    expect(v.parse(PublishWorkSchema, row)).toEqual(row);
    expect(() => v.parse(PublishWorkSchema, { ...row, objectsPut: 1.5 }))
      .toThrow('Invalid safe integer: Received 1.5');
    expect(() => v.parse(PublishWorkSchema, { ...row, bytesPut: -1 }))
      .toThrow('Invalid value: Expected >=0 but received -1');
    // A row that carries a field nobody counted is a row two readers disagree
    // about, so the shape is strict rather than tolerant.
    expect(() => v.parse(PublishWorkSchema, { ...row, closureWalks: 1 }))
      .toThrow('Invalid key: Expected never but received "closureWalks"');
  });

  test('durable operation phases contain no response-only acknowledgement state', () => {
    expect(DURABILITY_OPERATION_PHASES).toEqual([
      'intent', 'transferring', 'sealed', 'completion-pending', 'published', 'failed',
    ]);
  });
});
