// The Canvas2D renderer keeps a picture's resting strokes on a second surface and draws them again only when they change.
import { describe, expect, test } from 'bun:test';

import { type ArtFrame, type ArtPalette, DEFAULT_LIFT, STROKE_STRIDE } from '../src/web/art';
import { createCanvasRenderer, type StrokeSurface } from '../src/web/hero-canvas';

const PALETTE: ArtPalette = { mode: 'dark', accent: [224, 164, 88], bright: [255, 230, 190], ash: [120, 120, 120], ground: [20, 20, 20] };

/** Counts the curves a surface is asked to trace. */
function surface(): StrokeSurface & { curves: number } {
  const gradient: CanvasGradient = { addColorStop: () => {} };

  const counted: StrokeSurface & { curves: number } = {
    curves: 0, lineWidth: 1, lineCap: 'butt', strokeStyle: '', fillStyle: '', globalAlpha: 1,
    setTransform: () => {}, clearRect: () => {}, beginPath: () => {}, moveTo: () => {}, arc: () => {}, stroke: () => {}, fill: () => {},
    quadraticCurveTo: () => { counted.curves += 1; },
    createLinearGradient: () => gradient,
  };

  return counted;
}

/** `count` faint strokes, the first `rest` of them the picture at rest. */
function frame(count: number, rest: { count: number; epoch: number }, lift = DEFAULT_LIFT): ArtFrame {
  const strokes = new Float32Array(new ArrayBuffer(4 * STROKE_STRIDE * count));

  for (let index = 0; index < count; index += 1) {
    strokes.set([0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 1, 1, 0.2, 0, 0.3, 0], index * STROKE_STRIDE);
  }

  return { strokes, count, nodes: new Float32Array(0), nodeCount: 0, pulses: new Float32Array(0), pulseCount: 0, time: 0, rest, lift };
}

describe('the canvas renderer keeps the rest', () => {
  test('resting strokes are traced once per rest epoch and lift, the moving ones every frame', () => {
    const main = surface();
    const kept = surface();
    let stamps = 0;
    const renderer = createCanvasRenderer(main, PALETTE, { surface: kept, resize: () => {}, stamp: () => { stamps += 1; } });

    renderer.resize(100, 100, 1);

    for (let tick = 0; tick < 5; tick += 1) renderer.render(frame(10, { count: 8, epoch: 1 }));
    expect({ kept: kept.curves, main: main.curves, stamps }).toEqual({ kept: 8, main: 10, stamps: 5 });

    renderer.render(frame(10, { count: 8, epoch: 2 }));
    expect(kept.curves).toBe(16);

    renderer.render(frame(10, { count: 8, epoch: 2 }, { dark: 0.5, light: 1 }));
    expect(kept.curves).toBe(24);
  });
});
