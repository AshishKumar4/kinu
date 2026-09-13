import { expect, test } from 'bun:test';
import { boundedAttachErrors, CELL_STARTUP_MS, chunkedPublicationErrors, storageAttachMilliseconds } from './bench-devbox-block-attach';

test('startup observation is finite for the bounded storage cells', () => {
  expect(CELL_STARTUP_MS).toBe(55000);
});

test('the attach clock subtracts admission and refuses absent or reversed phases', () => {
  expect(storageAttachMilliseconds({ containerStart: 800, attached: 3100 })).toBe(2300);
  expect(storageAttachMilliseconds({ attached: 3100 })).toBeNull();
  expect(storageAttachMilliseconds({ containerStart: 3100, attached: 800 })).toBeNull();
});

test('zero-payload evidence must be observed and a red measurement stays red', () => {
  const sample = { phases: { containerStart: 800, attached: 3100 }, blockReads: { generation: 'named', payloadBytes: 0, indexPages: 0, readRequests: 0 } };
  expect(boundedAttachErrors(sample)).toEqual([]);
  expect(boundedAttachErrors({ ...sample, blockReads: null })).toContain('block payload counters were not observed');
  expect(boundedAttachErrors({ ...sample, blockReads: { ...sample.blockReads, payloadBytes: 1 } })).toContain('attach read a payload or override-index page');
  expect(boundedAttachErrors({ ...sample, blockReads: { ...sample.blockReads, indexPages: 1 } })).toContain('attach read a payload or override-index page');
  expect(boundedAttachErrors({ ...sample, phases: { containerStart: 0, attached: 30001 } })).toContain('storage attach exceeded 30 seconds: 30001 ms');
});

test('a cell expecting chunked names a format fallback instead of accepting a whole upper', () => {
  expect(chunkedPublicationErrors({ deltaFormat: 'chunked' })).toEqual([]);
  expect(chunkedPublicationErrors({ deltaFallback: { reason: 'block-hash-failed', detail: '0/131072 blocks' } }))
    .toEqual(['expected deltaFormat:chunked; block-hash-failed: 0/131072 blocks']);
  expect(chunkedPublicationErrors({})).toEqual(['expected deltaFormat:chunked; fallback reason unobserved']);
  expect(chunkedPublicationErrors(null)).toEqual(['expected deltaFormat:chunked; fallback reason unobserved']);
});
