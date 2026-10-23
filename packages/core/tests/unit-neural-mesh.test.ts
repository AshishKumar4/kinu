// The neural mesh behind Home: a frame of tissue at the page's edges, wired cell to cell, whose signals cascade.
import { describe, expect, test } from 'bun:test';

import { STROKE_STRIDE } from '../src/web/art';
import { NeuralMesh } from '../src/web/neural-mesh';

const WIDTH = 1440;

const HEIGHT = 900;

const ASPECT = HEIGHT / WIDTH;

const RAIL = 240;

const DT = 1 / 60;

const mesh = (field = { left: RAIL / WIDTH, right: 1 }): NeuralMesh => new NeuralMesh({ seed: 1729, aspect: ASPECT, width: WIDTH, field });

function stepSeconds(picture: NeuralMesh, seconds: number): NeuralMesh {
  for (let index = 0; index < Math.round(seconds / DT); index += 1) picture.step(DT);

  return picture;
}

describe('the mesh frames the page', () => {
  test('solid at the edges beside the rail, thinning across the outer third, bare in the middle', () => {
    const cells = mesh().census();
    const band = 0.32 * HEIGHT;
    const fromEdge = ({ x, y }: { x: number; y: number }): number => Math.min(x * WIDTH - RAIL, WIDTH - x * WIDTH, y * HEIGHT, HEIGHT - y * HEIGHT);
    const middle = cells.filter((cell) => Math.abs(cell.x * WIDTH - (RAIL + WIDTH) / 2) < (WIDTH - RAIL) * 0.2 && Math.abs(cell.y - 0.5) < 0.2);
    const outer = cells.filter((cell) => fromEdge(cell) < band / 3).length;
    const inner = cells.filter((cell) => fromEdge(cell) >= band / 3 && fromEdge(cell) < band).length;

    expect(cells.length).toBeGreaterThan(1000);
    expect(cells.filter((cell) => fromEdge(cell) < band).length / cells.length).toBeGreaterThan(0.97);
    // Thinning, not a ring: the outer third of the band holds more than the inner two thirds, and those are not empty.
    expect(outer).toBeGreaterThan(inner);
    expect(inner / cells.length).toBeGreaterThan(0.2);
    expect(middle).toEqual([]);
    expect(cells.every((cell) => cell.x * WIDTH > RAIL - 12)).toBe(true);
  });

  test('a folded rail grows the tissue again over the wider page, as a fresh mesh of that field would', () => {
    const picture = mesh();
    const folded = { left: 56 / WIDTH, right: 1 };

    picture.setField(folded);
    expect(picture.census().some((cell) => cell.x * WIDTH < RAIL - 12)).toBe(true);
    expect(picture.census()).toEqual(mesh(folded).census());
  });

  test('every cell is wired into the mesh, and no axon runs straight back to the cell that reaches it', () => {
    const cells = mesh().census();
    const reaches = new Set(cells.flatMap((cell, index) => cell.targets.map((target) => `${String(index)}>${String(target)}`)));

    expect(cells.filter((cell) => cell.targets.length === 0).length).toBeLessThanOrEqual(2);
    expect([...reaches].filter((edge) => reaches.has(edge.split('>').reverse().join('>')))).toEqual([]);
  });

  test('a keep-out box empties its ground of strokes, and fills back when lifted', () => {
    const picture = stepSeconds(mesh(), 1);
    const before = picture.frame().rest?.count ?? 0;

    picture.setKeepOut([{ left: 0.6, top: 0, right: 1, bottom: 0.4 }]);
    const shaded = picture.frame();
    const rest = shaded.rest?.count ?? 0;

    expect(rest).toBeLessThan(before);

    for (let index = 0; index < rest; index += 1) {
      const at = index * STROKE_STRIDE;

      for (const [x, y] of [[shaded.strokes[at] ?? 0, shaded.strokes[at + 1] ?? 0], [shaded.strokes[at + 4] ?? 0, shaded.strokes[at + 5] ?? 0]] as const) {
        expect(x < 0.6 || y > 0.4 || x > 1 || y < 0).toBe(true);
      }
    }

    picture.setKeepOut([]);
    expect(picture.frame().rest?.count).toBe(before);
  });
});

describe('the mesh answers the roster', () => {
  test('mode follows activity, and only a rise in decisions earns attention, for a moment', () => {
    const picture = mesh();

    expect(picture.mode()).toBe('idle');
    picture.setActivity({ working: true, decisions: 0 });
    expect(picture.mode()).toBe('working');
    picture.setActivity({ working: false, decisions: 0 });
    expect(picture.mode()).toBe('idle');

    // At age 0 the attention envelope is still 0, so step once before asking.
    picture.setActivity({ working: false, decisions: 1 });
    stepSeconds(picture, DT);
    expect(picture.mode()).toBe('attention');
    stepSeconds(picture, 2);
    expect(picture.mode()).toBe('idle');

    picture.setActivity({ working: true, decisions: 1 });
    stepSeconds(picture, DT);
    expect(picture.mode()).toBe('working');
    picture.setActivity({ working: true, decisions: 2 });
    stepSeconds(picture, DT);
    expect(picture.mode()).toBe('attention');
    stepSeconds(picture, 2);
    expect(picture.mode()).toBe('working');

    const informed = new NeuralMesh({ seed: 1729, aspect: ASPECT, width: WIDTH, activity: { working: false, decisions: 3 } });

    stepSeconds(informed, 2);
    expect(informed.mode()).toBe('idle');
    informed.setActivity({ working: false, decisions: 4 });
    stepSeconds(informed, DT);
    expect(informed.mode()).toBe('attention');
  });

  // 2026-10-23: the owner never asked for motion at rest, and a field that fires on its own costs a renderer every frame.
  test('it never fires on its own: at rest or while agents work it settles, and what wakes it dies out', () => {
    for (const working of [false, true]) {
      const picture = mesh();

      picture.setActivity({ working, decisions: 0 });
      stepSeconds(picture, 60);
      expect(picture.frame().nodeCount).toBe(0);
      expect(picture.settled()).toBe(true);
    }

    const decided = mesh();

    decided.setActivity({ working: true, decisions: 1 });
    stepSeconds(decided, 0.5);
    expect(decided.settled()).toBe(false);
    stepSeconds(decided, 30);
    expect(decided.settled()).toBe(true);

    const pointed = mesh();

    pointed.setPointer(0.95, 0.05);
    stepSeconds(pointed, 0.5);
    expect(pointed.settled()).toBe(false);
    stepSeconds(pointed, 30);
    expect(pointed.settled()).toBe(true);
  });

  test('a press fires the nearest cell, and the pointer charges the cells beneath it', () => {
    const picture = mesh();

    picture.click(0.2, 0.05);
    expect(picture.frame().nodeCount).toBeGreaterThan(0);

    const held = mesh();

    held.setPointer(0.95, 0.05);
    stepSeconds(held, 0.5);
    expect(held.pointerHold()).toBeGreaterThan(0.5);
    expect(held.frame().nodeCount).toBeGreaterThan(0);
    held.clearPointer();
    stepSeconds(held, 1);
    expect(held.pointerHold()).toBe(0);
  });
});

describe('the mesh is drawn cheaply and quietly', () => {
  test('the resting tissue a renderer keeps changes only when the rest epoch moves', () => {
    const picture = mesh();
    const kept = { epoch: -1, strokes: new Float32Array(new ArrayBuffer(0)) };
    let redrawn = 0;

    picture.setActivity({ working: true, decisions: 0 });

    for (let tick = 0; tick < 1200; tick += 1) {
      if (tick % 300 === 0) picture.click(0.2, 0.05);
      picture.setPointer(0.2 + 0.6 * ((tick % 400) / 400), 0.04);
      picture.step(DT);
      const frame = picture.frame();
      const rest = frame.rest;

      expect(rest).toBeDefined();

      if (rest === undefined) return;
      const prefix = frame.strokes.slice(0, rest.count * STROKE_STRIDE);

      if (kept.epoch === rest.epoch) expect(prefix).toEqual(kept.strokes);
      else redrawn += 1;
      kept.epoch = rest.epoch;
      kept.strokes = prefix;
    }

    // Lit cells draw over the rest, so the rest itself is drawn once, not every frame.
    expect(redrawn).toBe(1);
  });

  test('it ships at 0.2 of its ink, and its opacity scales the ink on either ground, one object a renderer can keep', () => {
    const quiet = mesh().frame();
    const quieter = new NeuralMesh({ seed: 1729, aspect: ASPECT, width: WIDTH, opacity: 0.1 }).frame();

    expect(quiet.lift?.dark).toBeCloseTo(0.2);
    expect(quieter.lift?.dark).toBeCloseTo(0.1);
    expect((quieter.lift?.light ?? 0) / (quieter.lift?.dark ?? 1)).toBeCloseTo((quiet.lift?.light ?? 0) / (quiet.lift?.dark ?? 1));
    expect(mesh().frame().lift).not.toBe(quiet.lift);

    const picture = mesh();

    expect(picture.frame().lift).toBe(picture.frame().lift);
  });

  test('a glint fades more slowly than the tissue, so firing still reads as light on the faintest mesh', () => {
    const glint = (opacity: number) => {
      const picture = new NeuralMesh({ seed: 1729, aspect: ASPECT, width: WIDTH, field: { left: RAIL / WIDTH, right: 1 }, opacity });

      picture.click(0.2, 0.05);
      const frame = picture.frame();

      // A node's alpha is its sixth float.
      return { disc: frame.nodes[5] ?? 0, lift: frame.lift?.dark ?? 0 };
    };

    const faint = glint(0.2);
    const fainter = glint(0.05);

    expect(fainter.lift / faint.lift).toBeCloseTo(0.25);
    expect(fainter.disc / faint.disc).toBeCloseTo(0.5);
  });
});
