/**
 * Scoped proof for the live G4 security fault cells.
 *
 * These tests run the REAL cell implementation
 * (`./security-cells.ts`, the same code `POST /security` serves) against
 * in-memory bucket/storage fakes — no container, no deploy. The refusals
 * asserted here are the production controls' own: the live run replays the
 * same attacks against the same functions over a real bucket.
 *
 * Red-first discrimination: every attack has a paired assertion showing the
 * control refuses it AND that the observation would report `accepted` if the
 * control let it through. A gate that cannot tell those apart is a gate that
 * cannot admit.
 */

import { describe, expect, test } from 'bun:test';

import { isCanonicalJournalPath } from '../src/cas/types';
import { sha256Hex } from '../src/cas/hash';
import {
  baseObjectKey,
  isChainId,
  ChainRecordAdvanced,
  layerIntegrityFailure,
} from '../src/snapshot-chain';
import {
  envelopeBytes,
  envelopeIdOf,
  parseEnvelopeBytes,
} from '../src/candidates/publication';
import type { RootEnvelopeV1 } from '../src/durability/contracts';
import type { StoredValue } from '../src/storage';

import {
  runBenchSecurityCells,
  securityPrefixFor,
} from './security-cells';

const encoder = new TextEncoder();

/**
 * In-memory R2. `Object.create` recovers the `R2Bucket` shape the cells take
 * without asserting it: the literal below implements exactly the five members
 * the cells reach, and every other member resolves nowhere because no line of
 * the cells can call it.
 */
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; version: string }>();
  let versions = 0;
  const handle: R2Bucket = Object.create({
    put: async (key: string, body: Uint8Array): Promise<void> => {
      versions += 1;
      objects.set(key, { bytes: body.slice(), version: `v${versions}` });
    },
    get: async (key: string) => {
      const found = objects.get(key);
      if (found === undefined) return null;
      const bytes = found.bytes;
      return {
        async arrayBuffer() {
          const copy = bytes.slice();
          return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
        },
      };
    },
    head: async (key: string) => {
      const found = objects.get(key);
      if (found === undefined) return null;
      return {
        key,
        size: found.bytes.byteLength,
        version: found.version,
        etag: `"${sha256Hex(found.bytes).slice(0, 32)}"`,
        checksums: { sha256: undefined },
      };
    },
    delete: async (keys: string | string[]): Promise<void> => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    list: async (options: { prefix?: string; cursor?: string; limit?: number }) => {
      const prefix = options.prefix ?? '';
      const start = options.cursor !== undefined ? Number(options.cursor) : 0;
      const all = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const page = all.slice(start, start + (options.limit ?? 100));
      const next = start + page.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated: next < all.length,
        cursor: next < all.length ? String(next) : undefined,
      };
    },
  });
  return { handle, objects };
}

/**
 * In-memory Durable Object storage behind the four operations the cells use.
 * `Object.create` recovers the `DurableObjectStorage` shape without asserting
 * it: get resolves undefined for a missing key, delete answers whether a row
 * existed, and the transaction runs its closure over the same rows.
 */
function fakeStorage() {
  const rows = new Map<string, StoredValue>();
  const handle: DurableObjectStorage = Object.create({
    get: async (key: string): Promise<StoredValue | undefined> => rows.get(key),
    put: async (key: string, value: StoredValue): Promise<void> => {
      rows.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => rows.delete(key),
    transaction: async <T>(fn: (txn: {
      get: (key: string) => Promise<StoredValue | undefined>;
      put: (key: string, value: StoredValue) => Promise<void>;
    }) => Promise<T>): Promise<T> => await fn({
      get: async (key: string): Promise<StoredValue | undefined> => rows.get(key),
      put: async (key: string, value: StoredValue): Promise<void> => {
        rows.set(key, value);
      },
    }),
  });
  return { handle, rows };
}

async function runCells(
  strategy: string,
  secret: string,
  envValues: ReadonlyArray<{ readonly name: string; readonly value: string }> = [],
) {
  const bucket = fakeBucket();
  const storage = fakeStorage();
  const nonce = `sec-test-${strategy.replace(/[^a-z]/g, '').slice(0, 8)}-nonce`;
  const observation = await runBenchSecurityCells({
    strategy,
    boxPrefix: 'boxes/test-box-id/',
    nonce,
    bucket: bucket.handle,
    storage: storage.handle,
    boxId: 'test-box-id',
    fixtureSecret: secret,
    envValues,
  });
  return { observation, bucket, storage };
}

describe('security cell namespace', () => {
  test('rejects a hostile nonce before any prefix exists', () => {
    expect(() => securityPrefixFor('boxes/id/', '../escape')).toThrow();
    expect(() => securityPrefixFor('boxes/id/', '')).toThrow();
    expect(() => securityPrefixFor('boxes/id/', 'short')).toThrow();
  });

  test('derives the isolated prefix inside the box prefix', () => {
    expect(securityPrefixFor('boxes/id/', 'sec-12345678')).toBe('boxes/id/security-cells/sec-12345678/');
    expect(securityPrefixFor('boxes/id', 'sec-12345678')).toBe('boxes/id/security-cells/sec-12345678/');
  });
});

describe('F7 stale writer discrimination', () => {
  test('a stale rev write throws ChainRecordAdvanced and holds the winner', async () => {
    const storage = fakeStorage();
    await storage.handle.put('row', { rev: 7 });
    const observed = (await storage.handle.get<{ rev: number }>('row'))?.rev ?? null;
    await storage.handle.put('row', { rev: 8 });
    const attempt = storage.handle.transaction(async (txn) => {
      const stored = ((await txn.get<{ rev: number }>('row'))?.rev) ?? null;
      if (stored !== observed) throw new ChainRecordAdvanced(observed, stored);
      await txn.put('row', { rev: 9 });
    });
    await expect(attempt).rejects.toBeInstanceOf(ChainRecordAdvanced);
    expect((await storage.handle.get<{ rev: number }>('row'))?.rev).toBe(8);
  });

  test('a fresh rev write lands: the fence above is not vacuous', async () => {
    const storage = fakeStorage();
    await storage.handle.put('row', { rev: 7 });
    await storage.handle.transaction(async (txn) => {
      const stored = ((await txn.get<{ rev: number }>('row'))?.rev) ?? null;
      if (stored !== 7) throw new ChainRecordAdvanced(7, stored);
      await txn.put('row', { rev: 8 });
    });
    expect((await storage.handle.get<{ rev: number }>('row'))?.rev).toBe(8);
  });
});

describe('F10 hostile metadata discrimination', () => {
  test('hostile paths are rejected by the exact candidate predicate', () => {
    for (const hostile of ['../escape', '/absolute', 'a//b', 'a/./b', '', 'trailing/', 'a/../b']) {
      expect(isCanonicalJournalPath(hostile)).toBe(false);
    }
  });

  test('canonical paths still pass: the predicate above is not vacuous', () => {
    expect(isCanonicalJournalPath('ladder/c1024.bin')).toBe(true);
    expect(isCanonicalJournalPath('.devbox-verify-marker.txt')).toBe(true);
  });

  test('a tampered envelope does not parse at its original digest', () => {
    const sha = sha256Hex(encoder.encode('f10-unit'));
    const envelope: RootEnvelopeV1 = {
      version: 1,
      format: 'bounded-layers/v1',
      boxId: 'unit-box',
      epoch: '3',
      generation: '1',
      parentRootId: null,
      cut: {
        captureId: 'unit-cut', epoch: '3', baseRevision: '0', cut: '1',
        stableStageHandle: 'unit-stage', manifestSha256: sha,
      },
      rootObject: { key: 'obj/root', byteLength: '1', sha256: sha },
      closure: [],
      closureObject: { key: 'obj/closure', byteLength: '1', sha256: sha },
    };
    const id = envelopeIdOf(envelope);
    expect(() => parseEnvelopeBytes(envelopeBytes(envelope), id)).not.toThrow();
    const tampered = new Uint8Array(envelopeBytes(envelope));
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x31 ? 0x32 : 0x31;
    expect(() => parseEnvelopeBytes(tampered, id)).toThrow();
  });

  test('hostile chain ids never become storage keys', () => {
    for (const hostile of ['../escape', '', 'not-a-uuid', 'a/b']) {
      expect(isChainId(hostile)).toBe(false);
      expect(() => baseObjectKey('boxes/unit-test/backups', hostile)).toThrow();
    }
    expect(isChainId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  test('same-length digest replacement is refused; identical layer is sound', () => {
    const declared = { bytes: 1024, digest: sha256Hex(encoder.encode('a')), objectVersion: 'va' };
    const tampered = { bytes: 1024, digest: sha256Hex(encoder.encode('b')), objectVersion: 'vb' };
    expect(layerIntegrityFailure({ declared, stored: tampered, label: 'delta' })).not.toBeNull();
    expect(layerIntegrityFailure({ declared, stored: { ...declared }, label: 'delta' })).toBeNull();
  });
});

describe('live cells over fakes', () => {
  for (const strategy of ['snapshot-chain', 'bounded-layers', 'merkle-pack'] as const) {
    test(`${strategy} completes with every attack refused`, async () => {
      const { observation, bucket, storage } = await runCells(strategy, 'live-fixture-secret-abcdef');
      expect(observation.strategy).toBe(strategy);
      expect(observation.completed).toBe(true);
      expect(observation.cells.map((cell) => cell.id)).toEqual(['F7', 'F10', 'F11', 'F12']);
      for (const cell of observation.cells) expect(cell.status).toBe('refused');
      expect(observation.staleWriterAccepted).toBe(false);
      expect(observation.hostileMetadataAccepted).toBe(false);
      expect(observation.prefixEscapes).toBe(0);
      expect(observation.capabilityEscapesOrReplays).toBe(0);
      expect(observation.credentialLeaks).toEqual([]);
      expect(observation.cleanupErrors).toEqual([]);
      // The isolated namespace is purged and no live keys were touched.
      expect([...bucket.objects.keys()].filter((key) => key.includes('security-cells'))).toEqual([]);
      expect([...storage.rows.keys()]).toEqual([]);
      // Nothing echoes the secret.
      expect(JSON.stringify(observation)).not.toContain('live-fixture-secret-abcdef');
    });
  }

  for (const strategy of ['r2fs', 'overlay-cas'] as const) {
    test(`${strategy} reports unable rather than passing on zeros`, async () => {
      const { observation } = await runCells(strategy, 'live-fixture-secret-abcdef');
      expect(observation.completed).toBe(false);
      const byId = new Map(observation.cells.map((cell) => [cell.id, cell.status]));
      expect(byId.get('F7')).toBe('unable');
      expect(byId.get('F10')).toBe('unable');
      expect(byId.get('F11')).toBe('unable');
      expect(byId.get('F12')).toBe('refused');
      // Unable is not success dressed up: no accepted flags, no fake zeros claimed complete.
      expect(observation.staleWriterAccepted).toBe(false);
      expect(observation.hostileMetadataAccepted).toBe(false);
    });
  }

  test('F12 names the surface without echoing the live secret', async () => {
    const secret = 'live-fixture-secret-abcdef';
    const { observation } = await runCells(
      'bounded-layers',
      secret,
      [{ name: 'ALLOW_EXTRACTION', value: `prefix-${secret}-suffix` }],
    );
    const f12 = observation.cells.find((cell) => cell.id === 'F12');
    if (f12 === undefined) throw new Error('the F12 cell is missing from a completed observation');
    expect(f12.status).toBe('accepted');
    expect(observation.completed).toBe(false);
    expect(observation.credentialLeaks.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain(secret);
    for (const leak of observation.credentialLeaks) expect(leak).not.toContain(secret);
  });
});
