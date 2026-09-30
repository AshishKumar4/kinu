import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { PublishWorkSchema, RestoreWorkSchema } from '../src/durability/contracts';

describe('the durability wire contracts', () => {
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
});
