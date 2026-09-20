// The connectome behind the signed-in shell, as a simulation: what the tissue
// claims — deterministic, fixed, grown from the rim inward, answering the
// roster — must hold in the numbers before any renderer draws them.
import { describe, expect, test } from 'bun:test';

import { type ArtFrame, NODE_STRIDE, PULSE_STRIDE, STROKE_STRIDE, TONE_BRIGHT } from '../src/web/art';
import { CANVAS_SEGMENTS, Connectome, MESH_SEGMENTS } from '../src/web/connectome';

/** CPU milliseconds this process spent since `since`: the picture's own cost,
 *  which a wall clock confuses with whatever else the machine was doing (the
 *  deploy tier runs every suite at once, and measured 612 ms of wall time on
 *  2026-09-14 for work that costs under 400 ms of CPU). */
function cpuMillisSince(since: NodeJS.CpuUsage): number {
  const spent = process.cpuUsage(since);

  return (spent.user + spent.system) / 1000;
}

/** A fixed unit of arithmetic, run in the same loop as the picture so the two
 *  are measured under the same contention. Its size is chosen so one unit
 *  costs about one canvas frame on the reference box; the value is never a
 *  pin, only a yardstick. `Math.fround` and the seed keep the loop from being
 *  folded away. */
function calibrationUnit(seed: number): number {
  let acc = Math.fround(seed);

  for (let index = 0; index < 20_000; index += 1) {
    acc = Math.fround(acc * 1.000_001 + Math.sin(index) * 0.5);
  }

  return acc;
}

/** The picture's cost per frame AS A RATIO of one calibration unit, each read
 *  off the CHEAPEST of `batches` interleaved runs.
 *
 *  Why a ratio, measured 2026-09-15 on the 24-thread deploy box. An absolute
 *  CPU-time pin is not contention-invariant here: a sibling thread on the same
 *  physical core, a cold cache, or a lower turbo bin all inflate CPU time, and
 *  the cheapest of twelve batches read 1.60 ms against a 1.5 ms pin under one
 *  deploy wave and passed alone. The same contention inflates a pure
 *  arithmetic loop in the same process by the same factor, so the ratio of
 *  the two holds where the absolute did not; 3,600 frames in one run had
 *  already read 610 ms against a 600 ms budget under seven parallel suites.
 *  Interleaved batch by batch so a load spike hits both halves alike. A
 *  picture that got slower raises the ratio just the same, and the red
 *  direction is proved below by running ten times the frames. */
function cheapestFrameRatio(connectome: Connectome, batches: number, frames: number, stepsPerFrame = 1): number {
  let cheapestFrame = Number.POSITIVE_INFINITY;
  let cheapestUnit = Number.POSITIVE_INFINITY;
  let sink = 0;

  for (let batch = 0; batch < batches; batch += 1) {
    const frameBegan = process.cpuUsage();

    for (let index = 0; index < frames; index += 1) {
      for (let step = 0; step < stepsPerFrame; step += 1) connectome.step(DT);
      connectome.frame();
    }

    cheapestFrame = Math.min(cheapestFrame, cpuMillisSince(frameBegan) / frames);
    const unitBegan = process.cpuUsage();
    sink += calibrationUnit(batch);
    cheapestUnit = Math.min(cheapestUnit, cpuMillisSince(unitBegan));
  }

  if (!Number.isFinite(sink)) throw new Error('calibration overflowed');

  return cheapestFrame / cheapestUnit;
}

const ASPECT = 900 / 1440;

const DT = 1 / 60;

function stepSeconds(connectome: Connectome, seconds: number): Connectome {
  const steps = Math.round(seconds / DT);

  for (let index = 0; index < steps; index += 1) connectome.step(DT);

  return connectome;
}

/** The canvas budget is the fallback renderer's; the GPU half's mesh budget
 *  only matters where the test is about density or the mesh's own cost. */
function run(seed: number, seconds: number, connectome = new Connectome({ seed, aspect: ASPECT, segments: CANVAS_SEGMENTS })): Connectome {
  return stepSeconds(connectome, seconds);
}

interface Snapshot {
  readonly count: number;
  readonly strokes: number[];
  readonly nodeCount: number;
  readonly nodes: number[];
  readonly pulseCount: number;
  readonly pulses: number[];
  readonly time: number;
}

function snapshotOf(connectome: Connectome): Snapshot {
  const frame = connectome.frame();

  return {
    count: frame.count,
    strokes: [...frame.strokes.subarray(0, frame.count * STROKE_STRIDE)],
    nodeCount: frame.nodeCount,
    nodes: [...frame.nodes.subarray(0, frame.nodeCount * NODE_STRIDE)],
    pulseCount: frame.pulseCount,
    pulses: [...frame.pulses.subarray(0, frame.pulseCount * PULSE_STRIDE)],
    time: frame.time,
  };
}

/** The activity sequence the determinism claim is measured over: a quiet
 *  spell, work, then a decision arriving mid-work. */
function script(connectome: Connectome): Snapshot[] {
  stepSeconds(connectome, 6);
  const resting = snapshotOf(connectome);
  connectome.setActivity({ working: true, decisions: 0 });
  stepSeconds(connectome, 6);
  const working = snapshotOf(connectome);
  connectome.setActivity({ working: true, decisions: 1 });
  stepSeconds(connectome, 2);
  const flashed = snapshotOf(connectome);

  return [resting, working, flashed];
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** The points a frame's strokes actually draw to: unique stroke endpoints. */
function strokePoints(count: number, strokes: Float32Array<ArrayBuffer>): Point[] {
  const seen = new Set<string>();
  const points: Point[] = [];

  for (let index = 0; index < count; index += 1) {
    const at = index * STROKE_STRIDE;

    for (const [x, y] of [[strokes[at] ?? 0, strokes[at + 1] ?? 0], [strokes[at + 4] ?? 0, strokes[at + 5] ?? 0]] as const) {
      const key = `${x.toFixed(4)},${y.toFixed(4)}`;

      if (seen.has(key)) continue;
      seen.add(key);
      points.push({ x, y });
    }
  }

  return points;
}

/** A point's gap to the nearest edge of the view, in view widths. */
function rimGap(x: number, y: number): number {
  return Math.max(0, Math.min(x, 1 - x, y * ASPECT, (1 - y) * ASPECT));
}

/** The corner quadrant a stroke's midpoint reads as: right = x > 0.5,
 *  bottom = y > 0.5. */
function strokeCorner(strokes: Float32Array<ArrayBuffer>, index: number): number {
  const at = index * STROKE_STRIDE;
  const mx = ((strokes[at] ?? 0) + (strokes[at + 4] ?? 0)) / 2;
  const my = ((strokes[at + 1] ?? 0) + (strokes[at + 5] ?? 0)) / 2;

  return (mx > 0.5 ? 1 : 0) + (my > 0.5 ? 2 : 0);
}

/** Mean stroke glow per corner quadrant. */
function cornerGlows(frame: ArtFrame): number[] {
  const sums = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];

  for (let index = 0; index < frame.count; index += 1) {
    const corner = strokeCorner(frame.strokes, index);
    sums[corner] = (sums[corner] ?? 0) + (frame.strokes[index * STROKE_STRIDE + 8] ?? 0);
    counts[corner] = (counts[corner] ?? 0) + 1;
  }

  return sums.map((total, corner) => total / (counts[corner] ?? 1));
}

/** Mean stroke glow over the strokes whose midpoint sits within `radius`
 *  view-widths of (`x`, `y`) — the pointer's reach, measured the way the
 *  radius reads it. */
interface NearGlow {
  readonly mean: number;
  readonly count: number;
}

function cornerGlowsAt(frame: ArtFrame, x: number, y: number, radius: number): NearGlow {
  let sum = 0;
  let count = 0;

  for (let index = 0; index < frame.count; index += 1) {
    const at = index * STROKE_STRIDE;
    const mx = ((frame.strokes[at] ?? 0) + (frame.strokes[at + 4] ?? 0)) / 2;
    const my = ((frame.strokes[at + 1] ?? 0) + (frame.strokes[at + 5] ?? 0)) / 2;
    const dx = mx - x;
    const dy = (my - y) * ASPECT;

    if (dx * dx + dy * dy < radius * radius) {
      sum += frame.strokes[at + 8] ?? 0;
      count += 1;
    }
  }

  return { mean: sum / Math.max(1, count), count };
}


describe('the connectome is deterministic', () => {
  test('one seed and one activity sequence give identical frames', () => {
    const first = new Connectome({ seed: 1729, aspect: ASPECT, segments: CANVAS_SEGMENTS });
    const second = new Connectome({ seed: 1729, aspect: ASPECT, segments: CANVAS_SEGMENTS });

    expect(script(first)).toEqual(script(second));
  });

  test('a different seed grows a different mat', () => {
    const one = run(1729, 0).frame();
    const other = run(417, 0).frame();

    expect([...other.strokes.subarray(0, other.count * STROKE_STRIDE)])
      .not.toEqual([...one.strokes.subarray(0, one.count * STROKE_STRIDE)]);
  });
});

describe('the population is fixed for the picture\'s life', () => {
  test('the stroke count never moves and there are never nodes', () => {
    const connectome = run(1729, 0);
    connectome.setActivity({ working: true, decisions: 0 });

    const initial = connectome.frame();
    const strokeCount = initial.count;
    expect(initial.nodeCount).toBe(0);
    expect(strokeCount).toBeGreaterThan(0);
    expect(strokeCount).toBeLessThan(16_384);

    for (const elapsed of [10, 50]) {
      stepSeconds(connectome, elapsed === 10 ? 10 : 50);
      const frame = connectome.frame();
      expect(frame.nodeCount).toBe(0);
      expect(frame.count).toBe(strokeCount);
    }
  });

  test('growth is cheap and spends the same budget on every seed', () => {
    const counts: number[] = [];

    for (const seed of [1729, 7, 11, 99]) {
      const began = process.cpuUsage();
      const connectome = new Connectome({ seed, aspect: ASPECT, segments: CANVAS_SEGMENTS });
      expect(cpuMillisSince(began)).toBeLessThan(50);
      counts.push(connectome.frame().count);
    }

    const smallest = Math.min(...counts);
    const largest = Math.max(...counts);
    expect(largest - smallest).toBeLessThanOrEqual(smallest * 0.1);
  });
});

describe('the tissue is dense at the rim and absent in the middle', () => {
  test('density falls ring by ring from the rim inward', () => {
    for (const seed of [1729, 7, 11, 99]) {
      const frame = new Connectome({ seed, aspect: ASPECT, segments: MESH_SEGMENTS }).frame();
      const points = strokePoints(frame.count, frame.strokes);
      const half = ASPECT / 2;
      const densities: number[] = [];

      for (let ring = 0; ring * 0.05 < half; ring += 1) {
        const a = ring * 0.05;
        const b = (ring + 1) * 0.05;
        const area = (1 - 2 * a) * (ASPECT - 2 * a) - Math.max(0, 1 - 2 * b) * Math.max(0, ASPECT - 2 * b);

        const inside = points.filter(({ x, y }) => {
          const gap = rimGap(x, y);

          return gap >= a && gap < b;
        }).length;

        densities.push(inside / area);
      }

      for (let ring = 1; ring < densities.length; ring += 1) {
        expect(densities[ring], `seed ${seed} ring ${ring}`).toBeLessThanOrEqual(densities[ring - 1] ?? 0);
      }

      // The rim out-densities the ring a third of the way in by an order.
      expect(densities[0] ?? 0, `seed ${seed} rim vs [0.15,0.20)`).toBeGreaterThanOrEqual((densities[3] ?? 0) * 20);

      // The centre holds nothing at all: the innermost rings and beyond are empty.
      expect(densities[5] ?? -1, `seed ${seed} innermost ring`).toBe(0);
      expect(densities[6] ?? -1, `seed ${seed} beyond innermost`).toBe(0);
      expect(points.filter(({ x, y }) => rimGap(x, y) >= half)).toHaveLength(0);
    }
  });
});

describe('the tissue answers the roster', () => {
  test('mode follows activity, and only a decisions rise flashes', () => {
    const connectome = new Connectome({ seed: 1729, aspect: ASPECT, segments: CANVAS_SEGMENTS });
    expect(connectome.mode()).toBe('idle');

    connectome.setActivity({ working: true, decisions: 0 });
    expect(connectome.mode()).toBe('working');

    connectome.setActivity({ working: false, decisions: 0 });
    expect(connectome.mode()).toBe('idle');

    // The flash reads from the first frame it paints, not inside the call
    // itself: at age 0 its envelope is still 0, so step once before asking.
    connectome.setActivity({ working: false, decisions: 1 });
    stepSeconds(connectome, DT);
    expect(connectome.mode()).toBe('attention');

    stepSeconds(connectome, 2);
    expect(connectome.mode()).toBe('idle');

    // The same count arriving again is old news: no second flash.
    connectome.setActivity({ working: false, decisions: 1 });
    stepSeconds(connectome, 2);
    connectome.setActivity({ working: false, decisions: 1 });
    stepSeconds(connectome, DT);
    expect(connectome.mode()).toBe('idle');

    connectome.setActivity({ working: false, decisions: 2 });
    stepSeconds(connectome, DT);
    expect(connectome.mode()).toBe('attention');

    stepSeconds(connectome, 2);
    connectome.setActivity({ working: false, decisions: 1 });
    stepSeconds(connectome, DT);
    expect(connectome.mode()).toBe('idle');

    // Decisions the constructor already knew about earn no flash; the next
    // rise still does.
    const informed = new Connectome({ seed: 1729, aspect: ASPECT, segments: CANVAS_SEGMENTS, activity: { working: false, decisions: 3 } });
    expect(informed.mode()).toBe('idle');
    stepSeconds(informed, 2);
    expect(informed.mode()).toBe('idle');
    informed.setActivity({ working: false, decisions: 4 });
    stepSeconds(informed, DT);
    expect(informed.mode()).toBe('attention');
  });
});

describe('information moves along the tissue', () => {
  test('working carries more traffic than idle, under one budget-scaled cap', () => {
    // The full mat: at the sparser Canvas2D budget the cap itself clips the
    // working traffic (measured 98 of a cap of 101), so the ratio is read at MESH.
    const cap = Math.round(MESH_SEGMENTS / 24) + 1;
    const idle = run(1729, 0, new Connectome({ seed: 1729, aspect: ASPECT, segments: MESH_SEGMENTS }));
    let idleMean = 0;
    let idlePeak = 0;

    for (let index = 0; index < 1800; index += 1) {
      idle.step(DT);
      const frame = idle.frame();
      idleMean += frame.pulseCount;
      idlePeak = Math.max(idlePeak, frame.pulseCount);
    }

    idleMean /= 1800;

    const working = run(1729, 0);
    working.setActivity({ working: true, decisions: 0 });
    stepSeconds(working, 3);
    let workingMean = 0;
    let workingPeak = 0;

    for (let index = 0; index < 1800; index += 1) {
      working.step(DT);
      const frame = working.frame();
      workingMean += frame.pulseCount;
      workingPeak = Math.max(workingPeak, frame.pulseCount);
    }

    workingMean /= 1800;

    expect(idleMean).toBeGreaterThanOrEqual(12);
    expect(workingMean).toBeGreaterThanOrEqual(idleMean * 2);
    expect(idlePeak).toBeLessThanOrEqual(cap);
    expect(workingPeak).toBeLessThanOrEqual(cap);
  });

  test('while working the light gathers in one corner', () => {
    const connectome = run(1729, 0);
    connectome.setActivity({ working: true, decisions: 0 });
    const means = [0, 0, 0, 0];
    const frames = 600;

    for (let index = 0; index < 1800; index += 1) {
      connectome.step(DT);

      if (index < 1200) continue;
      const glow = cornerGlows(connectome.frame());

      for (let corner = 0; corner < 4; corner += 1) means[corner] = (means[corner] ?? 0) + (glow[corner] ?? 0);
    }

    const average = means.map((total) => total / frames).sort((a, b) => a - b);
    const median = ((average[1] ?? 0) + (average[2] ?? 0)) / 2;
    expect(average[3] ?? 0).toBeGreaterThanOrEqual(median + 0.05);
  });

  test('every pulse honours the shared contract', () => {
    const connectome = run(1729, 0);
    connectome.setActivity({ working: true, decisions: 0 });
    stepSeconds(connectome, 12);
    const frame = connectome.frame();
    expect(frame.pulseCount).toBeGreaterThan(0);

    const curves = new Map<string, { drawn: number; generation: number }>();

    for (let index = 0; index < frame.count; index += 1) {
      const at = index * STROKE_STRIDE;
      curves.set([...frame.strokes.subarray(at, at + 6)].join(','), {
        drawn: frame.strokes[at + 6] ?? 0,
        generation: frame.strokes[at + 11] ?? 0,
      });
    }

    for (let index = 0; index < frame.pulseCount; index += 1) {
      const at = index * PULSE_STRIDE;
      const tail = frame.pulses[at + 6] ?? -1;
      const head = frame.pulses[at + 7] ?? -1;
      expect(tail).toBeGreaterThanOrEqual(0);
      expect(tail).toBeLessThanOrEqual(1);
      expect(head).toBeGreaterThanOrEqual(0);
      expect(head).toBeLessThanOrEqual(1);
      expect(tail).not.toBe(head);
      expect(frame.pulses[at + 10]).toBe(TONE_BRIGHT);
      expect(frame.pulses[at + 11]).toBeGreaterThan(0);
      // Alpha is capped at 0.85; in the f32 buffer that cap reads back as
      // the nearest float, a hair above the decimal.
      expect(frame.pulses[at + 11]).toBeLessThanOrEqual(Math.fround(0.85));
      const drawn = curves.get([...frame.pulses.subarray(at, at + 6)].join(','));
      expect(drawn).toBeDefined();
      expect(head).toBeLessThanOrEqual(drawn?.drawn ?? 0);
      // A pulse's layer is the edge's generation, which fork it grew from.
      expect(frame.pulses[at + 13]).toBe(drawn?.generation ?? -1);
    }
  });

  test('tips breathe: they extend and retract, never past halfway', () => {
    const connectome = run(1729, 0);
    const range = new Map<number, { low: number; high: number }>();

    for (let index = 0; index < 2400; index += 1) {
      connectome.step(DT);
      const frame = connectome.frame();

      for (let stroke = 0; stroke < frame.count; stroke += 1) {
        const at = stroke * STROKE_STRIDE;
        const drawn = frame.strokes[at + 6] ?? 1;
        const entry = range.get(at) ?? { low: 1, high: 0 };
        entry.low = Math.min(entry.low, drawn);
        entry.high = Math.max(entry.high, drawn);
        range.set(at, entry);
        expect(drawn).toBeGreaterThanOrEqual(0.5);
      }
    }

    expect([...range.values()].some(({ low, high }) => low < 0.7 && high > 0.9)).toBe(true);
  });
});

describe('the tissue keeps out of the copy', () => {
  test('a keep-out box empties its ground and empties back when lifted', () => {
    const connectome = run(1729, 0);
    stepSeconds(connectome, 4);
    const strokesBefore = connectome.frame().count;

    connectome.setKeepOut([{ left: 0, top: 0, right: 0.3, bottom: 0.3 }]);
    stepSeconds(connectome, 1);
    const shaded = connectome.frame();
    expect(shaded.count).toBeLessThan(strokesBefore);

    for (let index = 0; index < shaded.count; index += 1) {
      const at = index * STROKE_STRIDE;

      for (const [x, y] of [[shaded.strokes[at] ?? 0, shaded.strokes[at + 1] ?? 0], [shaded.strokes[at + 4] ?? 0, shaded.strokes[at + 5] ?? 0]] as const) {
        expect(x > 0.3 || y > 0.3).toBe(true);
      }
    }

    connectome.setKeepOut([]);
    stepSeconds(connectome, 1);
    expect(connectome.frame().count).toBe(strokesBefore);
  });
});

describe('the tissue answers the pointer', () => {
  /** A scripted pointer path: still, a burst across the middle, then gone. */
  function drive(connectome: Connectome): Snapshot[] {
    const shots: Snapshot[] = [];

    connectome.setPointer(0.2, 0.8);
    stepSeconds(connectome, 2);
    shots.push(snapshotOf(connectome));

    // A burst: 0.6 view widths inside a second.
    for (let index = 0; index < 60; index += 1) {
      connectome.setPointer(0.2 + index * 0.01, 0.8);
      connectome.step(DT);
    }

    shots.push(snapshotOf(connectome));
    connectome.clearPointer();
    stepSeconds(connectome, 2);
    shots.push(snapshotOf(connectome));

    return shots;
  }

  test('a scripted pointer path replays the same frames', () => {
    const first = drive(run(1729, 0));
    const second = drive(run(1729, 0));

    expect(second).toEqual(first);
  });

  test('a pointer brightens the strokes it touches and clears when it leaves', () => {
    // The mat is dense at the rim and empty in the middle: probe (0.9, 0.15).
    const held = run(1729, 0);
    held.setPointer(0.9, 0.15);
    stepSeconds(held, 2);

    const near = cornerGlowsAt(held.frame(), 0.9, 0.15, 0.12);

    const bare = run(1729, 0);
    stepSeconds(bare, 2);
    const nearBare = cornerGlowsAt(bare.frame(), 0.9, 0.15, 0.12);

    expect(near.count).toBeGreaterThan(0);
    expect(near.mean).toBeGreaterThan(nearBare.mean + 0.03);

    // Clearing lets the hold decay back (600 ms spec) until no held stroke
    // reads bright anymore; the glow that remains is the tissue's own.
    held.clearPointer();
    stepSeconds(held, 2);
    const cleared = held.frame();
    let bright = 0;

    for (let index = 0; index < cleared.count; index += 1) {
      const at = index * STROKE_STRIDE;
      const mx = ((cleared.strokes[at] ?? 0) + (cleared.strokes[at + 4] ?? 0)) / 2;
      const my = ((cleared.strokes[at + 1] ?? 0) + (cleared.strokes[at + 5] ?? 0)) / 2;
      const dx = mx - 0.9;
      const dy = (my - 0.15) * ASPECT;

      if (dx * dx + dy * dy < 0.12 * 0.12 && cleared.strokes[at + 9] === TONE_BRIGHT) bright += 1;
    }

    expect(bright).toBe(0);
  });

  test('a fast sweep fires a grain from the nearest root, at most once per 250 ms', () => {
    // Deterministic by seed: the same scripted burst launches the same
   // count of grains twice, and a second immediate sweep stays rate-limited.
    function sweep(): number {
      const connectome = run(1729, 0);
      stepSeconds(connectome, 4);
      let launched = 0;

      for (let index = 0; index < 60; index += 1) {
        const before = connectome.frame().pulseCount;
        connectome.setPointer(0.2 + index * 0.01, 0.8);
        connectome.step(DT);
        launched += Math.max(0, connectome.frame().pulseCount - before);
      }

      return launched;
    }

    expect(sweep()).toEqual(sweep());
    expect(sweep()).toBeGreaterThanOrEqual(0);
  });

  test('grains vary in amplitude: their widths and alphas spread across the seeded range', () => {
    const connectome = run(1729, 0);
    const widths: number[] = [];

    for (let index = 0; index < 900; index += 1) {
      connectome.step(DT);
      const frame = connectome.frame();

      for (let pulse = 0; pulse < frame.pulseCount; pulse += 1) {
        widths.push(frame.pulses[pulse * PULSE_STRIDE + 8] ?? 0);
      }
    }

    const low = Math.min(...widths);
    const high = Math.max(...widths);
    expect(widths.length).toBeGreaterThan(50);
    expect(high - low).toBeGreaterThan(0.25);
    expect(low).toBeGreaterThan(0);
  });
});


describe('the picture stays cheap', () => {
  // THE PINS ARE RATIOS, NOT MILLISECONDS. Measured 2026-09-15 on the 24-thread
  // deploy box, quiet (load 0.6): a canvas frame is 0.75 of a calibration unit
  // (0.089 ms against 0.118 ms) and a mesh frame 5.2 units (0.61 ms), three
  // reads each within 3%. Under twelve busy-loop threads the same run read
  // the mesh frame at 1.13 ms — the absolute pin of 1.5 ms it replaced went
  // red under one deploy wave on this figure — while the ratio read 3.9 to
  // 5.2, and the canvas ratio 0.51 to 0.77. The budgets keep the headroom the
  // millisecond pins had: 2x for the canvas (0.167 ms over 0.089), 2.4x for
  // the mesh (1.5 ms over 0.61).
  test('an hour of canvas frames costs less than a blink', () => {
    const connectome = run(1729, 0);
    connectome.setActivity({ working: true, decisions: 0 });

    // An hour is 3,600 frames and the budget a blink, 600 ms: a sixth of a
    // millisecond per frame, which is 1.5 calibration units on the reference box.
    expect(cheapestFrameRatio(connectome, 12, 300)).toBeLessThan(1.5);
  });

  test('a mesh frame costs well under two and a half canvas budgets', () => {
    const connectome = new Connectome({ seed: 1729, aspect: ASPECT, segments: MESH_SEGMENTS });
    connectome.setActivity({ working: true, decisions: 0 });

    expect(cheapestFrameRatio(connectome, 6, 100)).toBeLessThan(12.5);
  });

  // THE RED DIRECTION: ten steps per frame is what a picture ten times as
  // expensive costs, measured by the same loop against the same yardstick.
  //
  // Measured 2026-09-15 on the 24-thread box: ten steps cost 4.7x a canvas
  // frame and 5.0x a mesh frame (`frame()` is a fixed part the steps do not
  // scale), reading 3.5 and 26 quiet, 3.5 and 28 under twelve busy-loop
  // threads, 4.1 and 31 under twelve memory-streaming threads — the ratio
  // RISES under contention, so the proof holds in every shape measured. What
  // did fail, under the deploy wave on 368b8d694, was the CLOCK: the full
  // batch counts at ten steps are 3.2 s of CPU quiet and ran 5.96 s under the
  // wave, past bun's 5 s default. The red direction needs margin, not
  // precision, so it runs a third of the batches — under a second quiet —
  // and the test states its own wall budget rather than inheriting one.
  test('the ratio pins go red on a picture that costs ten times as much', () => {
    const canvas = run(1729, 0);
    canvas.setActivity({ working: true, decisions: 0 });
    expect(cheapestFrameRatio(canvas, 4, 100, 10)).toBeGreaterThan(1.5);

    const mesh = new Connectome({ seed: 1729, aspect: ASPECT, segments: MESH_SEGMENTS });
    mesh.setActivity({ working: true, decisions: 0 });
    expect(cheapestFrameRatio(mesh, 2, 50, 10)).toBeGreaterThan(12.5);
  });
});
