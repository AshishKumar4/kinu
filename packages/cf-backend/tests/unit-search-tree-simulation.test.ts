// The landing hero's search tree, as a simulation: what the picture claims
// about search must hold in the numbers before any renderer draws them.
import { describe, expect, test } from 'bun:test';

import { type KeepOut, NODE_STRIDE, PULSE_STRIDE, STROKE_STRIDE, TONE_ASH, TONE_BRIGHT, TONE_EMBER } from '@kinu.run/core/web/art';
import { SearchTree, type SearchTreeFrame } from '@kinu.run/core/web/hero-art';

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

    expect([...layers].sort((a, b) => a - b)).toEqual([0, 1, 2]);

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

/** A branch's world endpoints never move after it spawns, and without a
 *  pointer nothing shifts in y, so a stroke keeps one key across frames. */
function keyedStrokes(frame: SearchTreeFrame): Map<string, number[]> {
  const rows = new Map<string, number[]>();

  for (const row of strokesOf(frame)) rows.set(`${String(row[11])}|${String(row[1])}|${String(row[5])}`, row);

  return rows;
}

describe('the camera follows the frontier smoothly', () => {
  test('no stroke moves more than the pan speed allows in one frame, through prunes and a restart', () => {
    const tree = new SearchTree({ seed: 417, aspect: ASPECT });
    let previous = keyedStrokes(tree.frame());
    let widestShift = 0;
    let widestAlphaJump = 0;
    let widestWidthJump = 0;
    let restarts = 0;

    for (let index = 0; index < 60 * 40; index += 1) {
      tree.step(DT);
      const frame = tree.frame();
      const current = keyedStrokes(frame);

      for (const [key, row] of current) {
        const before = previous.get(key);

        if (before === undefined) continue;
        const dx = (row[4] ?? 0) - (before[4] ?? 0);
        const dy = ((row[5] ?? 0) - (before[5] ?? 0)) * ASPECT;
        widestShift = Math.max(widestShift, Math.hypot(dx, dy));
        widestAlphaJump = Math.max(widestAlphaJump, Math.abs((row[10] ?? 0) - (before[10] ?? 0)));
        widestWidthJump = Math.max(widestWidthJump, Math.abs((row[7] ?? 0) - (before[7] ?? 0)));
      }

      restarts = Math.max(restarts, frame.generation);
      previous = current;
    }

    // The run crossed a restart of every layer and pruned along the way.
    expect(restarts).toBeGreaterThanOrEqual(1);
    expect(tree.frame().pruned).toBeGreaterThan(3);
    // The camera's speed is capped, so in one frame the picture moves at most that far.
    expect(widestShift).toBeLessThanOrEqual(SearchTree.pan.maxSpeed * DT + 1e-6);
    // A restart or a prune fades a branch; it never cuts it in one frame.
    expect(widestAlphaJump).toBeLessThanOrEqual(0.05);
    expect(widestWidthJump).toBeLessThanOrEqual(0.15);
  });

  test('the camera and the fades are deterministic', () => {
    const first = run(417, 30).frame();
    const second = run(417, 30).frame();

    expect(strokesOf(first)).toEqual(strokesOf(second));
  });
});

describe('the tree keeps out of the headline', () => {
  /** The headline's band at 1440×900: the shell's copy from 6% to 69% across, the top quarter to the middle. */
  const HEADLINE: KeepOut = { left: 0.06, top: 0.2, right: 0.69, bottom: 0.475 };

  /** The foreground's best node: the frame marks it by its radius, wider than a tip and narrower than the seed. */
  const BEST_RADIUS = 3.2 * 1.25;

  function inside(x: number, y: number, box: KeepOut): boolean {
    return x > box.left && x < box.right && y > box.top && y < box.bottom;
  }

  /** Over a run through a restart: how many tips were spawned inside the
   *  box (a stroke's first frame is its spawn, one frame of pan at most
   *  behind), how many frames found the best node inside it, and how many
   *  tips were spawned at all. */
  function watch(tree: SearchTree, seconds: number, box: KeepOut) {
    let previous = keyedStrokes(tree.frame());
    let spawnedInside = 0;
    let bestInside = 0;
    let spawned = 0;

    for (let index = 0; index < seconds * 60; index += 1) {
      tree.step(DT);
      const frame = tree.frame();
      const current = keyedStrokes(frame);

      for (const [key, row] of current) {
        if (previous.has(key)) continue;
        spawned += 1;

        if (inside(row[4] ?? 0, row[5] ?? 0, box)) spawnedInside += 1;
      }

      for (let node = 0; node < frame.nodeCount; node += 1) {
        const at = node * NODE_STRIDE;

        if (frame.nodes[at + 6] !== 0 || Math.abs((frame.nodes[at + 2] ?? 0) - BEST_RADIUS) > 1e-6) continue;

        if (inside(frame.nodes[at] ?? 0, frame.nodes[at + 1] ?? 0, box)) bestInside += 1;
      }

      previous = current;
    }

    return { spawnedInside, bestInside, spawned, generation: tree.frame().generation };
  }

  /** Where the unconstrained tree lives: the lower right, a step past the seed. */
  const LOWER: KeepOut = { left: 0.62, top: 0.55, right: 0.95, bottom: 0.95 };

  test('nothing spawns behind the headline and the best node never sits there, through a restart', () => {
    for (const box of [HEADLINE, LOWER]) {
      const kept = new SearchTree({ seed: 417, aspect: ASPECT });
      kept.setKeepOut(box);
      const withBox = watch(kept, 45, box);

      expect(withBox.generation).toBeGreaterThanOrEqual(1);
      expect(withBox.spawned).toBeGreaterThan(150);
      expect(withBox.spawnedInside).toBe(0);
      expect(withBox.bestInside).toBe(0);
    }

    // The red direction: the same seed, unconstrained, grows through both
    // boxes and parks its frontier in the lower one.
    const throughHeadline = watch(new SearchTree({ seed: 417, aspect: ASPECT }), 45, HEADLINE);
    const throughLower = watch(new SearchTree({ seed: 417, aspect: ASPECT }), 45, LOWER);

    expect(throughHeadline.spawnedInside).toBeGreaterThan(5);
    expect(throughLower.spawnedInside).toBeGreaterThan(50);
    expect(throughLower.bestInside).toBeGreaterThan(100);
  });

  test('the box is a boundary, not a wall: the tree still grows past its right edge in the band', () => {
    const tree = new SearchTree({ seed: 417, aspect: ASPECT });
    tree.setKeepOut(HEADLINE);
    run(417, 14, tree);
    let pastIt = 0;

    for (const [, , , , x1, y1, , , , , alpha] of strokesOf(tree.frame())) {
      if ((alpha ?? 0) > 0.004 && (x1 ?? 0) > HEADLINE.right && (y1 ?? 0) < HEADLINE.bottom) pastIt += 1;
    }

    expect(pastIt).toBeGreaterThan(5);
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

describe('information flows along the tree', () => {
  interface PulseRow {
    readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number;
    readonly tail: number; readonly head: number; readonly tone: number; readonly alpha: number;
    readonly id: number; readonly layer: number; readonly direction: number;
  }

  function pulsesOf(frame: SearchTreeFrame): PulseRow[] {
    const rows: PulseRow[] = [];

    for (let index = 0; index < frame.pulseCount; index += 1) {
      const at = index * PULSE_STRIDE;
      const p = frame.pulses;
      rows.push({
        x0: p[at] ?? 0, y0: p[at + 1] ?? 0, x1: p[at + 4] ?? 0, y1: p[at + 5] ?? 0,
        tail: p[at + 6] ?? 0, head: p[at + 7] ?? 0, tone: p[at + 10] ?? 0, alpha: p[at + 11] ?? 0,
        id: p[at + 12] ?? 0, layer: p[at + 13] ?? 0, direction: p[at + 14] ?? 0,
      });
    }

    return rows;
  }

  test('pulses spawn deterministically from the seed', () => {
    const first = run(417, 20).frame();
    const second = run(417, 20).frame();

    expect(first.pulseCount).toBeGreaterThan(0);
    expect(pulsesOf(first)).toEqual(pulsesOf(second));
    expect(pulsesOf(run(418, 20).frame())).not.toEqual(pulsesOf(first));
  });

  test('a pulse moves one way along its edge, hands over at the edge\'s end, and rides only living branches', () => {
    const tree = new SearchTree({ seed: 417, aspect: ASPECT });
    run(417, 4, tree);
    let previous = new Map(pulsesOf(tree.frame()).map((row) => [row.id, row]));
    const edgesRidden = new Map<number, number>();
    let handovers = 0;
    let forward = new Set<number>();
    let back = new Set<number>();
    let brightestForward = 0;
    let brightestBack = 0;

    for (let index = 0; index < 60 * 36; index += 1) {
      tree.step(DT);
      const frame = tree.frame();
      const strokes = keyedStrokes(frame);
      const current = new Map(pulsesOf(frame).map((row) => [row.id, row]));

      for (const [id, row] of current) {
        // The pulse rides a stroke the frame draws, and never an ember or ash.
        const stroke = strokes.get(`${String(row.layer)}|${String(row.y0)}|${String(row.y1)}`);

        expect(stroke).toBeDefined();
        expect(stroke?.[9]).not.toBe(TONE_ASH);
        expect(stroke?.[9]).not.toBe(TONE_EMBER);
        expect(row.head).toBeGreaterThanOrEqual(0);
        expect(row.head).toBeLessThanOrEqual(1);
        expect(row.alpha).toBeLessThanOrEqual(0.85 + 1e-6);

        if (row.direction > 0) {
          forward = forward.add(id);
          brightestForward = Math.max(brightestForward, row.alpha);
          expect(row.tone).toBe(TONE_BRIGHT);
          expect(row.tail).toBeLessThanOrEqual(row.head);
          // Brighter than the branch it rides, at the head.
          expect(row.alpha).toBeGreaterThanOrEqual(stroke?.[10] ?? 1);
        } else {
          back = back.add(id);
          brightestBack = Math.max(brightestBack, row.alpha);
          expect(row.tone).not.toBe(TONE_BRIGHT);
          expect(row.tail).toBeGreaterThanOrEqual(row.head);
        }

        const before = previous.get(id);

        if (before === undefined) {
          edgesRidden.set(id, 1);
          continue;
        }

        const sameEdge = before.y0 === row.y0 && before.y1 === row.y1;

        if (sameEdge) {
          // Monotone along the edge, the way the pulse points.
          if (row.direction > 0) expect(row.head).toBeGreaterThanOrEqual(before.head);
          else expect(row.head).toBeLessThanOrEqual(before.head);
        } else {
          // The next edge begins where the last one ended: forward, a child; back, the parent.
          handovers += 1;
          edgesRidden.set(id, (edgesRidden.get(id) ?? 1) + 1);

          if (row.direction > 0) {
            expect(row.y0).toBe(before.y1);
            expect(Math.abs(row.x0 - before.x1)).toBeLessThan(0.01);
          } else {
            expect(row.y1).toBe(before.y0);
            expect(Math.abs(row.x1 - before.x0)).toBeLessThan(0.01);
          }
        }
      }

      previous = current;
    }

    expect(handovers).toBeGreaterThan(20);
    expect(Math.max(...edgesRidden.values())).toBeGreaterThanOrEqual(3);
    // Scores return rarer and dimmer than attempts go out.
    expect(back.size).toBeGreaterThan(0);
    expect(back.size * 3).toBeLessThan(forward.size);
    expect(brightestBack).toBeLessThan(brightestForward);
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
