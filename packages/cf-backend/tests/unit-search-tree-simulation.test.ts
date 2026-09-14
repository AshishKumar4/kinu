// The landing hero's search tree, as a simulation: what the picture claims
// about search must hold in the numbers before any renderer draws them.
import { describe, expect, test } from 'bun:test';

import {
  NODE_STRIDE, SearchTree, STROKE_STRIDE, TONE_ASH, TONE_EMBER, type SearchTreeFrame,
} from '@kinu.run/core/web/hero-art';

const ASPECT = 700 / 1280;

const DT = 1 / 60;

function run(seed: number, seconds: number, tree = new SearchTree({ seed, aspect: ASPECT })): SearchTree {
  const steps = Math.round(seconds / DT);

  for (let index = 0; index < steps; index += 1) tree.step(DT);

  return tree;
}

function strokesOf(frame: SearchTreeFrame): number[][] {
  const rows: number[][] = [];

  for (let index = 0; index < frame.count; index += 1) {
    rows.push([...frame.strokes.subarray(index * STROKE_STRIDE, (index + 1) * STROKE_STRIDE)]);
  }

  return rows;
}

describe('the search tree grows deterministically', () => {
  test('one seed and one step sequence give byte-identical frames', () => {
    const first = run(417, 9).frame();
    const second = run(417, 9).frame();

    expect(first.count).toBeGreaterThan(20);
    expect(first.count).toBe(second.count);
    expect(first.nodeCount).toBe(second.nodeCount);
    expect(strokesOf(first)).toEqual(strokesOf(second));
    expect([...first.nodes.subarray(0, first.nodeCount * NODE_STRIDE)]).toEqual([...second.nodes.subarray(0, second.nodeCount * NODE_STRIDE)]);
  });

  test('another seed grows another tree', () => {
    const first = run(417, 6).frame();
    const second = run(418, 6).frame();

    expect(strokesOf(first)).not.toEqual(strokesOf(second));
  });

  test('the frame carries three layers, and every stroke sits inside the view', () => {
    const frame = run(417, 12).frame();
    const layers = new Set(strokesOf(frame).map((row) => row[11]));

    expect([...layers].sort()).toEqual([0, 1, 2]);

    for (const row of strokesOf(frame)) {
      const [, y0, , , , y1, t, width, glow, , alpha] = row;
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeLessThanOrEqual(1);
      expect(y1).toBeGreaterThanOrEqual(0);
      expect(y1).toBeLessThanOrEqual(1);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      expect(width).toBeGreaterThan(0);
      expect(glow).toBeGreaterThanOrEqual(0);
      expect(glow).toBeLessThanOrEqual(1);
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThanOrEqual(1);
    }
  });
});

describe('the search prunes what scores below the frontier', () => {
  test('pruned branches leave the living set and are counted, descendants with them', () => {
    const tree = run(417, 8);
    const frame = tree.frame();

    expect(frame.pruned).toBeGreaterThan(3);
    expect(frame.hidden).toBeGreaterThan(0);
    const living = tree.living();
    const alive = living.filter((branch) => branch.phase === 'alive' || branch.phase === 'growing');
    const best = Math.max(...alive.map((branch) => branch.value));

    // Nothing alive past its grace period trails the best result by the margin.
    for (const branch of alive) {
      if (branch.phase !== 'alive' || branch.age < 2) continue;
      expect(branch.value).toBeGreaterThanOrEqual(best - 0.4 - 1e-9);
    }
  });

  test('a cut branch dims to an ember, then to ash, then leaves', () => {
    const tree = run(417, 6);
    const phases = new Set(tree.living().map((branch) => branch.phase));

    expect(phases.has('ember') || phases.has('ash')).toBeTrue();
    const tones = new Set(strokesOf(tree.frame()).map((row) => row[9]));

    expect(tones.has(TONE_EMBER) || tones.has(TONE_ASH)).toBeTrue();
    const before = tree.living().filter((branch) => branch.phase === 'ash').map((branch) => branch.id);

    run(417, 9, tree);
    const after = new Set(tree.living().map((branch) => branch.id));

    for (const id of before) expect(after.has(id)).toBeFalse();
  });
});

describe('the best path is the kept lineage', () => {
  test('backed-up value never falls along the best path, and it ends at the best score', () => {
    for (const seed of [1, 417, 9001]) {
      const tree = run(seed, 10);
      const path = tree.bestPath();

      expect(path.length).toBeGreaterThan(2);
      let previous = Number.NEGATIVE_INFINITY;

      for (const id of path) {
        const node = tree.inspect(id);

        if (node === undefined) throw new Error(`path names ${String(id)}, which the tree does not hold`);
        expect(node.value).toBeGreaterThanOrEqual(previous);
        previous = node.value;
      }

      const tip = tree.inspect(path[path.length - 1] ?? -1);
      const living = tree.living().filter((branch) => branch.phase === 'alive' || branch.phase === 'growing');

      expect(tip?.score).toBe(Math.max(...living.map((branch) => branch.value)));
    }
  });

  test('the evolution restart keeps the best path as a prefix and grows past it', () => {
    const tree = run(417, 10);
    const before = tree.bestPath();

    tree.evolve();
    const frame = tree.frame();

    expect(frame.generation).toBe(1);

    // The kept lineage is still whole the instant everything else goes to ember.
    expect(tree.bestPath()).toEqual(before);

    run(417, 6, tree);
    const after = tree.bestPath();

    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  test('the loop restarts on its own after a generation', () => {
    const tree = run(417, 27);

    expect(tree.frame().generation).toBeGreaterThanOrEqual(1);
  });
});

describe('the pointer bends the picture without touching the search', () => {
  test('displacement is bounded by the declared bend and the random stream is untouched', () => {
    const still = run(417, 5);
    const bent = run(417, 5);

    bent.setPointer(0.45, 0.5);

    for (let index = 0; index < 120; index += 1) {
      still.step(DT);
      bent.step(DT);
    }

    const stillRows = strokesOf(still.frame());
    const bentRows = strokesOf(bent.frame());

    expect(bentRows.length).toBe(stillRows.length);
    let moved = 0;

    for (let index = 0; index < stillRows.length; index += 1) {
      const a = stillRows[index];
      const b = bentRows[index];

      if (a === undefined || b === undefined) throw new Error('stroke rows diverged');
      const dx = (b[4] ?? 0) - (a[4] ?? 0);
      const dy = (b[5] ?? 0) - (a[5] ?? 0);
      const shift = Math.sqrt(dx * dx + dy * dy);

      // A tip moves by its own bend; the background layers also drift by parallax.
      expect(shift).toBeLessThanOrEqual(SearchTree.pointer.maxBend + 0.03 + 1e-6);

      if (shift > 1e-4) moved += 1;
      // Score, tone, and lifecycle are the search's, not the pointer's.
      expect(b[9]).toBe(a[9] ?? -1);
    }

    expect(moved).toBeGreaterThan(0);
  });

  test('a tap plants a new attempt at the nearest frontier', () => {
    const tree = run(417, 4);
    const before = tree.living().length;

    tree.plant(0.6, 0.5);
    expect(tree.living().length).toBe(before + 1);
  });
});
