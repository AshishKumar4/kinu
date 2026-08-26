import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  EMPTY_REGISTRY, MAX_CV, coefficientOfVariation, groupByCase, latinSquareOrders,
  latinSquareValid, loadConfirmatoryPlan, registerPilot, renderCaseSections, scoreCells,
  type MeasuredCell,
} from './fixtures/storage-matrix/protocol';

const representative: MeasuredCell = {
  id: { stage: 'representative', tree: 'T2', change: 'C4', cache: 'K2' },
  values: [100, 105],
  wallMs: 1_000,
};

describe('paired order and censoring protocol', () => {
  test('uses a Latin square so every arm occupies every ordinal position once', () => {
    const orders = latinSquareOrders(['chain', 'r2fs', 'overlay']);
    expect(orders).toEqual([
      ['chain', 'r2fs', 'overlay'],
      ['r2fs', 'overlay', 'chain'],
      ['overlay', 'chain', 'r2fs'],
    ]);
    expect(latinSquareValid(orders)).toBe(true);
  });

  test('rejects a Latin-square input with duplicate arms', () => {
    expect(() => latinSquareOrders(['chain', 'chain'])).toThrow('distinct arms');
  });

  test('censors an unstable or over-budget cell instead of assigning a score', () => {
    expect(coefficientOfVariation([100, 105])).toBeLessThan(MAX_CV);
    const [stable, noisy, slow] = scoreCells([
      representative,
      { ...representative, values: [1, 100] },
      { ...representative, wallMs: 1_001 },
    ], 1_000);
    expect(stable?.censored).toBe(false);
    expect(noisy?.censored).toBe(true);
    expect(noisy?.censorReason).toContain('CV');
    expect(slow?.censored).toBe(true);
    expect(slow?.censorReason).toContain('exceeded budget');
  });
});

describe('pilot and confirmatory registration', () => {
  test('registers pilots as explicitly non-ranking', () => {
    const registry = registerPilot(EMPTY_REGISTRY, 'pilot-20260825', '2026-08-25T00:00:00.000Z');
    expect(registry.pilots).toEqual([{ id: 'pilot-20260825', registeredAt: '2026-08-25T00:00:00.000Z', ranking: false }]);
    expect(() => registerPilot(registry, 'pilot-20260825', '2026-08-25T01:00:00.000Z')).toThrow('already registered');
  });

  test('loads the frozen confirmatory input and rejects a non-manifest case id', () => {
    const path = new URL('./fixtures/storage-matrix/confirmatory-plan.json', import.meta.url);
    const plan = loadConfirmatoryPlan(readFileSync(path, 'utf8'));
    expect(plan.schema).toBe('storage-matrix/confirmatory@1');
    expect(plan.cells.every((cell) => cell.stage === 'representative')).toBe(true);
    expect(() => loadConfirmatoryPlan(JSON.stringify({
      ...plan,
      cells: [{ tree: 'T99', change: 'C4', cache: 'K2' }],
    }))).toThrow('unknown tree');
  });
});

test('reports cases in separate sections and never constructs a pooled case', () => {
  const rows = [
    { case: 'best', value: 1 },
    { case: 'representative', value: 5 },
    { case: 'best', value: 2 },
  ];
  const groups = groupByCase(rows, (row) => row.case);
  expect(groups.get('best')).toEqual([{ case: 'best', value: 1 }, { case: 'best', value: 2 }]);
  expect(groups.get('representative')).toEqual([{ case: 'representative', value: 5 }]);
  expect(renderCaseSections(rows, (row) => row.case, (name, cells) => [
    `${name}: ${cells.map((cell) => cell.value).join(',')}`,
  ])).toEqual([
    '#### Case: best', '', 'best: 1,2', '',
    '#### Case: representative', '', 'representative: 5', '',
  ]);
});
