import { expect, test } from 'bun:test';
import {
  STORAGE_CACHE_CASES,
  STORAGE_CHANGE_CASES,
  STORAGE_CLEANUP_GATES,
  STORAGE_FAULTS,
  STORAGE_GATES,
  STORAGE_STAGES,
  STORAGE_TREE_CASES,
} from './fixtures/storage-matrix/manifest';

const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map(row => row.id);

test('the storage experiment vocabulary is complete and collision-free', () => {
  expect(ids(STORAGE_TREE_CASES)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
  expect(ids(STORAGE_CHANGE_CASES)).toEqual([
    'C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10',
  ]);
  expect(ids(STORAGE_CACHE_CASES)).toEqual(['K0', 'K1', 'K2', 'K3']);
  expect(ids(STORAGE_FAULTS)).toEqual(Array.from({ length: 16 }, (_, at) => `F${at}`));
  expect(ids(STORAGE_GATES)).toEqual(Array.from({ length: 10 }, (_, at) => `G${at}`));
  expect(ids(STORAGE_CLEANUP_GATES)).toEqual(Array.from({ length: 7 }, (_, at) => `C${at + 1}`));
  for (const rows of [
    STORAGE_TREE_CASES,
    STORAGE_CHANGE_CASES,
    STORAGE_CACHE_CASES,
    STORAGE_FAULTS,
    STORAGE_GATES,
    STORAGE_CLEANUP_GATES,
    STORAGE_STAGES,
  ]) expect(new Set(ids(rows)).size).toBe(rows.length);
});

test('the staged plan names best representative adversarial and scaling evidence separately', () => {
  expect(ids(STORAGE_STAGES)).toEqual([
    'platform', 'blank', 'best', 'representative', 'adversarial', 'scaling', 'confirmatory',
  ]);
  expect(STORAGE_STAGES.find(stage => stage.id === 'best')?.trees).toEqual(['T1']);
  expect(STORAGE_STAGES.find(stage => stage.id === 'representative')?.trees).toEqual(['T2']);
  expect(STORAGE_STAGES.find(stage => stage.id === 'adversarial')?.trees)
    .toEqual(['T3', 'T4', 'T5']);
  const scaling = STORAGE_STAGES.find(stage => stage.id === 'scaling');
  if (scaling === undefined) throw new Error('scaling stage is absent');
  expect(scaling.scales).toEqual({
    pending: [0, 1, 16, 256, 4096, 4097],
    history: [1, 100, 10_000],
  });
});
