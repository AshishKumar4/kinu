import { expect, test } from 'bun:test';

import { buildDeltaIndex, lookupDeltaIndex, type DeltaOverride } from '../src/delta-index';
import { DeltaManifestSchema, mergeDeltaPublication, readDeltaIndex, type DeltaManifest, type DeltaPlan } from '../src/chunked-delta';
import * as v from 'valibot';

test('an override resolves through bounded authenticated pages, not an inline map', () => {
  const entries: DeltaOverride[] = Array.from({ length: 1023 }, (_, i) => ({ o: i * 32768, src: 'hole' }));
  const built = buildDeltaIndex(entries, 1023 * 32768);
  let pages = 0;

  const read = (offset: number, length: number): Uint8Array => {
    pages += 1;
    expect(length).toBe(128);

    return built.bytes.subarray(offset, offset + length);
  };

  expect(lookupDeltaIndex(built.ref, 1023 * 32768, 0, read)).toEqual({ o: 0, src: 'hole' });
  expect(pages).toBeLessThanOrEqual(10);
  pages = 0;
  expect(lookupDeltaIndex(built.ref, 1023 * 32768, 16384, read)).toBeNull();
  expect(pages).toBeLessThanOrEqual(10);
});

test('corruption cannot become a missing override, and publication refuses duplicate and misaligned offsets', () => {
  const entries: DeltaOverride[] = [{ o: 0, src: 'hole' }, { o: 32768, src: 'chunk', d: 'a'.repeat(64) }];
  const built = buildDeltaIndex(entries, 65536);
  expect(readDeltaIndex(built.ref, 65536, built.bytes)).toEqual(entries);
  const corrupt = built.bytes.slice();
  corrupt[128] = 1;
  expect(() => lookupDeltaIndex(built.ref, 65536, 0, (o, len) => corrupt.subarray(o, o + len))).toThrow('corrupt');
  expect(() => buildDeltaIndex([{ o: 0, src: 'hole' }, { o: 0, src: 'hole' }], 65536)).toThrow('offset');
  expect(() => buildDeltaIndex([{ o: 1, src: 'hole' }], 65536)).toThrow('offset');
  expect(() => buildDeltaIndex([{ o: 65536, src: 'hole' }], 65536)).toThrow('offset');
  expect(() => readDeltaIndex(built.ref, 65536, built.bytes.subarray(1))).toThrow('corrupt');
});

test('manifest v2 refuses v1 and hostile paths and keeps index bytes outside the attach record', () => {
  const manifest: DeltaManifest = { v: 2, files: [], dirs: [], deleted: [], treplace: [], links: [] };
  expect(v.safeParse(DeltaManifestSchema, { ...manifest, v: 1 }).success).toBe(false);

  for (const p of ['/abs', 'a/../b', './b', 'a//b', 'a\0b']) {
    expect(v.safeParse(DeltaManifestSchema, { ...manifest, deleted: [p] }).success).toBe(false);
  }

  const lengths: number[] = [];

  for (const count of [4, 65536]) {
    const index = buildDeltaIndex(Array.from({ length: count }, (_, i) => ({ o: i * 16384, src: 'hole' })), count * 16384);
    lengths.push(JSON.stringify({ ...manifest, files: [{ kind: 'chunked', p: 'file', s: count * 16384, mode: 420, uid: 0, gid: 0, over: index.ref }] }).length);
  }

  expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(20);
});

test('publishing after attach merges retained records and replaces only upper names', () => {
  const retained: DeltaManifest = { v: 2, files: [{ kind: 'whole', p: 'keep', s: 10 }, { kind: 'whole', p: 'dir/old', s: 20 }],
    dirs: [{ p: 'dir', mode: 493, uid: 0, gid: 0 }], deleted: ['gone'], treplace: [], links: [] };

  const plan: DeltaPlan = { manifest: { v: 2, files: [{ kind: 'whole', p: 'dir', s: 4 }], dirs: [], deleted: [], treplace: ['dir'], links: [] },
    chunks: new Map(), indexes: new Map() };

  const merged = mergeDeltaPublication(plan, retained, new Map(), '/side');
  expect(merged.manifest.files.map(file => file.p)).toEqual(['dir', 'keep']);
  expect(merged.manifest.dirs).toEqual([]);
  expect(merged.manifest.deleted).toEqual(['gone']);
  expect(merged.retainedFiles?.get('keep')).toBe('/side/.devbox-delta/tree/keep');
});

test('opaque directory records replace retained descendants and remain opaque on later edits', () => {
  const retained: DeltaManifest = { v: 2,
    files: [{ kind: 'whole', p: 'keep', s: 1 }, { kind: 'whole', p: 'dir/stale', s: 1 }],
    dirs: [{ p: 'dir', mode: 493, uid: 0, gid: 0 }], deleted: ['dir/old'], treplace: [], links: [] };

  const next: DeltaPlan = { manifest: { v: 2, files: [{ kind: 'whole', p: 'dir/new', s: 1 }],
    dirs: [{ p: 'dir', mode: 493, uid: 0, gid: 0, opaque: true }], deleted: [], treplace: [], links: [] },
    chunks: new Map(), indexes: new Map() };

  const replaced = mergeDeltaPublication(next, retained, new Map(), '/side');
  expect(replaced.manifest.files.map(file => file.p)).toEqual(['dir/new', 'keep']);
  expect(replaced.manifest.deleted).toEqual([]);

  const edited: DeltaPlan = { ...next, manifest: { ...next.manifest,
    files: [{ kind: 'whole', p: 'dir/later', s: 1 }], dirs: [{ p: 'dir', mode: 448, uid: 1, gid: 1 }] } };

  const merged = mergeDeltaPublication(edited, replaced.manifest, new Map(), '/side');
  expect(merged.manifest.files.map(file => file.p)).toEqual(['dir/later', 'dir/new', 'keep']);
  expect(merged.manifest.dirs).toEqual([{ p: 'dir', mode: 448, uid: 1, gid: 1, opaque: true }]);

  const root: DeltaPlan = { ...next, manifest: { ...next.manifest,
    dirs: [{ p: '', mode: 493, uid: 0, gid: 0, opaque: true }, ...next.manifest.dirs] } };

  expect(mergeDeltaPublication(root, retained, new Map(), '/side').manifest.files.map(file => file.p)).toEqual(['dir/new']);
  expect(v.safeParse(DeltaManifestSchema, root.manifest).success).toBe(true);
  expect(v.safeParse(DeltaManifestSchema, { ...root.manifest, dirs: [{ p: '', mode: 493, uid: 0, gid: 0 }] }).success).toBe(false);
});
